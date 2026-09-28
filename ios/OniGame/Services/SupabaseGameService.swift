// オンライン対戦（Supabase）の GameService
//
// 判定はすべてサーバー（Edge Functions）が行い、この端末は「要求」と「表示」だけを行う。
//   - 要求: 呼び出し型の Edge Function（create-room / join-room / leave-room / configure-game /
//           start-game / request-capture / claim-arrival / change-destination / abort-game /
//           prepare-rematch / report-location）
//   - 表示: 自分が読める行（RLS で決まる）を定期的に取り直す
//
// Firebase 版はリアルタイム購読（onValue）でしたが、この Postgres 版は「一定間隔で読み直す」方式にしています。
// ゲーム画面はもともと 0.25秒ごとに tick() を呼ぶ作りなので、その仕組みをそのまま流用しています
// （ロビーなど tick() が呼ばれない画面のためだけに、別の緩やかなポーリングも内部で行っています）。

import Foundation
import Observation
import OniGameCore
import Supabase

@MainActor
@Observable
final class SupabaseGameService: GameService {
    let mode = BackendMode.online

    private(set) var uid: String?
    private(set) var roomId: String?
    private var meta: RoomMeta?
    private var members: [Member] = []
    private var online: [String: Bool] = [:]
    private var pub: PublicChannel?
    private var hunterPositions: [String: LatLng]?
    private var runnerPositions: [String: LatLng]?
    private var possibleAreas: [String: AreaDisplay]?
    private var ownView: OwnChannel?
    private var resultPublic: ResultSummary?
    private var resultPersonal: PersonalSummary?
    private var closed = false
    private var ownPosition: OwnPosition?

    @ObservationIgnored private let client: SupabaseClient
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var lastSent: (at: Date, pos: LatLng)?
    @ObservationIgnored private var lastClaimAt: Date?
    @ObservationIgnored private var lastPollAt: Date?
    @ObservationIgnored private var signIn: Task<String, Error>?

    /// 位置の送信の間引き（5秒おき、または10m以上動いたとき）
    static let sendIntervalSec = 5.0
    static let sendMinDistanceM = 10.0
    /// 表示の読み直しの間引き（tick() は0.25秒ごとに呼ばれるが、実際に読み直すのはこの間隔）
    static let pollIntervalSec = 1.2

    struct RoomMeta: Equatable, Decodable {
        var id: String
        var hostUid: String
        var joinCode: String
        var phase: String?

        enum CodingKeys: String, CodingKey { case id, hostUid = "host_uid", joinCode = "join_code", phase }
    }

    struct Member: Equatable, Decodable {
        var uid: String
        var name: String
    }

    init(config: AppConfig) {
        let (url, key): (URL, String)
        switch config.supabaseMode {
        case .production:
            guard let urlString = config.supabaseUrl, let parsed = URL(string: urlString), let anonKey = config.supabaseAnonKey else {
                fatalError("OniSupabaseUrl / OniSupabaseAnonKey が設定されていません（project.yml の info を確認してください）")
            }
            (url, key) = (parsed, anonKey)
        case .emulator:
            (url, key) = (config.emulatorApiURL, AppConfig.emulatorAnonKey)
        }
        client = SupabaseClient(supabaseURL: url, supabaseKey: key)
        signIn = Task { try await Self.ensureSignedIn(client) }
    }

    /// ログイン済みならその uid、まだなら匿名ログインして uid を返す
    private static func ensureSignedIn(_ client: SupabaseClient) async throws -> String {
        if let user = client.auth.currentUser { return user.id.uuidString }
        let session = try await client.auth.signInAnonymously()
        return session.user.id.uuidString
    }

    private func requireUid() async throws -> String {
        if let uid { return uid }
        guard let task = signIn else { throw GameError.precondition("ログインできませんでした") }
        do {
            let id = try await task.value
            uid = id
            return id
        } catch {
            signIn = Task { try await Self.ensureSignedIn(client) } // 次の操作でもう一度試す
            throw GameError.precondition("ログインできませんでした（\(AppModel.message(for: error))）")
        }
    }

    // MARK: 読み取り

    var session: Session {
        guard let meta else { return closed ? Session.empty.with(closed: true) : .empty }
        let list = members.sorted { $0.name < $1.name }.map { m in
            LobbyPlayer(id: m.uid, name: m.name, isHost: m.uid == meta.hostUid, isDummy: false, online: online[m.uid] == true)
        }
        return Session(
            phase: pub?.phase ?? meta.phase.flatMap(GamePhase.init(rawValue:)),
            roomCode: meta.joinCode,
            selfId: uid,
            isHost: uid == meta.hostUid, // サーバーが決めた host_uid で判定（自分で名乗らない）
            settings: pub?.settings ?? .default,
            area: pub?.area,
            exclusionZones: pub?.exclusionZones ?? [],
            players: list,
            hasResult: resultPublic != nil,
            closed: closed
        )
    }

    func now() -> Millis { nowMillis() } // Postgres の時計とのずれは小さい想定（表示だけに使う）

    func view(viewerId: String?, now: Millis) -> PlayerView? {
        guard let uid, let pub else { return nil }
        let parts = ReadableChannels(public: pub, hunterPositions: hunterPositions, runnerPositions: runnerPositions,
                                     possibleAreas: possibleAreas, view: ownView)
        return ViewChannels.assemble(parts, uid: uid, now: now, ownPosition: ownPosition)
    }

    func resultView(viewerId: String?) -> ResultView? {
        guard let uid, var summary = resultPublic else { return nil }
        summary.personal = nil
        return ResultView(summary: summary, you: uid, own: resultPersonal)
    }

    // MARK: 呼び出し型 Edge Function

    struct Empty: Decodable {}

    private func call<Response: Decodable>(_ name: String, _ payload: some Encodable) async throws -> Response {
        do {
            return try await client.functions.invoke(name, options: .init(body: payload))
        } catch {
            throw GameError.precondition(Self.message(for: error))
        }
    }

    /// FunctionsError（サーバーが返した { error: { message } }）から日本語のメッセージを取り出す
    private static func message(for error: Error) -> String {
        if let functionsError = error as? FunctionsError, case let .httpError(_, data) = functionsError,
           let body = try? JSONDecoder().decode(ErrorBody.self, from: data) {
            return body.error.message
        }
        return AppModel.message(for: error)
    }

    private struct ErrorBody: Decodable { struct E: Decodable { var code: String; var message: String }; var error: E }

    // MARK: ルーム

    struct CreateRoomPayload: Encodable {
        var name: String
        var settings: GameSettings
        var startPoint: LatLng?
        var exclusionZones: [[String: [String: Double]]]
    }
    private struct RoomResult: Decodable { var roomId: String; var joinCode: String; var hostUid: String }

    private static func zonesPayload(_ zones: [LatLng]) -> [[String: [String: Double]]] {
        zones.map { ["center": ["lat": $0.lat, "lng": $0.lng]] }
    }

    func createRoom(hostName: String, draft: GameDraft) async throws {
        _ = try await requireUid()
        let payload = CreateRoomPayload(name: hostName, settings: draft.settings, startPoint: draft.startPoint,
                                        exclusionZones: Self.zonesPayload(draft.exclusionZones))
        let result: RoomResult = try await call("create-room", payload)
        try await attach(roomId: result.roomId)
    }

    struct JoinRoomPayload: Encodable { var code: String; var name: String }

    func joinRoom(code: String, name: String) async throws {
        _ = try await requireUid()
        let result: RoomResult = try await call("join-room", JoinRoomPayload(code: code, name: name))
        try await attach(roomId: result.roomId)
    }

    func addDummyPlayer() throws {
        throw GameError.precondition("ダミーの友達は端末内モードだけで使えます")
    }

    func leaveRoom() async {
        guard let roomId, let uid else {
            reset()
            return
        }
        try? await client.from("presence").upsert(PresenceUpsert(roomId: roomId, uid: uid, online: false)).execute()
        reset()
        struct Payload: Encodable { var roomId: String }
        _ = try? await call("leave-room", Payload(roomId: roomId)) as Empty
    }

    // MARK: ロビー・もう一度遊ぶ

    struct ConfigurePayload: Encodable {
        var roomId: String
        var settings: GameSettings
        var startPoint: LatLng?
        var exclusionZones: [[String: [String: Double]]]
    }

    func configureGame(_ draft: GameDraft) async throws {
        let roomId = try requireRoom()
        let payload = ConfigurePayload(roomId: roomId, settings: draft.settings, startPoint: draft.startPoint,
                                       exclusionZones: Self.zonesPayload(draft.exclusionZones))
        _ = try await call("configure-game", payload) as Empty
    }

    func prepareRematch() async throws {
        struct Payload: Encodable { var roomId: String }
        _ = try await call("prepare-rematch", Payload(roomId: try requireRoom())) as Empty
    }

    func startGame() async throws {
        struct Payload: Encodable { var roomId: String }
        _ = try await call("start-game", Payload(roomId: try requireRoom())) as Empty
    }

    private func requireRoom() throws -> String {
        guard let roomId else { throw GameError.precondition("ルームがありません") }
        return roomId
    }

    // MARK: ゲーム中

    /// 自分の GPS を送る（間引きあり）。ほかの人の位置は送れない
    func reportPosition(playerId: String, position: OwnPosition) {
        guard let uid, playerId == uid, let roomId else { return }
        ownPosition = position
        guard pub?.phase == .playing, pub?.players.first(where: { $0.id == uid })?.status != .caught else { return }
        let now = Date()
        if let last = lastSent {
            let elapsed = now.timeIntervalSince(last.at)
            let moved = Geo.distanceM(last.pos, position.latLng)
            guard elapsed >= Self.sendIntervalSec || moved >= Self.sendMinDistanceM else { return }
        }
        lastSent = (now, position.latLng)
        struct Payload: Encodable { var roomId: String; var position: [String: Double] }
        var posDict: [String: Double] = ["lat": position.lat, "lng": position.lng]
        if let acc = position.accuracyM, acc >= 0 { posDict["acc"] = acc }
        Task { _ = try? await call("report-location", Payload(roomId: roomId, position: posDict)) as Empty }
        claimArrivalIfNear(position)
    }

    /// 自分の目的地から 20m 以内に入ったら「着いた」と申告する（判定はサーバーの実位置で行う）
    private func claimArrivalIfNear(_ position: OwnPosition) {
        guard let mission = ownView?.mission, mission.result == .pending, let dest = mission.destination, let roomId,
              Geo.distanceM(position.latLng, dest.latLng) <= mission.arrivalRadiusM else { return }
        if let last = lastClaimAt, Date().timeIntervalSince(last) < Self.sendIntervalSec { return }
        lastClaimAt = Date()
        struct Payload: Encodable { var roomId: String }
        Task { _ = try? await call("claim-arrival", Payload(roomId: roomId)) as Empty }
    }

    struct ActionResponse: Decodable { var ok: Bool; var capturedId: String?; var reason: String? }

    func requestCapture(hunterId: String?) async -> ActionResult {
        await action("request-capture")
    }

    func requestNewDestination(runnerId: String?) async -> ActionResult {
        await action("change-destination")
    }

    private func action(_ name: String) async -> ActionResult {
        guard let roomId else { return ActionResult(ok: false, reason: "not_playing") }
        struct Payload: Encodable { var roomId: String }
        do {
            let r: ActionResponse = try await call(name, Payload(roomId: roomId))
            return ActionResult(ok: r.ok, capturedId: r.capturedId, reason: r.reason)
        } catch {
            return ActionResult(ok: false, reason: AppModel.message(for: error))
        }
    }

    func abortGame() async throws {
        struct Payload: Encodable { var roomId: String }
        _ = try await call("abort-game", Payload(roomId: try requireRoom())) as Empty
    }

    /// ゲーム画面から0.25秒ごとに呼ばれる。実際に読み直すのは pollIntervalSec おき
    func tick() {
        guard roomId != nil else { return }
        if let last = lastPollAt, Date().timeIntervalSince(last) < Self.pollIntervalSec { return }
        lastPollAt = Date()
        Task { await poll() }
    }

    // MARK: 読み直し（ポーリング）

    private func attach(roomId: String) async throws {
        self.roomId = roomId
        closed = false
        await poll(force: true)
        startPolling()
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.pollIntervalSec * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.poll()
            }
        }
    }

    /// 自分が読めるデータをまとめて読み直す（rooms・members・presence・public_doc・access・
    /// 読める channels・自分の views・結果）
    private func poll(force: Bool = false) async {
        guard let roomId, let uid else { return }
        do {
            let metaRow: RoomMeta = try await client.from("rooms").select("id,host_uid,join_code,phase")
                .eq("id", value: roomId).single().execute().value
            meta = metaRow

            members = try await client.from("members").select("uid,name").eq("room_id", value: roomId).execute().value

            // 在席: Postgres には onDisconnect の仕組みが無いので、定期的なハートビート（下）と
            // 「最後の更新から時間がたちすぎていないか」で判定する（表示用の目安。正確さは保証しない）
            struct PresenceRow: Decodable { var uid: String; var online: Bool; var lastChanged: Date
                enum CodingKeys: String, CodingKey { case uid, online, lastChanged = "last_changed" } }
            let presenceRows: [PresenceRow] = try await client.from("presence").select("uid,online,last_changed").eq("room_id", value: roomId).execute().value
            let staleAfter = Self.pollIntervalSec * 4
            online = Dictionary(uniqueKeysWithValues: presenceRows.map { ($0.uid, $0.online && Date().timeIntervalSince($0.lastChanged) < staleAfter) })
            try? await client.from("presence").upsert(PresenceUpsert(roomId: roomId, uid: uid, online: true)).execute()

            struct DocRow: Decodable { var doc: PublicChannel }
            if let docRow: DocRow = try? await client.from("public_doc").select("doc").eq("room_id", value: roomId).single().execute().value {
                pub = docRow.doc
            }

            if let pub {
                let names = ViewChannels.readableNames(pub, uid: uid)
                if names.contains("hunterPositions") {
                    hunterPositions = try? await fetchChannel(roomId: roomId, name: "hunterPositions")
                } else {
                    hunterPositions = nil
                }
                if names.contains("runnerPositions") {
                    runnerPositions = try? await fetchChannel(roomId: roomId, name: "runnerPositions")
                } else {
                    runnerPositions = nil
                }
                if names.contains("possibleAreas") {
                    possibleAreas = try? await fetchChannel(roomId: roomId, name: "possibleAreas")
                } else {
                    possibleAreas = nil
                }
            }

            struct ViewRow: Decodable { var data: OwnChannel }
            if let viewRow: ViewRow = try? await client.from("views").select("data").eq("room_id", value: roomId).eq("uid", value: uid).single().execute().value {
                ownView = viewRow.data
            }

            if pub?.phase == .finished {
                if resultPublic == nil {
                    struct ResultRow: Decodable { var data: ResultSummary }
                    if let row: ResultRow = try? await client.from("results_public").select("data").eq("room_id", value: roomId).single().execute().value {
                        resultPublic = row.data
                    }
                    struct PersonalRow: Decodable { var data: PersonalSummary }
                    if let row: PersonalRow = try? await client.from("results_personal").select("data").eq("room_id", value: roomId).eq("uid", value: uid).single().execute().value {
                        resultPersonal = row.data
                    }
                }
            } else if resultPublic != nil {
                resultPublic = nil // もう一度遊ぶ: 前の結果を持ち越さない
                resultPersonal = nil
            }
        } catch {
            // メンバーでなくなった（部屋が解散した・追い出された）等。PostgREST は空配列/404 を返すので、
            // meta が取れなくなったことをもって「閉じた」とみなす
            if force || meta == nil { closed = true }
        }
    }

    private struct PresenceUpsert: Encodable {
        var roomId: String
        var uid: String
        var online: Bool
        var lastChanged = Date()
        enum CodingKeys: String, CodingKey { case roomId = "room_id", uid, online, lastChanged = "last_changed" }
    }

    private struct ChannelRow<T: Decodable>: Decodable { var data: T }

    private func fetchChannel<T: Decodable>(roomId: String, name: String) async throws -> T {
        let row: ChannelRow<T> = try await client.from("channels").select("data").eq("room_id", value: roomId).eq("name", value: name).single().execute().value
        return row.data
    }

    private func reset() {
        pollTask?.cancel()
        pollTask = nil
        roomId = nil
        meta = nil
        members = []
        online = [:]
        pub = nil
        hunterPositions = nil
        runnerPositions = nil
        possibleAreas = nil
        ownView = nil
        resultPublic = nil
        resultPersonal = nil
        closed = false
        ownPosition = nil
        lastSent = nil
        lastClaimAt = nil
        lastPollAt = nil
    }
}

private extension Session {
    func with(closed: Bool) -> Session {
        var s = self
        s.closed = closed
        return s
    }
}
