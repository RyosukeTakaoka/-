// ゲームエンジン（状態 + 操作 → 新しい状態）。oni-game/js/game/gameEngine.js の移植
//
// - 入力の state を書き換えず、新しい state を返す（Swift の struct なので自然にそうなる）
// - 時刻は ctx.now で受け取る（Date() を内部で呼ばない）
// - 乱数は ctx.rng で受け取る
// 端末内モード（開発用）では LocalGameService がこれを呼ぶ。
// オンライン（Supabase）では、同じルールの JS 版を Edge Functions が呼ぶ（端末はこれを使わない）。

import Foundation

public struct EngineRandom {
    public var roles: Rng
    public var privacy: Rng
    public var schedule: Rng
    public var destinations: Rng

    public init(roles: @escaping Rng, privacy: @escaping Rng, schedule: @escaping Rng, destinations: @escaping Rng) {
        self.roles = roles
        self.privacy = privacy
        self.schedule = schedule
        self.destinations = destinations
    }

    /// 秘密値・役割・予定は暗号学的乱数、目的地は普通の乱数（JS 版の既定値と同じ使い分け）
    public static let system = EngineRandom(roles: Random.standard, privacy: Random.secure,
                                            schedule: Random.secure, destinations: Random.standard)
}

public struct EngineContext {
    public var now: Millis
    public var rng: EngineRandom
    public var newId: () -> String

    public init(now: Millis, rng: EngineRandom = .system, newId: @escaping () -> String = { Random.id() }) {
        self.now = now
        self.rng = rng
        self.newId = newId
    }
}

/// 操作の失敗理由（画面に座標や距離は返さない）
public enum ActionFailure: String, Codable, Error, Sendable {
    case notPlaying = "not_playing"
    case notInMission = "not_in_mission"
    case notArrived = "not_arrived"
    case alreadyRerolled = "already_rerolled"
    case noDestination = "no_destination"
}

/// 操作の結果（JSON では { ok, capturedId? } / { ok: false, reason }）
public struct ActionResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var capturedId: String?
    public var reason: String?

    public static let success = ActionResult(ok: true)

    public init(ok: Bool, capturedId: String? = nil, reason: String? = nil) {
        self.ok = ok
        self.capturedId = capturedId
        self.reason = reason
    }
}

/// ゲーム進行の結果: 新しい状態・この操作で増えたログ・操作の結果
public struct EngineStep {
    public var state: GameState
    public var events: [LogEntry]
    public var result: ActionResult?
}

public enum GameEngine {
    public static let exclusionRadiusM = 30.0
    static let maxLog = 50

    static func withLog(_ state: GameState, at: Millis, type: String, text: String, playerId: String? = nil) -> GameState {
        var s = state
        s.log.append(LogEntry(id: (state.log.last?.id ?? 0) + 1, at: at, type: type, text: text, playerId: playerId))
        if s.log.count > maxLog { s.log = Array(s.log.suffix(maxLog)) }
        return s
    }

    static func done(_ before: GameState, _ after: GameState, _ result: ActionResult? = nil) -> EngineStep {
        let lastId = before.log.last?.id ?? 0
        return EngineStep(state: after, events: after.log.filter { $0.id > lastId }, result: result)
    }

    // MARK: 作成・ロビー

    public static func updateSettings(_ state: GameState, _ settings: GameSettings) -> GameState {
        var s = state
        s.settings = settings.sanitized()
        if let start = s.startPoint { s.area = GeoCircle(center: start, radiusM: Double(s.settings.radiusM)) } else { s.area = nil }
        return s
    }

    public static func setStartPoint(_ state: GameState, _ point: LatLng) throws -> GameState {
        var s = state
        s.area = try GameArea.create(center: point, radiusM: Double(state.settings.radiusM))
        s.startPoint = point
        return s
    }

    /// 目的地にしない場所（道路・水辺・立入禁止など）を追加する
    public static func addExclusionZone(_ state: GameState, _ point: LatLng, radiusM: Double = exclusionRadiusM) -> GameState {
        guard point.isValid else { return state }
        var s = state
        s.exclusionZones.append(GeoCircle(center: point, radiusM: radiusM))
        return s
    }

    public static func clearExclusionZones(_ state: GameState) -> GameState {
        var s = state
        s.exclusionZones = []
        return s
    }

    public static func enterLobby(_ state: GameState, room: RoomInfo, selfId: String?, players: [Player]) -> GameState {
        var s = state
        s.phase = .lobby
        s.room = room
        s.selfId = selfId
        s.players = players
        return s
    }

    public static func setPlayers(_ state: GameState, _ players: [Player]) -> GameState {
        var s = state
        s.players = players
        return s
    }

    /// 作成画面から、同じルーム・同じメンバーのままロビーへ戻る（もう一度遊ぶとき）
    public static func returnToLobby(_ state: GameState) throws -> GameState {
        guard state.room != nil else { throw GameError.precondition("ルームがありません") }
        guard state.area != nil else { throw GameError.precondition("ゲーム開始地点を設定してください") }
        var s = state
        s.phase = .lobby
        return s
    }

    /// 結果画面から「もう一度遊ぶ」。再利用するのはルーム・メンバー・ゲーム設定だけ
    public static func prepareRematch(_ state: GameState) throws -> GameState {
        guard state.phase == .finished else { throw GameError.precondition("ゲーム終了後にだけ使えます") }
        var s = GameState.initial()
        s.phase = .setup
        s.settings = state.settings
        s.room = state.room
        s.selfId = state.selfId
        s.players = state.players.map { $0.fresh() }
        return s
    }

    // MARK: ゲーム進行

    /// ゲーム開始。役割をランダムに決め、秘密値・ミッションのスケジュールを新しく作り、最初の公開を行う
    public static func startGame(_ state: GameState, initialPositions: [String: LatLng] = [:], ctx: EngineContext) throws -> EngineStep {
        let now = ctx.now
        guard state.phase == .lobby else { throw GameError.precondition("ロビーからのみ開始できます") }
        guard state.area != nil else { throw GameError.precondition("ゲーム開始地点が設定されていません") }
        let players = try Players.prepareForGame(state.players, settings: state.settings, rng: ctx.rng.roles)
        let durationMs = state.settings.durationMin * 60 * 1000
        var positions: [String: StoredPosition] = [:]
        for (id, pos) in initialPositions where pos.isValid {
            positions[id] = StoredPosition(lat: pos.lat, lng: pos.lng, accuracyM: nil, updatedAt: now)
        }
        let hunterNames = players.filter { $0.role == .hunter }.map(\.name)
        var next = state
        next.phase = .playing
        next.gameId = ctx.newId()
        next.players = players
        next.positions = positions
        next.privacy = LocationPublisher.initPrivacy(players, rng: ctx.rng.privacy)
        next.captureAttempts = [:]
        next.missions = Missions.create(schedule: try MissionSchedule.generate(durationMs: durationMs, rng: ctx.rng.schedule), startedAt: now)
        next.startedAt = now
        next.endsAt = now + durationMs
        next.result = nil
        next.resultSummary = nil
        next.log = []
        next = withLog(next, at: now, type: "start", text: "ゲーム開始！ 鬼は \(hunterNames.joined(separator: "、"))")
        next.privacy = LocationPublisher.publishIfDue(next, now: now).privacy // 最初の公開
        return EngineStep(state: next, events: next.log, result: nil)
    }

    /// 実位置の更新。ゲーム中以外・参加者以外は受け付けない
    public static func updatePosition(_ state: GameState, playerId: String, pos: LatLng, accuracyM: Double? = nil, ctx: EngineContext) -> EngineStep {
        let now = ctx.now
        guard state.phase == .playing, pos.isValid, state.players.contains(where: { $0.id == playerId }) else {
            return done(state, state)
        }
        var next = state
        next.positions[playerId] = StoredPosition(lat: pos.lat, lng: pos.lng, accuracyM: accuracyM, updatedAt: now)
        // ミッションの到達判定（実位置で判定。結果以外の情報は外に出さない）
        if next.missions.active != nil { next.missions = Missions.checkArrivals(next.missions, positions: next.positions, now: now) }
        // 公開済みの可能性エリアは変えない。まだ一度も公開されていない逃走者だけ公開する
        if next.privacy.published[playerId] == nil { next.privacy = LocationPublisher.publishMissing(next, now: now) }
        return done(state, next)
    }

    /// 鬼の確保操作。対象は実位置から一番近い逃走者（座標や距離は返さない）
    public static func requestCapture(_ state: GameState, hunterId: String, ctx: EngineContext) -> EngineStep {
        let now = ctx.now
        var next = state
        switch Capture.attempt(state, hunterId: hunterId, now: now) {
        case let .failure(reason):
            // 実際に判定まで進んだ操作だけクールダウンの起点にする
            if reason == .noTarget { next.captureAttempts[hunterId] = now }
            return done(state, next, ActionResult(ok: false, reason: reason.rawValue))
        case let .success(capturedId, players):
            next.captureAttempts[hunterId] = now
            next.players = players
            next.privacy = LocationPublisher.withdraw(next.privacy, playerId: capturedId)
            next.missions = Missions.withdrawParticipant(next.missions, runnerId: capturedId, now: now)
            let hunter = players.first { $0.id == hunterId }!
            let caught = players.first { $0.id == capturedId }!
            let suffix = state.settings.zombieMode ? "\(caught.name) は鬼になった！" : "\(caught.name) は脱落"
            next = withLog(next, at: now, type: "capture", text: "\(hunter.name) が \(caught.name) を確保！ \(suffix)", playerId: caught.id)
            next = checkOutcome(next, now: now)
            return done(state, next, ActionResult(ok: true, capturedId: capturedId))
        }
    }

    /// 逃走者本人からの「到達した」申告（オンライン版で使う。判定は保存されている実位置で行う）
    public static func claimArrival(_ state: GameState, runnerId: String, ctx: EngineContext) -> EngineStep {
        let now = ctx.now
        guard state.phase == .playing else { return done(state, state, ActionResult(ok: false, reason: ActionFailure.notPlaying.rawValue)) }
        guard let p = state.missions.active?.participants[runnerId], p.result == .pending else {
            return done(state, state, ActionResult(ok: false, reason: ActionFailure.notInMission.rawValue))
        }
        var next = state
        if let pos = state.positions[runnerId] {
            next.missions = Missions.checkArrivals(state.missions, positions: [runnerId: pos], now: now)
        }
        let ok = next.missions.active?.participants[runnerId]?.result == .success
        return done(state, next, ok ? .success : ActionResult(ok: false, reason: ActionFailure.notArrived.rawValue))
    }

    /// 目的地が行けない・危ない場所だったとき、変更する（1ゲーム1回。ログには残さない）
    public static func changeDestination(_ state: GameState, runnerId: String, ctx: EngineContext) -> EngineStep {
        guard state.phase == .playing else { return done(state, state, ActionResult(ok: false, reason: ActionFailure.notPlaying.rawValue)) }
        switch Missions.reroll(state, runnerId: runnerId, now: ctx.now, rng: ctx.rng.destinations) {
        case let .failure(reason):
            return done(state, state, ActionResult(ok: false, reason: reason.rawValue))
        case let .success(missions):
            var next = state
            next.missions = missions
            return done(state, next, .success)
        }
    }

    /// 時間を進める: 時間切れの判定 → ミッションの開始・終了 → 可能性エリアの公開（同じ now で何度呼んでも結果は同じ）
    public static func advance(_ state: GameState, ctx: EngineContext) -> EngineStep {
        let now = ctx.now
        guard state.phase == .playing else { return done(state, state) }
        var next = checkOutcome(state, now: now)
        if next.phase != .playing { return done(state, next) } // 決着したらミッション・公開は進めない
        next = progressMissions(next, now: now, rng: ctx.rng.destinations)
        let published = LocationPublisher.publishIfDue(next, now: now)
        if published.revealed {
            next.privacy = published.privacy
            next = withLog(next, at: now, type: "reveal", text: "逃走者の可能性エリアが更新されました")
        }
        return done(state, next)
    }

    /// ホストによる途中終了
    public static func abort(_ state: GameState, ctx: EngineContext) -> EngineStep {
        guard state.phase == .playing else { return done(state, state) }
        return done(state, finish(state, winner: nil, reason: .aborted, now: ctx.now))
    }

    /// 次に何かが起きる時刻（時間切れ・次の公開・ミッションの開始/終了のうち一番早いもの）
    public static func nextDueAt(_ state: GameState) -> Millis? {
        guard state.phase == .playing, let startedAt = state.startedAt, let endsAt = state.endsAt else { return nil }
        let intervalMs = state.settings.revealIntervalSec * 1000
        var candidates = [endsAt, startedAt + (state.privacy.epoch + 1) * intervalMs]
        if let active = state.missions.active {
            candidates.append(active.endsAt)
        } else if state.missions.nextIndex < state.missions.schedule.count {
            candidates.append(state.missions.schedule[state.missions.nextIndex].startsAt)
        }
        return candidates.min()
    }

    // MARK: 内部

    static func progressMissions(_ state: GameState, now: Millis, rng: Rng) -> GameState {
        let r = Missions.advance(state, now: now, rng: rng)
        if r.missions == state.missions && r.players == state.players { return state }
        var next = state
        next.missions = r.missions
        next.players = r.players
        for e in r.events {
            switch e {
            case let .started(index):
                next = withLog(next, at: now, type: "mission_start", text: "ミッション\(index)発生！ 逃走者は制限時間内に目的地へ向かえ")
            case let .ended(index, results):
                let c = Missions.summarize(results)
                next = withLog(next, at: now, type: "mission_end", text: "ミッション\(index)終了：成功 \(c.success)人・失敗 \(c.failure)人")
            }
        }
        return next
    }

    static func checkOutcome(_ state: GameState, now: Millis) -> GameState {
        guard let endsAt = state.endsAt, let outcome = Outcome.judge(players: state.players, endsAt: endsAt, now: now) else { return state }
        return finish(state, winner: outcome.winner, reason: outcome.reason, now: now)
    }

    /// 決着: 位置情報・秘密値・可能性エリアを破棄し、ミッションを打ち切り、破棄した「後」の状態から結果を作る
    static func finish(_ state: GameState, winner: Winner?, reason: FinishReason, now: Millis) -> GameState {
        let finishedAt = min(state.endsAt ?? now, now)
        var cleared = state
        cleared.phase = .finished
        cleared.endsAt = finishedAt
        cleared.result = GameResult(winner: winner, reason: reason, finishedAt: finishedAt)
        cleared.positions = [:] // 終了したら実位置は保持しない
        cleared.privacy = .empty // 秘密の値・公開済みエリアも消す
        var missions = Missions.cancelAll(state.missions, now: now)
        missions.schedule = []
        missions.nextIndex = 0
        cleared.missions = missions
        cleared.captureAttempts = [:]
        cleared.resultSummary = ResultSummaries.build(cleared)
        let text: String
        switch reason {
        case .timeUp: text = "時間切れ！ 逃走者の勝ち"
        case .allCaught: text = "全員確保！ 鬼の勝ち"
        case .aborted: text = "ホストがゲームを終了しました"
        }
        return withLog(cleared, at: now, type: "finish", text: text)
    }
}
