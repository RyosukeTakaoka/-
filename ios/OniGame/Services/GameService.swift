// 画面とゲームの間の窓口（oni-game/js/services/gameService.js と同じ考え方）
//
// 画面はゲームの状態や Supabase を直接触らず、ここだけを使う。
//   - 読み取り: session（ロビー情報）/ view(...)（その人に見せてよいビュー）/ resultView(...)
//   - 操作: すべて「要求」。最終的な判定は実装側（端末内なら GameEngine、オンラインならサーバー）が行う
// 実装は2つ:
//   - LocalGameService    … 端末内モード（開発モード）。この端末で GameEngine を動かし、ダミーの友達で確認する
//   - SupabaseGameService … オンライン対戦。判定はすべて Edge Functions。端末は読めるデータだけを受け取る

import Foundation
import OniGameCore

/// ロビー・作成画面で使う情報（位置情報・秘密値・ミッション予定は含めない）
struct Session: Equatable {
    var phase: GamePhase?
    var roomCode: String?
    var selfId: String?
    var isHost: Bool
    var settings: GameSettings
    var area: GeoCircle?
    var exclusionZones: [GeoCircle]
    var players: [LobbyPlayer]
    var hasResult: Bool
    var closed: Bool // ホストが部屋を解散した・部屋から外された

    static let empty = Session(phase: nil, roomCode: nil, selfId: nil, isHost: false, settings: .default, area: nil,
                               exclusionZones: [], players: [], hasResult: false, closed: false)

    var inRoom: Bool { roomCode != nil }
}

struct LobbyPlayer: Equatable, Identifiable {
    var id: String
    var name: String
    var isHost: Bool
    var isDummy: Bool
    var online: Bool? // オンライン版だけ（在席は目安。切断の反映には時間がかかることがある）
}

/// 作成画面で決める内容（部屋を作る・もう一度遊ぶときに送る）
struct GameDraft: Equatable {
    var settings: GameSettings = .default
    var startPoint: LatLng?
    var exclusionZones: [LatLng] = [] // 除外エリアの中心（半径は 30m 固定）

    var area: GeoCircle? {
        startPoint.map { GeoCircle(center: $0, radiusM: Double(settings.radiusM)) }
    }
}

@MainActor
protocol GameService: AnyObject {
    var mode: BackendMode { get }
    var session: Session { get }

    /// 現在時刻（オンラインではサーバー時刻に合わせる。表示だけに使い、判定には使わない）
    func now() -> Millis
    /// viewerId の人のビュー（端末内モードの開発用の視点切り替えのため viewerId を受け取る）
    func view(viewerId: String?, now: Millis) -> PlayerView?
    func resultView(viewerId: String?) -> ResultView?

    // ---- ルーム ----
    func createRoom(hostName: String, draft: GameDraft) async throws
    func joinRoom(code: String, name: String) async throws
    func addDummyPlayer() throws
    func leaveRoom() async

    // ---- ロビー・もう一度遊ぶ ----
    func configureGame(_ draft: GameDraft) async throws
    func prepareRematch() async throws
    func startGame() async throws

    // ---- ゲーム中 ----
    func reportPosition(playerId: String, position: OwnPosition)
    func requestCapture(hunterId: String?) async -> ActionResult
    func requestNewDestination(runnerId: String?) async -> ActionResult
    func abortGame() async throws
    /// 時間を進める（端末内モードだけ。オンラインではサーバーが進めるので何もしない）
    func tick()
}

func nowMillis() -> Millis {
    Millis(Date().timeIntervalSince1970 * 1000)
}
