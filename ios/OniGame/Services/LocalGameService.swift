// 端末内モード（開発モード）の GameService
//
// この端末の中で GameEngine を動かし、ダミーの友達（DummySimulator）で1台で動作確認するためのもの。
// Web 版の ?dev と同じく、地図をタップすると「今の視点のプレイヤー」が移動する（GPS は使わない）。
// オンライン対戦では使わない（オンラインの判定はすべてサーバーが行う）。

import Foundation
import Observation
import OniGameCore

@MainActor
@Observable
final class LocalGameService: GameService {
    let mode = BackendMode.local
    private(set) var state = GameState.initial()
    @ObservationIgnored private let simulator = DummySimulator()
    @ObservationIgnored private var simulatorTask: Task<Void, Never>?
    /// 人が操作しているプレイヤー（ダミーのシミュレーターは動かさない）。開発用の視点切り替えで変わる
    @ObservationIgnored var controlledId: () -> String? = { nil }

    var session: Session {
        guard let room = state.room else { return .empty }
        return Session(
            phase: state.phase,
            roomCode: room.code,
            selfId: state.selfId,
            isHost: room.hostId == state.selfId,
            settings: state.settings,
            area: state.area,
            exclusionZones: state.exclusionZones,
            players: state.players.map { LobbyPlayer(id: $0.id, name: $0.name, isHost: $0.isHost, isDummy: $0.isDummy, online: nil) },
            hasResult: state.resultSummary != nil,
            closed: false
        )
    }

    func now() -> Millis { nowMillis() }

    func view(viewerId: String?, now: Millis) -> PlayerView? {
        guard let id = viewerId ?? state.selfId else { return nil }
        return ViewChannels.view(of: state, viewerId: id, now: now)
    }

    func resultView(viewerId: String?) -> ResultView? {
        guard let id = viewerId ?? state.selfId else { return nil }
        return ResultSummaries.view(state.resultSummary, viewerId: id)
    }

    // MARK: ルーム（ダミーの部屋）

    func createRoom(hostName: String, draft: GameDraft) async throws {
        let selfId = Random.id()
        var s = try applied(draft, to: .initial())
        s = GameEngine.enterLobby(s, room: RoomInfo(code: Random.joinCode(), hostId: selfId), selfId: selfId,
                                  players: [Player(id: selfId, name: hostName, isHost: true)])
        state = s
    }

    func joinRoom(code: String, name: String) async throws {
        throw GameError.precondition("ルームへの参加はオンラインモード（Firebase）で使えます。端末内モードでは使えません")
    }

    func addDummyPlayer() throws {
        guard state.room != nil else { throw GameError.precondition("ルームがありません") }
        state.players.append(Dummies.makePlayer(index: state.players.count))
    }

    func leaveRoom() async {
        stopSimulator()
        state = .initial()
    }

    // MARK: ロビー・もう一度遊ぶ

    private func applied(_ draft: GameDraft, to base: GameState) throws -> GameState {
        guard let start = draft.startPoint else { throw GameError.precondition("ゲーム開始地点を設定してください") }
        var s = GameEngine.updateSettings(base, draft.settings)
        s = try GameEngine.setStartPoint(s, start)
        s = GameEngine.clearExclusionZones(s)
        for z in draft.exclusionZones { s = GameEngine.addExclusionZone(s, z) }
        return s
    }

    func configureGame(_ draft: GameDraft) async throws {
        state = try GameEngine.returnToLobby(applied(draft, to: state))
    }

    func prepareRematch() async throws {
        stopSimulator()
        state = try GameEngine.prepareRematch(state)
    }

    func startGame() async throws {
        guard let area = state.area else { throw GameError.precondition("ゲーム開始地点が設定されていません") }
        let needed = state.settings.hunterCount + 1
        guard state.players.count >= needed else {
            throw GameError.precondition("鬼\(state.settings.hunterCount)人＋逃走者1人以上、あと\(needed - state.players.count)人必要です")
        }
        // ダミーはエリア内に仮配置、自分は開始地点にいるものとする（地図タップで動かす）
        let positions = Dummies.initialPositions(state.players, area: area, selfPosition: nil)
        state = try GameEngine.startGame(state, initialPositions: positions, ctx: EngineContext(now: nowMillis())).state
        startSimulator()
    }

    // MARK: ゲーム中

    func reportPosition(playerId: String, position: OwnPosition) {
        commit(GameEngine.updatePosition(state, playerId: playerId, pos: position.latLng, accuracyM: position.accuracyM,
                                         ctx: EngineContext(now: nowMillis())))
    }

    func requestCapture(hunterId: String?) async -> ActionResult {
        guard let id = hunterId ?? state.selfId else { return ActionResult(ok: false, reason: CaptureFailure.notHunter.rawValue) }
        return commit(GameEngine.requestCapture(state, hunterId: id, ctx: EngineContext(now: nowMillis()))) ?? ActionResult(ok: false)
    }

    func requestNewDestination(runnerId: String?) async -> ActionResult {
        guard let id = runnerId ?? state.selfId else { return ActionResult(ok: false) }
        return commit(GameEngine.changeDestination(state, runnerId: id, ctx: EngineContext(now: nowMillis()))) ?? ActionResult(ok: false)
    }

    func abortGame() async throws {
        commit(GameEngine.abort(state, ctx: EngineContext(now: nowMillis())))
    }

    func tick() {
        commit(GameEngine.advance(state, ctx: EngineContext(now: nowMillis())))
    }

    /// 状態が変わったときだけ保存する（変わらないのに保存すると画面が何度も描き直される）
    @discardableResult
    private func commit(_ step: EngineStep) -> ActionResult? {
        if step.state != state { state = step.state }
        if state.phase != .playing { stopSimulator() }
        return step.result
    }

    // MARK: ダミー（ほかの端末の代わり）

    private func startSimulator() {
        stopSimulator()
        simulatorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, !Task.isCancelled else { return }
                let now = nowMillis()
                for action in self.simulator.step(self.state, controlledId: self.controlledId() ?? self.state.selfId, now: now, dt: 1) {
                    switch action {
                    case let .move(playerId, to):
                        self.commit(GameEngine.updatePosition(self.state, playerId: playerId, pos: to, ctx: EngineContext(now: now)))
                    case let .capture(hunterId):
                        self.commit(GameEngine.requestCapture(self.state, hunterId: hunterId, ctx: EngineContext(now: now)))
                    }
                }
            }
        }
    }

    private func stopSimulator() {
        simulatorTask?.cancel()
        simulatorTask = nil
    }
}
