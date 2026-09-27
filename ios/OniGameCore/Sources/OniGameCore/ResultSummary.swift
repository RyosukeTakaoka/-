// ゲーム結果のまとめ（oni-game/js/game/resultSummary.js の移植）
//
// 終了時点の状態から「ゲーム結果」だけを作る。位置情報は一切使わない。
// 含めないもの: GPS座標・移動履歴・可能性エリア・秘密値・目的地・ミッション達成時刻・誰が誰を確保したか・正確な確保時刻

public enum MissionSummaryStatus: String, Codable, Sendable {
    case completed // 制限時間まで行われた
    case endedByGameOver = "ended_by_game_over" // ゲーム終了で打ち切り（結果は無効）
    case notHeld = "not_held" // ゲームが先に終わって発生しなかった
    case skipped // 大きく遅れたため無効（通常は起きない）
}

public enum PersonalResult: String, Codable, Sendable {
    case success
    case failure
    case cancelled // 無効（確保された・ゲーム終了・目的地なし）
    case notParticipated = "not_participated" // 参加していない（鬼・すでに脱落）
}

public struct ResultPlayer: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var startRole: Role?
    public var finalRole: Role?
    public var roleChanged: Bool
    public var caught: Bool
    public var caughtAfterMin: Int? // 確保された時刻は「開始から何分台か」だけ
    public var captures: Int
    public var survived: Bool
}

public struct MissionSummary: Codable, Equatable, Sendable {
    public var index: Int
    public var status: MissionSummaryStatus
    public var success: Int
    public var failure: Int
    public var cancelled: Int
}

public struct PersonalMission: Codable, Equatable, Sendable {
    public var index: Int
    public var result: PersonalResult
}

public struct PersonalSummary: Codable, Equatable, Sendable {
    public var missions: [PersonalMission]
}

public struct ResultSummary: Codable, Equatable, Sendable {
    public var gameId: String?
    public var winner: Winner?
    public var reason: FinishReason
    public var headline: String
    public var durationMin: Int
    public var playedMs: Millis
    public var zombieMode: Bool
    public var players: [ResultPlayer]
    public var missions: [MissionSummary]
    public var personal: [String: PersonalSummary]? // 本人にだけ見せる（公開の結果には含めない）
}

/// 見る人に合わせた結果（他人の個人ミッション結果を除く）
public struct ResultView: Equatable, Sendable {
    public var summary: ResultSummary // personal は nil にしてある
    public var you: String
    public var own: PersonalSummary?
}

public enum ResultSummaries {
    public static func headline(winner: Winner?, reason: FinishReason) -> String {
        if reason == .timeUp && winner == .runners { return "時間切れ！逃走者の勝利" }
        if reason == .allCaught && winner == .hunters { return "全員確保！鬼の勝利" }
        if reason == .aborted { return "ホストがゲームを終了しました（勝敗なし）" }
        return "ゲーム終了"
    }

    static func counts(_ results: [String: MissionStatus]) -> (Int, Int, Int) {
        let c = Missions.summarize(results)
        return (c.success, c.failure, c.cancelled)
    }

    static func status(_ entry: MissionHistoryEntry?) -> MissionSummaryStatus {
        guard let e = entry else { return .notHeld }
        if e.skipped == true { return .skipped }
        if e.endedBy == "game_over" { return .endedByGameOver }
        return .completed
    }

    public static func build(_ state: GameState) -> ResultSummary? {
        guard let result = state.result else { return nil }
        let startedAt = state.startedAt ?? result.finishedAt
        let history = state.missions.history
        let entry = { (index: Int) in history.first { $0.index == index } }
        let indexes = Array(1...MissionSchedule.missionCount)

        let missions = indexes.map { index -> MissionSummary in
            let e = entry(index)
            let (s, f, c) = counts(e?.results ?? [:])
            return MissionSummary(index: index, status: status(e), success: s, failure: f, cancelled: c)
        }

        var personal: [String: PersonalSummary] = [:]
        for p in state.players {
            personal[p.id] = PersonalSummary(missions: indexes.map { index in
                let r = entry(index)?.results[p.id]
                let pr: PersonalResult
                switch r {
                case .success: pr = .success
                case .failure: pr = .failure
                case .none: pr = .notParticipated
                default: pr = .cancelled
                }
                return PersonalMission(index: index, result: pr)
            })
        }

        return ResultSummary(
            gameId: state.gameId,
            winner: result.winner,
            reason: result.reason,
            headline: headline(winner: result.winner, reason: result.reason),
            durationMin: state.settings.durationMin,
            playedMs: max(0, result.finishedAt - startedAt),
            zombieMode: state.settings.zombieMode,
            players: state.players.map { p in
                let caught = p.caughtAt != nil && p.originalRole == .runner
                return ResultPlayer(
                    id: p.id, name: p.name, startRole: p.originalRole, finalRole: p.role,
                    roleChanged: p.originalRole != p.role, caught: caught,
                    caughtAfterMin: caught ? Int(floor(Double(p.caughtAt! - startedAt) / 60_000)) : nil,
                    captures: p.captures,
                    survived: p.originalRole == .runner && p.role == .runner && p.status == .active
                )
            },
            missions: missions,
            personal: personal
        )
    }

    /// viewerId の人に見せる結果（他人の個人ミッション結果を除く）
    public static func view(_ summary: ResultSummary?, viewerId: String) -> ResultView? {
        guard var shared = summary else { return nil }
        let own = shared.personal?[viewerId]
        shared.personal = nil
        return ResultView(summary: shared, you: viewerId, own: own)
    }
}

import Foundation
