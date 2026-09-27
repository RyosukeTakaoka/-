// 確保・勝敗・ぼかし精度・ゲームエリアのルール
// （oni-game/js/game/capture.js・outcome.js・blurPolicy.js・gameArea.js・gameTimer.js の移植）

import Foundation

// MARK: - ゲームエリア

public enum GameArea {
    public static func create(center: LatLng, radiusM: Double) throws -> GeoCircle {
        guard center.isValid else { throw GameError.precondition("ゲーム開始地点が正しくありません") }
        guard radiusM > 0 else { throw GameError.precondition("ゲーム半径が正しくありません") }
        return GeoCircle(center: center, radiusM: radiusM)
    }

    /// 点がエリア内か。marginM > 0 なら境界から内側に余裕を取る
    public static func isInside(_ area: GeoCircle, _ point: LatLng, marginM: Double = 0) -> Bool {
        Geo.distanceM(area.center, point) <= area.radiusM - marginM
    }

    /// エリア内の一様ランダムな点
    public static func randomPoint(in area: GeoCircle, rng: Rng, marginM: Double = 0) -> LatLng {
        let maxR = max(0, area.radiusM - marginM)
        let r = maxR * sqrt(rng())
        let bearing = rng() * 360
        return Geo.destinationPoint(area.center, distance: r, bearingDeg: bearing)
    }
}

// MARK: - 確保

public enum CaptureFailure: String, Codable, Sendable {
    case notPlaying = "not_playing"
    case notHunter = "not_hunter"
    case noPosition = "no_position"
    case cooldown
    case noTarget = "no_target"

    public var message: String {
        switch self {
        case .notPlaying: return "ゲーム中ではありません"
        case .notHunter: return "確保できるのは鬼だけです"
        case .noPosition: return "位置情報を取得できていません"
        case .cooldown: return "少し待ってからもう一度試してください"
        case .noTarget: return "確保できる距離に逃走者はいません"
        }
    }
}

public enum Capture {
    /// 確保操作のあと再操作できない時間（連打で「近くに誰かいるか」を探れないようにするため）
    public static let cooldownMs: Millis = 3000

    /// 鬼の確保範囲内にいる参加中の逃走者を、近い順に返す（内部処理用。画面には出さない）
    static func targets(_ state: GameState, hunterId: String) -> [(player: Player, distance: Double)] {
        guard let hunterPos = state.positions[hunterId]?.latLng else { return [] }
        return Players.activeRunners(state.players).enumerated()
            .compactMap { index, r -> (Player, Double, Int)? in
                guard let pos = state.positions[r.id]?.latLng else { return nil }
                return (r, Geo.distanceM(hunterPos, pos), index)
            }
            .filter { $0.1 <= Double(state.settings.captureRadiusM) }
            .sorted { ($0.1, $0.2) < ($1.1, $1.2) } // JS の安定ソートと同じ順（同じ距離なら元の順）
            .map { ($0.0, $0.1) }
    }

    /// 捕まった逃走者に確保を反映する
    static func apply(_ runner: Player, hunterId: String, zombieMode: Bool, now: Millis) -> Player {
        var p = runner
        p.caughtAt = now
        p.caughtBy = hunterId
        if zombieMode {
            p.role = .hunter
            p.status = .active
            p.blurM = nil
        } else {
            p.status = .caught
        }
        return p
    }

    enum Attempt {
        case failure(CaptureFailure)
        case success(capturedId: String, players: [Player])
    }

    static func attempt(_ state: GameState, hunterId: String, now: Millis) -> Attempt {
        guard state.phase == .playing else { return .failure(.notPlaying) }
        guard let hunter = state.players.first(where: { $0.id == hunterId }), hunter.isActiveHunter else {
            return .failure(.notHunter)
        }
        guard state.positions[hunterId] != nil else { return .failure(.noPosition) }
        if let last = state.captureAttempts[hunterId], now - last < cooldownMs { return .failure(.cooldown) }
        guard let target = targets(state, hunterId: hunterId).first else { return .failure(.noTarget) }
        let players = state.players.map { p -> Player in
            if p.id == target.player.id { return apply(p, hunterId: hunterId, zombieMode: state.settings.zombieMode, now: now) }
            if p.id == hunterId {
                var h = p
                h.captures += 1
                return h
            }
            return p
        }
        return .success(capturedId: target.player.id, players: players)
    }
}

// MARK: - 勝敗

public enum Winner: String, Codable, Sendable {
    case runners
    case hunters
}

public enum FinishReason: String, Codable, Sendable {
    case timeUp = "time_up" // 制限時間まで逃げ切った
    case allCaught = "all_caught" // 逃走者が全員捕まった
    case aborted // ホストが途中で終了した
}

public enum Outcome {
    /// 決着がついていれば (winner, reason)、まだなら nil。全員確保を先に判定する（同時なら鬼の勝ち）
    public static func judge(players: [Player], endsAt: Millis, now: Millis) -> (winner: Winner, reason: FinishReason)? {
        if Players.activeRunners(players).isEmpty { return (.hunters, .allCaught) }
        if now >= endsAt { return (.runners, .timeUp) }
        return nil
    }
}

// MARK: - ぼかし精度

/// ミッション結果による blurM の変化（blurPolicy.js）。段階: 50 / 100 / 150 / 200 / 300 / 400 / 500 / 750 / 1000 m
public enum BlurPolicy {
    public static let levelsM: [Double] = [50, 100, 150, 200, 300, 400, 500, 750, 1000]

    public static func levelIndex(_ blurM: Double) -> Int {
        var best = 0
        for i in 1..<levelsM.count where abs(levelsM[i] - blurM) < abs(levelsM[best] - blurM) { best = i }
        return best
    }

    public static func shift(_ blurM: Double, steps: Int) -> Double {
        levelsM[min(levelsM.count - 1, max(0, levelIndex(blurM) + steps))]
    }

    /// 成功 → 1段階大きく / 失敗 → 1段階小さく
    public static func after(_ blurM: Double, result: MissionResult) -> Double {
        guard blurM > 0 else { return blurM }
        return shift(blurM, steps: result == .success ? 1 : -1)
    }
}

// MARK: - 時計

public enum GameClock {
    public static func remainingMs(endsAt: Millis, now: Millis) -> Millis { max(0, endsAt - now) }

    /// 「09:58」形式
    public static func format(_ ms: Millis) -> String {
        let totalSec = Int(ceil(Double(ms) / 1000))
        return String(format: "%02d:%02d", totalSec / 60, totalSec % 60)
    }
}
