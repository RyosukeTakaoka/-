// ゲームの状態（oni-game/js/game/gameEngine.js の initialState と同じ形）
//
// 実位置（positions）・秘密の値（privacy）・ミッションの予定と目的地（missions）は内部用。
// 画面には ViewChannels で「その人に見せてよい情報」だけを渡す。
// JSON にしたときの形は JS 版と同じ（端末内モードの状態を JS 版と比べるテストに使う）。

public enum GamePhase: String, Codable, Sendable {
    case setup // ゲーム作成・設定中
    case lobby // ルームで友達を待っている
    case playing // ゲーム中
    case finished // 決着
}

/// 実位置（ゲーム中のみ）
public struct StoredPosition: Codable, Equatable, Sendable {
    public var lat: Double
    public var lng: Double
    public var accuracyM: Double?
    public var updatedAt: Millis

    public var latLng: LatLng { LatLng(lat: lat, lng: lng) }
}

public struct RoomInfo: Codable, Equatable, Sendable {
    public var code: String
    public var hostId: String

    public init(code: String, hostId: String) {
        self.code = code
        self.hostId = hostId
    }
}

public struct GameResult: Codable, Equatable, Sendable {
    public var winner: Winner? // 途中終了なら nil（勝敗なし）
    public var reason: FinishReason
    public var finishedAt: Millis
}

/// ログ（位置情報は含めない）。type: start / capture / reveal / mission_start / mission_end / finish
public struct LogEntry: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var at: Millis
    public var type: String
    public var text: String
    public var playerId: String?
}

public struct GameState: Codable, Equatable, Sendable {
    public var phase: GamePhase
    public var gameId: String?
    public var settings: GameSettings
    public var startPoint: LatLng?
    public var area: GeoCircle?
    public var exclusionZones: [GeoCircle]
    public var room: RoomInfo?
    public var selfId: String?
    public var players: [Player]
    public var positions: [String: StoredPosition]
    public var privacy: PrivacyState
    public var captureAttempts: [String: Millis]
    public var missions: MissionState
    public var startedAt: Millis?
    public var endsAt: Millis?
    public var result: GameResult?
    public var resultSummary: ResultSummary?
    public var log: [LogEntry]

    public static func initial() -> GameState {
        GameState(phase: .setup, gameId: nil, settings: .default, startPoint: nil, area: nil, exclusionZones: [],
                  room: nil, selfId: nil, players: [], positions: [:], privacy: .empty, captureAttempts: [:],
                  missions: .empty, startedAt: nil, endsAt: nil, result: nil, resultSummary: nil, log: [])
    }
}
