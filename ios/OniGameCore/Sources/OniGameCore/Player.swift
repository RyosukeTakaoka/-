// プレイヤーのデータと役割（oni-game/js/game/player.js の移植）
//
// Player には実際の位置を持たせない。実位置は GameState.positions に分けて持ち、
// 画面には ViewChannels が作る「見せてよい情報」だけを渡す。

import Foundation

public typealias Millis = Int

public enum Role: String, Codable, Sendable {
    case hunter // 鬼
    case runner // 逃走者

    public var label: String { self == .hunter ? "鬼" : "逃走者" }
}

public enum PlayerStatus: String, Codable, Sendable {
    case active // ゲームに参加中
    case caught // 確保されて脱落（増え鬼OFFのとき）
}

public enum MissionResult: String, Codable, Sendable {
    case success
    case failure
}

public struct MissionRecord: Codable, Equatable, Sendable {
    public var missionId: String
    public var result: MissionResult
    public var at: Millis
}

public struct Player: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var isHost: Bool
    public var isDummy: Bool
    public var role: Role?
    public var originalRole: Role? // 開始時の役割（増え鬼で鬼になっても残る）
    public var status: PlayerStatus
    public var caughtAt: Millis? // 確保された時刻（ms）
    public var caughtBy: String? // 確保した鬼のID
    public var captures: Int // 鬼として確保した人数
    public var blurM: Double? // 逃走者の現在の位置ぼかし精度
    public var missionHistory: [MissionRecord]

    public static let maxNameLength = 12

    public static func sanitizeName(_ name: String) -> String {
        let collapsed = name.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return String(collapsed.prefix(maxNameLength))
    }

    public init(id: String, name: String, isHost: Bool = false, isDummy: Bool = false) {
        self.id = id
        self.name = Player.sanitizeName(name)
        self.isHost = isHost
        self.isDummy = isDummy
        role = nil
        originalRole = nil
        status = .active
        caughtAt = nil
        caughtBy = nil
        captures = 0
        blurM = nil
        missionHistory = []
    }

    /// 1ゲームごとにリセットする項目を初期値に戻したもの
    func fresh() -> Player {
        Player(id: id, name: name, isHost: isHost, isDummy: isDummy)
    }

    public var isActiveRunner: Bool { role == .runner && status == .active }
    public var isActiveHunter: Bool { role == .hunter && status == .active }
}

public enum Players {
    /// 参加者の中からランダムに鬼を hunterCount 人選ぶ（逃走者は最低1人残す）
    public static func assignRoles(_ players: [Player], hunterCount: Int, rng: Rng) throws -> [Player] {
        guard players.count >= 2 else { throw GameError.precondition("2人以上必要です") }
        let count = min(max(1, hunterCount), players.count - 1)
        let hunterIds = Set(Random.shuffle(players.map(\.id), rng).prefix(count))
        return players.map { p in
            var q = p
            q.role = hunterIds.contains(p.id) ? .hunter : .runner
            return q
        }
    }

    /// ゲーム開始時の準備: 前回の状態を消し、役割と初期ぼかしを設定する
    public static func prepareForGame(_ players: [Player], settings: GameSettings, rng: Rng) throws -> [Player] {
        try assignRoles(players.map { $0.fresh() }, hunterCount: settings.hunterCount, rng: rng).map { p in
            var q = p
            q.originalRole = p.role
            q.blurM = p.role == .runner ? Double(settings.initialBlurM) : nil
            return q
        }
    }

    public static func activeRunners(_ players: [Player]) -> [Player] { players.filter(\.isActiveRunner) }
    public static func activeHunters(_ players: [Player]) -> [Player] { players.filter(\.isActiveHunter) }
    /// 開始時に逃走者だった人（増え鬼で鬼になった人も含む）
    public static func originalRunners(_ players: [Player]) -> [Player] { players.filter { $0.originalRole == .runner } }
}

/// ルール上できない操作（画面にはメッセージをそのまま出す）
public enum GameError: Error, Equatable, LocalizedError {
    case precondition(String)

    public var errorDescription: String? {
        switch self {
        case let .precondition(message): return message
        }
    }
}
