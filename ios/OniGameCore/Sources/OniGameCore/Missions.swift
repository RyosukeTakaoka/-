// ミッション（oni-game/js/game/missionSchedule.js・destinations.js・mission.js の移植）
//
// 1ゲームにつき必ず4回。「制限時間内に指定された場所（🎯）へ到達せよ」。
// - 発生時刻はゲーム開始時に決め、プレイヤーには知らせない
// - 目的地は逃走者ごとに作り、本人のビューにだけ入れる
// - 到達判定（20m以内）は実位置を持つ側で行う
// ■ 目的地の安全について: 仮想目的地は地図データ（道路・建物・水辺など）を使っていない。
//   保証するのは「ゲームエリア内」「除外エリアから離れている」「現在地から直線距離で範囲内」の3点だけで、
//   車道・水辺・私有地などの除外はホストが置く除外エリアに依存する。行けない目的地は1ゲームに1回だけ変更できる。

import Foundation

// MARK: - 発生スケジュール

public struct PlannedMission: Codable, Equatable, Sendable {
    public var index: Int
    public var offsetMs: Millis // ゲーム開始からの時間
    public var limitMs: Millis
}

public enum MissionSchedule {
    public static let missionCount = 4
    public static let minLimitMs = 30_000
    static let normalMinLimitMs = 45_000
    static let maxLimitMs = 5 * 60_000
    static let minPreferredLimitMs = 60_000
    static let minBufferMs = 15_000
    static let minGapMs = 15_000
    static let compactGapMs = 10_000
    static let stepMs = 10_000

    struct Timing {
        var limitMs: Int
        var bufferMs: Int
        var gapMs: Int
        var slackMs: Int
    }

    static func floorTo(_ ms: Double, _ step: Int) -> Int { Int(floor(ms / Double(step))) * step }
    static func jsRound(_ v: Double) -> Int { Int(floor(v + 0.5)) } // Math.round と同じ（.5 は大きい方へ）

    static func layout(_ durationMs: Int, bufferMs: Int, gapMs: Int, minLimitMs: Int) -> Timing {
        let usableMs = durationMs - 2 * bufferMs
        let preferred = min(maxLimitMs, max(minPreferredLimitMs, floorTo(Double(durationMs) * 0.1, stepMs)))
        let fitting = floorTo((Double(usableMs - (missionCount - 1) * gapMs) * 0.75) / Double(missionCount), stepMs)
        let limitMs = max(minLimitMs, min(preferred, fitting))
        let slackMs = usableMs - missionCount * limitMs - (missionCount - 1) * gapMs
        return Timing(limitMs: limitMs, bufferMs: bufferMs, gapMs: gapMs, slackMs: slackMs)
    }

    /// ゲーム時間から、制限時間・除外時間・最低間隔を決める（4回入らなければエラー）
    static func timing(_ durationMs: Int) throws -> Timing {
        let normal = layout(durationMs,
                            bufferMs: max(minBufferMs, jsRound(Double(durationMs) * 0.08)),
                            gapMs: max(minGapMs, jsRound(Double(durationMs) * 0.04)),
                            minLimitMs: normalMinLimitMs)
        if normal.slackMs >= 0 { return normal }
        let compact = layout(durationMs, bufferMs: minBufferMs, gapMs: compactGapMs, minLimitMs: minLimitMs)
        if compact.slackMs >= 0 { return compact }
        throw GameError.precondition("ゲーム時間が短すぎて、ミッションを4回入れられません")
    }

    /// 4回分のスケジュールを作る
    public static func generate(durationMs: Int, rng: Rng) throws -> [PlannedMission] {
        let t0 = try timing(durationMs)
        let parts = missionCount + 1
        let weights = (0..<parts).map { _ in -log(1 - rng() * 0.999999) } // 指数分布 → 正規化で一様な分割
        let total = weights.reduce(0, +)
        let shares = weights.map { Double(t0.slackMs) * (0.5 / Double(parts) + 0.5 * ($0 / total)) }
        var schedule: [PlannedMission] = []
        var t = Double(t0.bufferMs) + shares[0]
        for i in 0..<missionCount {
            schedule.append(PlannedMission(index: i + 1, offsetMs: jsRound(t), limitMs: t0.limitMs))
            t += Double(t0.limitMs + t0.gapMs) + shares[i + 1]
        }
        return schedule
    }
}

// MARK: - 目的地

public struct Destination: Codable, Equatable, Sendable {
    public var lat: Double
    public var lng: Double
    public var kind: String // "virtual"（エリア内に作った仮想の地点）/ "place"（施設・将来用）
    public var label: String

    public var latLng: LatLng { LatLng(lat: lat, lng: lng) }
}

public enum Destinations {
    public static let arrivalRadiusM = 20.0 // 目的地からこの距離以内で到達
    static let edgeMarginM = arrivalRadiusM + 10
    static let exclusionBufferM = arrivalRadiusM + 10
    static let walkSpeedMps = 1.2
    static let reachFactor = 0.5
    static let minDistanceM = 35.0
    static let maxDistanceCapM = 800.0
    static let maxTries = 300

    /// 制限時間から、目的地までの直線距離の範囲を決める（道のりの長さは考慮できない）
    public static func reachableRange(limitMs: Int) -> (min: Double, max: Double) {
        let maxD = min(maxDistanceCapM, max(minDistanceM + 10, (Double(limitMs) / 1000) * walkSpeedMps * reachFactor))
        return (minDistanceM, maxD)
    }

    /// 除外エリアに近すぎないか
    public static func isExcluded(_ point: LatLng, zones: [GeoCircle]) -> Bool {
        zones.contains { Geo.distanceM(point, $0.center) <= $0.radiusM + exclusionBufferM }
    }

    static func isAcceptable(_ point: LatLng, area: GeoCircle, zones: [GeoCircle], from: LatLng, range: (min: Double, max: Double)) -> Bool {
        if !GameArea.isInside(area, point, marginM: edgeMarginM) { return false }
        if isExcluded(point, zones: zones) { return false }
        let d = Geo.distanceM(from, point)
        return d >= range.min && d <= range.max
    }

    /// 目的地を1つ選ぶ（仮想目的地・APIキー不要）。見つからなければ nil
    public static func choose(from: LatLng, area: GeoCircle, zones: [GeoCircle], limitMs: Int, rng: Rng) -> Destination? {
        let range = reachableRange(limitMs: limitMs)
        for _ in 0..<maxTries {
            let d = sqrt(range.min * range.min + rng() * (range.max * range.max - range.min * range.min))
            let p = Geo.destinationPoint(from, distance: d, bearingDeg: rng() * 360)
            if isAcceptable(p, area: area, zones: zones, from: from, range: range) {
                return Destination(lat: p.lat, lng: p.lng, kind: "virtual", label: "チェックポイント")
            }
        }
        return nil
    }
}

// MARK: - ミッションの状態

public enum MissionStatus: String, Codable, Sendable {
    case pending // 挑戦中
    case success // 時間内に到達
    case failure // 時間切れ
    case cancelled // 無効（確保された・ゲーム終了・目的地を作れなかった）
}

public struct ScheduledMission: Codable, Equatable, Sendable {
    public var index: Int
    public var startsAt: Millis
    public var limitMs: Millis
}

public struct Participant: Codable, Equatable, Sendable {
    public var destination: Destination?
    public var result: MissionStatus
    public var resolvedAt: Millis?
    public var reason: String?
}

public struct ActiveMission: Codable, Equatable, Sendable {
    public var id: String
    public var index: Int
    public var startedAt: Millis
    public var endsAt: Millis
    public var arrivalRadiusM: Double
    public var participants: [String: Participant]
}

public struct MissionHistoryEntry: Codable, Equatable, Sendable {
    public var id: String
    public var index: Int
    public var startedAt: Millis
    public var endedAt: Millis
    public var endedBy: String? // "time_up"（制限時間まで行われた）/ "game_over"（ゲーム終了で打ち切り）
    public var results: [String: MissionStatus]
    public var skipped: Bool?
}

/// state.missions（内部用。発生時刻と目的地を含むので、そのまま鬼の端末に渡してはいけない）
public struct MissionState: Codable, Equatable, Sendable {
    public var schedule: [ScheduledMission]
    public var nextIndex: Int
    public var active: ActiveMission?
    public var history: [MissionHistoryEntry]
    public var rerollsUsed: [String: Bool]

    public static let empty = MissionState(schedule: [], nextIndex: 0, active: nil, history: [], rerollsUsed: [:])
}

public struct MissionCounts: Codable, Equatable, Sendable {
    public var success: Int
    public var failure: Int
    public var cancelled: Int
}

public enum MissionEvent: Equatable {
    case started(index: Int)
    case ended(index: Int, results: [String: MissionStatus])
}

public enum Missions {
    static let lateStartMinMs = 20_000 // 発生が遅れて、残りがこれ未満ならそのミッションは無効
    static let endMarginMs = 10_000 // ゲーム終了のこの時間前までにミッションを終える

    public static func create(schedule: [PlannedMission], startedAt: Millis) -> MissionState {
        var m = MissionState.empty
        m.schedule = schedule.map { ScheduledMission(index: $0.index, startsAt: startedAt + $0.offsetMs, limitMs: $0.limitMs) }
        return m
    }

    /// ミッション結果をプレイヤーに反映する（履歴に記録し、参加中の逃走者なら blurM を変える）
    /// 公開済みの可能性エリアは変えないので、鬼に見える円は「次の位置公開」から新しい大きさになる
    static func applyOutcome(_ player: Player, missionId: String, result: MissionResult, at: Millis) -> Player {
        var p = player
        p.missionHistory.append(MissionRecord(missionId: missionId, result: result, at: at))
        if player.isActiveRunner, let blur = player.blurM { p.blurM = BlurPolicy.after(blur, result: result) }
        return p
    }

    static func destinationFor(_ game: GameState, runnerId: String, limitMs: Int, rng: Rng) -> Destination? {
        guard let from = game.positions[runnerId]?.latLng, let area = game.area else { return nil }
        return Destinations.choose(from: from, area: area, zones: game.exclusionZones, limitMs: limitMs, rng: rng)
    }

    static func start(_ game: GameState, _ missions: MissionState, planned: ScheduledMission, now: Millis, rng: Rng)
        -> (missions: MissionState, started: ActiveMission?) {
        let endsAt = min(now + planned.limitMs, (game.endsAt ?? now) - endMarginMs)
        let id = "mission-\(planned.index)"
        var next = missions
        next.nextIndex += 1
        if endsAt - now < lateStartMinMs {
            next.history.append(MissionHistoryEntry(id: id, index: planned.index, startedAt: now, endedAt: now,
                                                    endedBy: nil, results: [:], skipped: true))
            return (next, nil)
        }
        var participants: [String: Participant] = [:]
        for runner in Players.activeRunners(game.players) {
            if let d = destinationFor(game, runnerId: runner.id, limitMs: endsAt - now, rng: rng) {
                participants[runner.id] = Participant(destination: d, result: .pending, resolvedAt: nil, reason: nil)
            } else {
                participants[runner.id] = Participant(destination: nil, result: .cancelled, resolvedAt: now, reason: "no_destination")
            }
        }
        let active = ActiveMission(id: id, index: planned.index, startedAt: now, endsAt: endsAt,
                                   arrivalRadiusM: Destinations.arrivalRadiusM, participants: participants)
        next.active = active
        return (next, active)
    }

    static func resolve(_ missions: MissionState, runnerId: String, result: MissionStatus, now: Millis, reason: String? = nil) -> MissionState {
        guard var active = missions.active, var p = active.participants[runnerId], p.result == .pending else { return missions }
        p.result = result
        p.resolvedAt = now
        p.reason = reason
        active.participants[runnerId] = p
        var next = missions
        next.active = active
        return next
    }

    /// 実位置で到達判定（挑戦中の人だけ）
    public static func checkArrivals(_ missions: MissionState, positions: [String: StoredPosition], now: Millis) -> MissionState {
        guard let active = missions.active, now <= active.endsAt else { return missions }
        var next = missions
        for (runnerId, p) in active.participants where p.result == .pending {
            if let pos = positions[runnerId]?.latLng, let d = p.destination,
               Geo.distanceM(pos, d.latLng) <= active.arrivalRadiusM {
                next = resolve(next, runnerId: runnerId, result: .success, now: now)
            }
        }
        return next
    }

    static func closeActive(_ missions: MissionState, now: Millis, pendingResult: MissionStatus, reason: String)
        -> (missions: MissionState, ended: (id: String, index: Int, results: [String: MissionStatus])) {
        var next = missions
        for runnerId in missions.active!.participants.keys {
            next = resolve(next, runnerId: runnerId, result: pendingResult, now: now, reason: reason)
        }
        let a = next.active!
        let results = a.participants.mapValues(\.result)
        next.active = nil
        next.history.append(MissionHistoryEntry(id: a.id, index: a.index, startedAt: a.startedAt, endedAt: now,
                                                endedBy: reason, results: results, skipped: nil))
        return (next, (a.id, a.index, results))
    }

    /// 確保された逃走者のミッションを無効にする
    public static func withdrawParticipant(_ missions: MissionState, runnerId: String, now: Millis) -> MissionState {
        guard missions.active != nil else { return missions }
        return resolve(missions, runnerId: runnerId, result: .cancelled, now: now, reason: "captured")
    }

    /// ゲーム終了時: 進行中のミッションを無効として終え、以降のミッションも発生させない
    public static func cancelAll(_ missions: MissionState, now: Millis) -> MissionState {
        var base = missions.active != nil ? closeActive(missions, now: now, pendingResult: .cancelled, reason: "game_over").missions : missions
        base.nextIndex = base.schedule.count
        return base
    }

    /// 目的地の変更をまだ使えるか（1ゲーム1回）
    public static func canReroll(_ missions: MissionState, runnerId: String) -> Bool {
        guard let p = missions.active?.participants[runnerId] else { return false }
        return p.result == .pending && missions.rerollsUsed[runnerId] != true
    }

    /// 目的地を作り直す（1ゲームにつき1回。変更した事実はログにもビューにも出さない）
    static func reroll(_ game: GameState, runnerId: String, now: Millis, rng: Rng) -> Result<MissionState, ActionFailure> {
        let missions = game.missions
        guard let active = missions.active, let p = active.participants[runnerId], p.result == .pending else {
            return .failure(.notInMission)
        }
        if missions.rerollsUsed[runnerId] == true { return .failure(.alreadyRerolled) }
        guard let destination = destinationFor(game, runnerId: runnerId, limitMs: active.endsAt - now, rng: rng)
            ?? destinationFor(game, runnerId: runnerId, limitMs: active.endsAt - active.startedAt, rng: rng) else {
            return .failure(.noDestination)
        }
        var next = missions
        next.rerollsUsed[runnerId] = true
        var q = p
        q.destination = destination
        next.active!.participants[runnerId] = q
        return .success(next)
    }

    /// ミッションを進める: 到達判定 → 時間切れ → 次のミッションの発生
    static func advance(_ game: GameState, now: Millis, rng: Rng) -> (missions: MissionState, players: [Player], events: [MissionEvent]) {
        var missions = checkArrivals(game.missions, positions: game.positions, now: now)
        var players = game.players
        var events: [MissionEvent] = []

        if let active = missions.active, now >= active.endsAt {
            let closed = closeActive(missions, now: now, pendingResult: .failure, reason: "time_up")
            missions = closed.missions
            events.append(.ended(index: closed.ended.index, results: closed.ended.results))
            players = players.map { pl in
                switch closed.ended.results[pl.id] {
                case .success: return applyOutcome(pl, missionId: closed.ended.id, result: .success, at: now)
                case .failure: return applyOutcome(pl, missionId: closed.ended.id, result: .failure, at: now)
                default: return pl
                }
            }
        }

        if missions.active == nil, missions.nextIndex < missions.schedule.count {
            let planned = missions.schedule[missions.nextIndex]
            if now >= planned.startsAt {
                var g = game
                g.missions = missions
                g.players = players
                let started = start(g, missions, planned: planned, now: now, rng: rng)
                missions = started.missions
                if started.started != nil { events.append(.started(index: planned.index)) }
            }
        }
        return (missions, players, events)
    }

    /// 結果の人数（鬼にも見せてよい集計）
    public static func summarize(_ results: [String: MissionStatus]) -> MissionCounts {
        var c = MissionCounts(success: 0, failure: 0, cancelled: 0)
        for r in results.values {
            switch r {
            case .success: c.success += 1
            case .failure: c.failure += 1
            default: c.cancelled += 1
            }
        }
        return c
    }
}
