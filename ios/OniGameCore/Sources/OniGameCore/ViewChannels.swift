// 「誰に・何を見せるか」（oni-game/js/game/visibility.js と viewChannels.js の移植）
//
// 見せてよい情報を「読める人の集まり（チャンネル）」ごとに分ける:
//   public           … 部屋のメンバー全員
//   hunterPositions  … 参加中の鬼。設定 ON なら全メンバー
//   runnerPositions  … 参加中の逃走者だけ
//   possibleAreas    … 参加中の鬼だけ
//   views[uid]       … 本人だけ
// オンラインでは、サーバー（Cloud Functions の JS 版 buildChannels）がこれを RTDB に書き、
// Security Rules が「読める人」を制限する。端末は読めたチャンネルだけを受け取り、assemble() で画面用のビューを作る。
// 端末内モードでは、この端末が build() → readable() → assemble() を行う（同じ規則で表示される）。
//
// 表示ルール（ゲーム中）:
// | 見る人 ＼ 見られる人 | 鬼                          | 参加中の逃走者     | 脱落者 |
// | 鬼                   | 位置                        | 可能性エリアだけ   | なし   |
// | 参加中の逃走者       | 位置（設定でOFFにできる）    | 位置（仲間）       | なし   |
// | 脱落者               | 位置（設定でOFFにできる）    | なし               | なし   |
// ゲーム外（ロビー・終了後）は位置を一切表示しない。

import Foundation

// MARK: - チャンネルの中身（JSON の形は JS 版と同じ）

/// 相手に見せてよいプレイヤー情報（位置・ぼかし精度・履歴の詳細は含めない）
public struct PublicPlayer: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var isHost: Bool?
    public var isDummy: Bool?
    public var role: Role?
    public var originalRole: Role?
    public var status: PlayerStatus?
    public var captures: Int?
    public var caughtAt: Millis?

    public init(_ p: Player) {
        id = p.id
        name = p.name
        isHost = p.isHost
        isDummy = p.isDummy
        role = p.role
        originalRole = p.originalRole
        status = p.status
        captures = p.captures
        caughtAt = p.caughtAt
    }

    public var isActiveHunter: Bool { role == .hunter && (status ?? .active) == .active }
    public var isActiveRunner: Bool { role == .runner && (status ?? .active) == .active }
    public var isCaught: Bool { status == .caught }
}

/// ビュー用の可能性エリア（中心・半径・公開時刻だけ）
public struct AreaDisplay: Codable, Equatable, Sendable {
    public var kind: String = "possibleArea"
    public var playerId: String
    public var type: String = "possibleArea"
    public var center: LatLng
    public var radiusM: Double
    public var publishedAt: Millis

    public init(playerId: String, published: PublishedArea) {
        self.playerId = playerId
        center = published.center
        radiusM = published.radiusM
        publishedAt = published.publishedAt
    }
}

/// 全員に見せてよい、進行中のミッション（目的地・発生予定は含めない）
public struct SharedMission: Codable, Equatable, Sendable {
    public var index: Int
    public var total: Int
    public var startedAt: Millis
    public var endsAt: Millis
}

public struct LastMission: Codable, Equatable, Sendable {
    public var index: Int
    public var success: Int
    public var failure: Int
    public var cancelled: Int
}

/// 本人にだけ見せるミッション情報（自分の目的地と結果）
public struct OwnMission: Codable, Equatable, Sendable {
    public var index: Int
    public var endsAt: Millis
    public var arrivalRadiusM: Double
    public var result: MissionStatus
    public var reason: String?
    public var destination: Destination?
    public var canReroll: Bool
}

public struct MissionHistoryItem: Codable, Equatable, Sendable {
    public var missionId: String
    public var result: MissionResult
}

public struct PublicChannel: Codable, Equatable, Sendable {
    public var phase: GamePhase
    public var area: GeoCircle?
    public var exclusionZones: [GeoCircle]
    public var settings: GameSettings
    public var startedAt: Millis?
    public var endsAt: Millis?
    public var result: GameResult?
    public var mission: SharedMission?
    public var missionsCompleted: Int
    public var lastMission: LastMission?
    public var players: [PublicPlayer]
    public var runnersRemaining: Int
    public var runnersTotal: Int
    public var log: [LogEntry]
}

/// 本人だけが読めるデータ（views/{uid}）
public struct OwnChannel: Codable, Equatable, Sendable {
    public var captureReadyAt: Millis
    public var blurM: Double?
    public var possibleArea: AreaDisplay?
    public var mission: OwnMission?
    public var missionHistory: [MissionHistoryItem]
}

public struct Channels: Codable, Equatable, Sendable {
    public var `public`: PublicChannel
    public var hunterPositions: [String: LatLng]
    public var runnerPositions: [String: LatLng]
    public var possibleAreas: [String: AreaDisplay]
    public var views: [String: OwnChannel]
}

/// 1人が読めたチャンネル（読めないものは nil）
public struct ReadableChannels: Equatable, Sendable {
    public var `public`: PublicChannel
    public var hunterPositions: [String: LatLng]?
    public var runnerPositions: [String: LatLng]?
    public var possibleAreas: [String: AreaDisplay]?
    public var view: OwnChannel?

    public init(public: PublicChannel, hunterPositions: [String: LatLng]? = nil, runnerPositions: [String: LatLng]? = nil,
                possibleAreas: [String: AreaDisplay]? = nil, view: OwnChannel? = nil) {
        self.public = `public`
        self.hunterPositions = hunterPositions
        self.runnerPositions = runnerPositions
        self.possibleAreas = possibleAreas
        self.view = view
    }
}

// MARK: - 画面用のビュー

public enum Display: Equatable, Sendable {
    case hidden
    case exact(LatLng)
    case area(AreaDisplay)
}

public struct OwnPosition: Equatable, Sendable {
    public var lat: Double
    public var lng: Double
    public var accuracyM: Double?

    public init(lat: Double, lng: Double, accuracyM: Double? = nil) {
        self.lat = lat
        self.lng = lng
        self.accuracyM = accuracyM
    }

    public var latLng: LatLng { LatLng(lat: lat, lng: lng) }
}

public struct SelfView: Equatable, Sendable {
    public var player: PublicPlayer
    public var position: OwnPosition?
    public var outOfArea: Bool
    public var captureReadyAt: Millis
    public var blurM: Double?
    public var possibleArea: AreaDisplay? // 自分が鬼にどう見えているか
    public var mission: OwnMission?
    public var missionHistory: [MissionHistoryItem]
}

public struct OtherPlayer: Equatable, Sendable, Identifiable {
    public var player: PublicPlayer
    public var display: Display
    public var id: String { player.id }
}

/// その人に見せてよい情報だけをまとめたビュー（画面はこれだけを描画する）
public struct PlayerView: Equatable, Sendable {
    public var phase: GamePhase
    public var now: Millis
    public var area: GeoCircle?
    public var exclusionZones: [GeoCircle]
    public var settings: GameSettings
    public var startedAt: Millis?
    public var endsAt: Millis?
    public var nextRevealAt: Millis?
    public var result: GameResult?
    public var mission: SharedMission?
    public var missionsCompleted: Int
    public var lastMission: LastMission?
    public var me: SelfView?
    public var others: [OtherPlayer]
    public var runnersRemaining: Int
    public var runnersTotal: Int
    public var log: [LogEntry]
}

// MARK: - 作る・分ける・組み立てる

public enum ViewChannels {
    static func sharedMissionInfo(_ missions: MissionState) -> (SharedMission?, Int, LastMission?) {
        let ended = missions.history.filter { $0.skipped != true }
        let mission = missions.active.map {
            SharedMission(index: $0.index, total: MissionSchedule.missionCount, startedAt: $0.startedAt, endsAt: $0.endsAt)
        }
        let last = ended.last.map { e -> LastMission in
            let c = Missions.summarize(e.results)
            return LastMission(index: e.index, success: c.success, failure: c.failure, cancelled: c.cancelled)
        }
        return (mission, ended.count, last)
    }

    static func ownMissionInfo(_ missions: MissionState, viewerId: String) -> OwnMission? {
        guard let active = missions.active, let p = active.participants[viewerId] else { return nil }
        return OwnMission(
            index: active.index, endsAt: active.endsAt, arrivalRadiusM: active.arrivalRadiusM,
            result: p.result, reason: p.reason,
            destination: p.result == .pending ? p.destination : nil,
            canReroll: Missions.canReroll(missions, runnerId: viewerId)
        )
    }

    /// 状態を公開範囲ごとのチャンネルに分ける（実位置を読むのはここだけ）
    public static func build(_ state: GameState) -> Channels {
        let playing = state.phase == .playing
        var hunterPositions: [String: LatLng] = [:]
        var runnerPositions: [String: LatLng] = [:]
        var possibleAreas: [String: AreaDisplay] = [:]
        if playing {
            for p in state.players {
                let pos = state.positions[p.id]?.latLng
                if p.isActiveHunter, let pos { hunterPositions[p.id] = pos }
                if p.isActiveRunner {
                    if let pos { runnerPositions[p.id] = pos }
                    if let published = state.privacy.published[p.id] { possibleAreas[p.id] = AreaDisplay(playerId: p.id, published: published) }
                }
            }
        }

        var views: [String: OwnChannel] = [:]
        for p in state.players {
            let last = state.captureAttempts[p.id]
            let ownArea = playing && p.isActiveRunner ? state.privacy.published[p.id] : nil
            views[p.id] = OwnChannel(
                captureReadyAt: last.map { $0 + Capture.cooldownMs } ?? 0,
                blurM: p.isActiveRunner ? p.blurM : nil,
                possibleArea: ownArea.map { AreaDisplay(playerId: p.id, published: $0) },
                mission: playing ? ownMissionInfo(state.missions, viewerId: p.id) : nil,
                missionHistory: p.missionHistory.map { MissionHistoryItem(missionId: $0.missionId, result: $0.result) }
            )
        }

        let (mission, completed, last) = playing ? sharedMissionInfo(state.missions) : (nil, 0, nil)
        return Channels(
            public: PublicChannel(
                phase: state.phase, area: state.area, exclusionZones: state.exclusionZones, settings: state.settings,
                startedAt: state.startedAt, endsAt: state.endsAt, result: state.result,
                mission: mission, missionsCompleted: completed, lastMission: last,
                players: state.players.map(PublicPlayer.init),
                runnersRemaining: Players.activeRunners(state.players).count,
                runnersTotal: Players.originalRunners(state.players).count,
                log: state.log
            ),
            hunterPositions: hunterPositions,
            runnerPositions: runnerPositions,
            possibleAreas: possibleAreas,
            views: views
        )
    }

    /// uid の人が読めるチャンネルだけを返す（= Security Rules の仕様）。部屋のメンバーでなければ nil
    public static func readable(_ channels: Channels, uid: String) -> ReadableChannels? {
        guard let me = channels.public.players.first(where: { $0.id == uid }) else { return nil }
        let playing = channels.public.phase == .playing
        return ReadableChannels(
            public: channels.public,
            hunterPositions: playing && (me.isActiveHunter || channels.public.settings.showHuntersToRunners) ? channels.hunterPositions : nil,
            runnerPositions: playing && me.isActiveRunner ? channels.runnerPositions : nil,
            possibleAreas: playing && me.isActiveHunter ? channels.possibleAreas : nil,
            view: channels.views[uid]
        )
    }

    /// 読めるチャンネルの種類（オンライン版で、どのパスを購読するかを決めるのに使う）
    public static func readableNames(_ pub: PublicChannel, uid: String) -> Set<String> {
        guard let me = pub.players.first(where: { $0.id == uid }), pub.phase == .playing else { return [] }
        var names: Set<String> = []
        if me.isActiveHunter || pub.settings.showHuntersToRunners { names.insert("hunterPositions") }
        if me.isActiveRunner { names.insert("runnerPositions") }
        if me.isActiveHunter { names.insert("possibleAreas") }
        return names
    }

    static func display(_ parts: ReadableChannels, me: PublicPlayer?, target: PublicPlayer) -> Display {
        guard parts.public.phase == .playing, me != nil, (target.status ?? .active) == .active else { return .hidden }
        if target.role == .hunter {
            if let pos = parts.hunterPositions?[target.id] { return .exact(pos) }
            return .hidden
        }
        if let pos = parts.runnerPositions?[target.id] { return .exact(pos) }
        if let area = parts.possibleAreas?[target.id] { return .area(area) }
        return .hidden
    }

    /// 読めたチャンネルから画面用のビューを組み立てる。ownPosition は端末自身の GPS
    public static func assemble(_ parts: ReadableChannels, uid: String, now: Millis, ownPosition: OwnPosition?) -> PlayerView {
        let pub = parts.public
        let playing = pub.phase == .playing
        let me = pub.players.first { $0.id == uid }
        let own = playing ? ownPosition : nil
        let view = parts.view
        return PlayerView(
            phase: pub.phase,
            now: now,
            area: pub.area,
            exclusionZones: pub.exclusionZones,
            settings: pub.settings,
            startedAt: pub.startedAt,
            endsAt: pub.endsAt,
            nextRevealAt: playing && pub.startedAt != nil
                ? LocationPublisher.nextRevealAt(now: now, startedAt: pub.startedAt!, settings: pub.settings) : nil,
            result: pub.result,
            mission: pub.mission,
            missionsCompleted: pub.missionsCompleted,
            lastMission: pub.lastMission,
            me: me.map { m in
                SelfView(
                    player: m,
                    position: own,
                    outOfArea: own != nil && pub.area != nil && !GameArea.isInside(pub.area!, own!.latLng),
                    captureReadyAt: view?.captureReadyAt ?? 0,
                    blurM: view?.blurM,
                    possibleArea: view?.possibleArea,
                    mission: view?.mission,
                    missionHistory: view?.missionHistory ?? []
                )
            },
            others: pub.players.filter { $0.id != uid }.map { OtherPlayer(player: $0, display: display(parts, me: me, target: $0)) },
            runnersRemaining: pub.runnersRemaining,
            runnersTotal: pub.runnersTotal,
            log: pub.log
        )
    }

    /// 端末内モード用: 状態から viewerId の人のビューを作る（build → readable → assemble）
    public static func view(of state: GameState, viewerId: String, now: Millis) -> PlayerView? {
        guard let parts = readable(build(state), uid: viewerId) else { return nil }
        let pos = state.phase == .playing ? state.positions[viewerId] : nil
        return assemble(parts, uid: viewerId, now: now,
                        ownPosition: pos.map { OwnPosition(lat: $0.lat, lng: $0.lng, accuracyM: $0.accuracyM) })
    }
}
