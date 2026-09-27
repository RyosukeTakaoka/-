// オンライン対戦（Firebase）の GameService
//
// 判定はすべてサーバー（Cloud Functions）が行い、この端末は「要求」と「表示」だけを行う。
//   - 要求: 呼び出し型関数（createRoom / joinRoom / leaveRoom / configureGame / startGame / requestCapture /
//           claimArrival / changeDestination / abortGame / prepareRematch）
//   - 自分の GPS: /locations/{roomId}/{uid} にだけ書く（誰も読めない。サーバーが検証して公開用データを作る）
//   - 表示: 自分が読めるデータだけを購読し、ViewChannels.assemble で画面用のビューを組み立てる
//       rooms/{r}/meta・members・presence … 部屋の情報（メンバー全員）
//       rooms/{r}/public/doc              … 全員に見せてよいゲーム情報（JSON 文字列）
//       rooms/{r}/channels/{name}         … 鬼の位置・仲間の位置・可能性エリア（読める人だけ。ルールで制限）
//       rooms/{r}/views/{uid}             … 自分だけのデータ（自分の円・目的地・クールダウン）
//       rooms/{r}/results/public・personal/{uid} … 結果
// どのチャンネルを購読するかは ViewChannels.readableNames（= Security Rules の仕様）で決め、役割が変わったら付け替える。

import Foundation
import Observation
import OniGameCore
import FirebaseCore
import FirebaseAuth
import FirebaseDatabase
import FirebaseFunctions

@MainActor
@Observable
final class FirebaseGameService: GameService {
    let mode = BackendMode.firebase

    private(set) var uid: String?
    private(set) var roomId: String?
    private var meta: RoomMeta?
    private var members: [String: Member] = [:]
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
    private var serverOffsetMs: Millis = 0

    @ObservationIgnored private let db: Database
    @ObservationIgnored private let functions: Functions
    @ObservationIgnored private var roomHandles: [(DatabaseReference, DatabaseHandle)] = []
    @ObservationIgnored private var channelHandles: [String: (DatabaseReference, DatabaseHandle)] = [:]
    @ObservationIgnored private var presenceHandle: (DatabaseReference, DatabaseHandle)?
    @ObservationIgnored private var lastSent: (at: Date, pos: LatLng)?
    @ObservationIgnored private var lastClaimAt: Date?
    @ObservationIgnored private var signIn: Task<String, Error>?

    /// 位置の送信の間引き（design: 5秒おき、または10m以上動いたとき。ルールで2秒未満の連続書き込みは拒否される）
    static let sendIntervalSec = 5.0
    static let sendMinIntervalSec = 2.0
    static let sendMinDistanceM = 10.0

    struct RoomMeta: Equatable {
        var hostUid: String
        var joinCode: String
        var phase: GamePhase?
    }

    struct Member: Equatable {
        var name: String
        var joinedAt: Double
    }

    init(config: AppConfig) {
        FirebaseBootstrap.configureIfNeeded(config)
        db = Database.database()
        functions = Functions.functions(region: config.functionsRegion)
        if config.firebaseMode == .emulator {
            // エミュレーター（ローカル）にだけ接続する。本番には接続しない
            Auth.auth().useEmulator(withHost: config.emulatorHost, port: 9099)
            db.useEmulator(withHost: config.emulatorHost, port: 9000)
            functions.useEmulator(withHost: config.emulatorHost, port: 5001)
        }
        // サーバー時刻との差（残り時間の表示だけに使う）
        db.reference(withPath: ".info/serverTimeOffset").observe(.value) { [weak self] snap in
            let offset = (snap.value as? NSNumber)?.doubleValue ?? 0
            Task { @MainActor in self?.serverOffsetMs = Millis(offset) }
        }
        signIn = Task { try await Self.ensureSignedIn() }
    }

    /// ログイン済みならその uid、まだなら匿名ログインして uid を返す
    private static func ensureSignedIn() async throws -> String {
        if let user = Auth.auth().currentUser { return user.uid }
        return try await Auth.auth().signInAnonymously().user.uid
    }

    private func requireUid() async throws -> String {
        if let uid { return uid }
        guard let task = signIn else { throw GameError.precondition("ログインできませんでした") }
        do {
            let id = try await task.value
            uid = id
            return id
        } catch {
            signIn = Task { try await Self.ensureSignedIn() } // 次の操作でもう一度試す
            throw GameError.precondition("ログインできませんでした（\(AppModel.message(for: error))）")
        }
    }

    // MARK: 読み取り

    var session: Session {
        guard roomId != nil, let meta else { return closed ? Session.empty.with(closed: true) : .empty }
        let players = members.sorted { $0.value.joinedAt < $1.value.joinedAt }.map { id, m in
            LobbyPlayer(id: id, name: m.name, isHost: id == meta.hostUid, isDummy: false, online: online[id] == true)
        }
        return Session(
            phase: pub?.phase ?? meta.phase,
            roomCode: meta.joinCode,
            selfId: uid,
            isHost: uid == meta.hostUid, // サーバーが決めた meta.hostUid で判定（自分で名乗らない）
            settings: pub?.settings ?? .default,
            area: pub?.area,
            exclusionZones: pub?.exclusionZones ?? [],
            players: players,
            hasResult: resultPublic != nil,
            closed: closed
        )
    }

    func now() -> Millis { nowMillis() + serverOffsetMs }

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

    // MARK: 呼び出し型関数

    @discardableResult
    private func call(_ name: String, _ data: [String: Any]) async throws -> [String: Any] {
        do {
            let result = try await functions.httpsCallable(name).call(data)
            return result.data as? [String: Any] ?? [:]
        } catch {
            // サーバーの HttpsError のメッセージ（日本語）をそのまま画面に出す
            throw GameError.precondition((error as NSError).localizedDescription)
        }
    }

    private static func payload(_ draft: GameDraft) throws -> [String: Any] {
        let settings = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.settings))
        var data: [String: Any] = [
            "settings": settings,
            "exclusionZones": draft.exclusionZones.map { ["center": ["lat": $0.lat, "lng": $0.lng]] },
        ]
        if let p = draft.startPoint { data["startPoint"] = ["lat": p.lat, "lng": p.lng] }
        return data
    }

    // MARK: ルーム

    func createRoom(hostName: String, draft: GameDraft) async throws {
        _ = try await requireUid()
        var data = try Self.payload(draft)
        data["name"] = hostName
        let r = try await call("createRoom", data)
        try attach(r)
    }

    func joinRoom(code: String, name: String) async throws {
        _ = try await requireUid()
        let r = try await call("joinRoom", ["code": code, "name": name])
        try attach(r)
    }

    func addDummyPlayer() throws {
        throw GameError.precondition("ダミーの友達は端末内モードだけで使えます")
    }

    func leaveRoom() async {
        guard let roomId else {
            reset()
            return
        }
        await stopPresence()
        reset()
        _ = try? await call("leaveRoom", ["roomId": roomId])
    }

    // MARK: ロビー・もう一度遊ぶ

    func configureGame(_ draft: GameDraft) async throws {
        var data = try Self.payload(draft)
        data["roomId"] = try requireRoom()
        try await call("configureGame", data)
    }

    func prepareRematch() async throws {
        try await call("prepareRematch", ["roomId": try requireRoom()])
    }

    func startGame() async throws {
        try await call("startGame", ["roomId": try requireRoom()])
    }

    private func requireRoom() throws -> String {
        guard let roomId else { throw GameError.precondition("ルームがありません") }
        return roomId
    }

    // MARK: ゲーム中

    /// 自分の GPS を送る（間引きあり）。ほかの人の位置は送れない（ルールで拒否される）
    func reportPosition(playerId: String, position: OwnPosition) {
        guard let uid, playerId == uid, let roomId else { return }
        ownPosition = position
        guard pub?.phase == .playing, pub?.players.first(where: { $0.id == uid })?.status != .caught else { return }
        let now = Date()
        if let last = lastSent {
            let elapsed = now.timeIntervalSince(last.at)
            let moved = Geo.distanceM(last.pos, position.latLng)
            guard elapsed >= Self.sendIntervalSec || (elapsed >= Self.sendMinIntervalSec && moved >= Self.sendMinDistanceM) else { return }
        }
        lastSent = (now, position.latLng)
        var value: [String: Any] = ["lat": position.lat, "lng": position.lng, "t": ServerValue.timestamp()]
        if let acc = position.accuracyM, acc >= 0 { value["acc"] = min(acc, 100_000) }
        db.reference(withPath: "locations/\(roomId)/\(uid)").setValue(value)
        claimArrivalIfNear(position)
    }

    /// 自分の目的地から 20m 以内に入ったら「着いた」と申告する（判定はサーバーの実位置で行う）
    private func claimArrivalIfNear(_ position: OwnPosition) {
        guard let mission = ownView?.mission, mission.result == .pending, let dest = mission.destination, let roomId,
              Geo.distanceM(position.latLng, dest.latLng) <= mission.arrivalRadiusM else { return }
        if let last = lastClaimAt, Date().timeIntervalSince(last) < Self.sendIntervalSec { return }
        lastClaimAt = Date()
        Task { _ = try? await call("claimArrival", ["roomId": roomId]) }
    }

    func requestCapture(hunterId: String?) async -> ActionResult {
        await action("requestCapture")
    }

    func requestNewDestination(runnerId: String?) async -> ActionResult {
        await action("changeDestination")
    }

    private func action(_ name: String) async -> ActionResult {
        guard let roomId else { return ActionResult(ok: false, reason: "not_playing") }
        do {
            let r = try await call(name, ["roomId": roomId])
            return ActionResult(ok: r["ok"] as? Bool ?? false, capturedId: r["capturedId"] as? String, reason: r["reason"] as? String)
        } catch {
            return ActionResult(ok: false, reason: AppModel.message(for: error))
        }
    }

    func abortGame() async throws {
        try await call("abortGame", ["roomId": try requireRoom()])
    }

    func tick() {} // 時間を進めるのはサーバー（予約実行）の役目

    // MARK: 購読

    private func attach(_ r: [String: Any]) throws {
        guard let id = r["roomId"] as? String, let uid else { throw GameError.precondition("部屋に入れませんでした") }
        detach()
        roomId = id
        closed = false
        meta = RoomMeta(hostUid: r["hostUid"] as? String ?? "", joinCode: r["joinCode"] as? String ?? "", phase: .lobby)

        watch("rooms/\(id)/meta") { [weak self] value in
            guard let self else { return }
            guard let m = value as? [String: Any] else {
                self.closed = true // ホストが退出して部屋が解散した
                return
            }
            self.meta = RoomMeta(hostUid: m["hostUid"] as? String ?? "", joinCode: m["joinCode"] as? String ?? "",
                                 phase: (m["phase"] as? String).flatMap(GamePhase.init(rawValue:)))
        }
        watch("rooms/\(id)/members") { [weak self] value in
            let dict = value as? [String: [String: Any]] ?? [:]
            self?.members = dict.compactMapValues { m in
                guard let name = m["name"] as? String else { return nil }
                return Member(name: name, joinedAt: (m["joinedAt"] as? NSNumber)?.doubleValue ?? 0)
            }
        }
        watch("rooms/\(id)/presence") { [weak self] value in
            let dict = value as? [String: [String: Any]] ?? [:]
            self?.online = dict.mapValues { $0["online"] as? Bool ?? false }
        }
        watch("rooms/\(id)/public/doc") { [weak self] value in
            self?.pub = Self.decode(PublicChannel.self, value)
            self?.updateChannelSubscriptions()
        }
        watch("rooms/\(id)/views/\(uid)", closeOnCancel: false) { [weak self] value in
            self?.ownView = Self.decode(OwnChannel.self, value)
        }
        watch("rooms/\(id)/results/public", closeOnCancel: false) { [weak self] value in
            self?.resultPublic = Self.decode(ResultSummary.self, value)
        }
        watch("rooms/\(id)/results/personal/\(uid)", closeOnCancel: false) { [weak self] value in
            self?.resultPersonal = Self.decode(PersonalSummary.self, value)
        }
        startPresence(roomId: id, uid: uid)
    }

    /// value を購読する。読めなくなった（部屋が解散した・メンバーでなくなった）ら closed にする
    private func watch(_ path: String, closeOnCancel: Bool = true, _ onValue: @escaping @MainActor (Any?) -> Void) {
        let ref = db.reference(withPath: path)
        let handle = ref.observe(.value, with: { snap in
            let value = snap.value
            Task { @MainActor in onValue(value is NSNull ? nil : value) }
        }, withCancel: { [weak self] _ in
            Task { @MainActor in if closeOnCancel { self?.closed = true } }
        })
        roomHandles.append((ref, handle))
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) -> T? {
        guard let text = value as? String else { return nil }
        return try? JSONDecoder().decode(type, from: Data(text.utf8))
    }

    /// 役割・フェーズに合わせて、読めるチャンネルだけを購読する（Security Rules と同じ条件）
    private func updateChannelSubscriptions() {
        guard let roomId, let uid, let pub else { return }
        let wanted = ViewChannels.readableNames(pub, uid: uid)
        for (name, entry) in channelHandles where !wanted.contains(name) {
            entry.0.removeObserver(withHandle: entry.1)
            channelHandles[name] = nil
            setChannel(name, nil)
        }
        for name in wanted where channelHandles[name] == nil {
            let ref = db.reference(withPath: "rooms/\(roomId)/channels/\(name)")
            let handle = ref.observe(.value, with: { snap in
                let value = snap.value
                Task { @MainActor [weak self] in self?.setChannel(name, value as? String) }
            }, withCancel: { _ in
                // 読む権限がなくなった（役割が変わった直後など）。次の public の更新で付け替える
                Task { @MainActor [weak self] in
                    self?.channelHandles[name] = nil
                    self?.setChannel(name, nil)
                }
            })
            channelHandles[name] = (ref, handle)
        }
    }

    private func setChannel(_ name: String, _ json: String?) {
        let data = json.map { Data($0.utf8) }
        let decoder = JSONDecoder()
        switch name {
        case "hunterPositions": hunterPositions = data.flatMap { try? decoder.decode([String: LatLng].self, from: $0) }
        case "runnerPositions": runnerPositions = data.flatMap { try? decoder.decode([String: LatLng].self, from: $0) }
        case "possibleAreas": possibleAreas = data.flatMap { try? decoder.decode([String: AreaDisplay].self, from: $0) }
        default: break
        }
    }

    private func detach() {
        for (ref, handle) in roomHandles { ref.removeObserver(withHandle: handle) }
        roomHandles = []
        for (_, entry) in channelHandles { entry.0.removeObserver(withHandle: entry.1) }
        channelHandles = [:]
    }

    private func reset() {
        detach()
        roomId = nil
        meta = nil
        members = [:]
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
    }

    // MARK: 在席（オンライン / オフライン。表示用の目安）

    private func startPresence(roomId: String, uid: String) {
        let myRef = db.reference(withPath: "rooms/\(roomId)/presence/\(uid)")
        let connected = db.reference(withPath: ".info/connected")
        let handle = connected.observe(.value) { snap in
            guard snap.value as? Bool == true else { return }
            // 切断されたらオフラインにする予約をしてから、オンラインを書く
            myRef.onDisconnectSetValue(["online": false, "lastChanged": ServerValue.timestamp()]) { error, _ in
                guard error == nil else { return }
                myRef.setValue(["online": true, "lastChanged": ServerValue.timestamp()])
            }
        }
        presenceHandle = (connected, handle)
    }

    private func stopPresence() async {
        guard let entry = presenceHandle, let roomId, let uid else { return }
        entry.0.removeObserver(withHandle: entry.1)
        presenceHandle = nil
        let myRef = db.reference(withPath: "rooms/\(roomId)/presence/\(uid)")
        myRef.cancelDisconnectOperations()
        _ = try? await myRef.setValue(["online": false, "lastChanged": ServerValue.timestamp()])
    }
}

private extension Session {
    func with(closed: Bool) -> Session {
        var s = self
        s.closed = closed
        return s
    }
}

/// Firebase の初期化（1回だけ）
enum FirebaseBootstrap {
    static func configureIfNeeded(_ config: AppConfig) {
        guard FirebaseApp.app() == nil else { return }
        switch config.firebaseMode {
        case .production:
            // GoogleService-Info.plist（Firebase コンソールからダウンロード。Git 管理外）を使う
            FirebaseApp.configure()
        case .emulator:
            // エミュレーター用の仮の設定（projectId は "demo-" で始まるので本番には接続されない）
            let options = FirebaseOptions(googleAppID: "1:000000000000:ios:0000000000000000", gcmSenderID: "000000000000")
            options.projectID = config.emulatorProjectId
            options.apiKey = "AIzaSyDemoKeyForEmulatorOnly-000000000"
            options.databaseURL = "https://\(config.emulatorProjectId)-default-rtdb.firebaseio.com"
            FirebaseApp.configure(options: options)
        }
    }
}
