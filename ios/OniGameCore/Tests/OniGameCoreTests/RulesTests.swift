// ルールごとのテスト（JS 版 tests/ の主なものを Swift でも確認する）
import XCTest
@testable import OniGameCore

final class RulesTests: XCTestCase {
    let start = LatLng(lat: 35.0, lng: 139.0)

    /// 3人（p1 ホスト）でゲーム開始した状態。鬼は hunter、逃走者は runner1/runner2 に名前を付け直す
    func startedGame(settings: GameSettings = .default, positions: [String: LatLng]? = nil, now: Millis = 1_000_000) throws -> GameState {
        var s = GameEngine.updateSettings(.initial(), settings)
        s = try GameEngine.setStartPoint(s, start)
        s = GameEngine.enterLobby(s, room: RoomInfo(code: "0000", hostId: "p1"), selfId: "p1",
                                  players: ["p1", "p2", "p3"].map { Player(id: $0, name: $0, isHost: $0 == "p1") })
        let rng = EngineRandom(roles: Random.seeded(1), privacy: Random.seeded(2), schedule: Random.seeded(3), destinations: Random.seeded(4))
        let initial = positions ?? [
            "p1": Geo.destinationPoint(start, distance: 30, bearingDeg: 0),
            "p2": Geo.destinationPoint(start, distance: 30, bearingDeg: 120),
            "p3": Geo.destinationPoint(start, distance: 30, bearingDeg: 240),
        ]
        return try GameEngine.startGame(s, initialPositions: initial, ctx: EngineContext(now: now, rng: rng, newId: { "g" })).state
    }

    func testMulberry32AndFnvMatchJavaScript() {
        // node -e "import('./oni-game/js/utils/random.js').then(m=>{const r=m.createSeededRng(42);console.log(r(),r(),m.hashToSeed(1,-2,'a'))})"
        let r = Random.seeded(42)
        XCTAssertEqual(r(), 0.6011037519201636)
        XCTAssertEqual(r(), 0.44829055899754167)
        XCTAssertEqual(Random.hashToSeed(["1", "-2", "a"]), 1_392_491_304)
    }

    func testPossibleAreaAlwaysContainsTheRealPositionButIsNotCenteredOnIt() {
        let rng = Random.seeded(7)
        for _ in 0..<300 {
            let secret = PrivacyArea.createSecret(rng)
            let blur = BlurPolicy.levelsM[Int(rng() * Double(BlurPolicy.levelsM.count))]
            let pos = Geo.destinationPoint(start, distance: rng() * 2000, bearingDeg: rng() * 360)
            let area = PrivacyArea.compute(position: pos, blurM: blur, secret: secret, epoch: Int(rng() * 50), origin: start, previousCell: nil)
            let d = Geo.distanceM(pos, area.center)
            XCTAssertLessThanOrEqual(d, 0.9 * blur + 0.5, "実位置は円の中（中心から 0.9R 以内）")
            XCTAssertGreaterThanOrEqual(d, 0.1 * blur - 0.5, "中心と実位置は 0.1R 以上離れる")
        }
    }

    func testHunterSeesOnlyPossibleAreasAndRunnersSeeTeammates() throws {
        let s = try startedGame()
        let hunter = try XCTUnwrap(s.players.first { $0.role == .hunter })
        let runners = s.players.filter { $0.role == .runner }
        let hv = try XCTUnwrap(ViewChannels.view(of: s, viewerId: hunter.id, now: 1_000_000))
        for r in runners {
            let other = try XCTUnwrap(hv.others.first { $0.id == r.id })
            guard case let .area(a) = other.display else { return XCTFail("鬼には可能性エリアだけが見える") }
            XCTAssertNotEqual(a.center, s.positions[r.id]!.latLng)
        }
        // 鬼が読めるチャンネルに逃走者の実位置が無い
        let parts = try XCTUnwrap(ViewChannels.readable(ViewChannels.build(s), uid: hunter.id))
        XCTAssertNil(parts.runnerPositions)
        XCTAssertNil(parts.view?.mission)

        let rv = try XCTUnwrap(ViewChannels.view(of: s, viewerId: runners[0].id, now: 1_000_000))
        XCTAssertEqual(rv.others.first { $0.id == runners[1].id }?.display, .exact(s.positions[runners[1].id]!.latLng))
        XCTAssertNotNil(rv.me?.possibleArea, "逃走者は自分がどう見えているかを見られる")
        XCTAssertEqual(ViewChannels.readable(ViewChannels.build(s), uid: runners[0].id)?.possibleAreas, nil)
    }

    func testCaptureTakesNearestRunnerOnlyAndHasCooldown() throws {
        var s = try startedGame()
        let hunter = s.players.first { $0.role == .hunter }!.id
        let runners = s.players.filter { $0.role == .runner }.map(\.id)
        let ctx = EngineContext(now: 1_001_000)
        s = GameEngine.updatePosition(s, playerId: hunter, pos: start, ctx: ctx).state
        s = GameEngine.updatePosition(s, playerId: runners[0], pos: Geo.destinationPoint(start, distance: 8, bearingDeg: 0), ctx: ctx).state
        s = GameEngine.updatePosition(s, playerId: runners[1], pos: Geo.destinationPoint(start, distance: 4, bearingDeg: 90), ctx: ctx).state
        let r = GameEngine.requestCapture(s, hunterId: hunter, ctx: EngineContext(now: 1_002_000))
        XCTAssertEqual(r.result, ActionResult(ok: true, capturedId: runners[1]))
        XCTAssertEqual(r.state.players.first { $0.id == runners[1] }?.status, .caught)
        XCTAssertEqual(r.state.players.first { $0.id == runners[0] }?.status, .active, "1回で1人だけ")
        let again = GameEngine.requestCapture(r.state, hunterId: hunter, ctx: EngineContext(now: 1_003_000))
        XCTAssertEqual(again.result?.reason, "cooldown")
        let notHunter = GameEngine.requestCapture(r.state, hunterId: runners[0], ctx: EngineContext(now: 1_010_000))
        XCTAssertEqual(notHunter.result?.reason, "not_hunter")
    }

    func testAllCaughtEndsGameAndClearsLocationData() throws {
        var s = try startedGame()
        let hunter = s.players.first { $0.role == .hunter }!.id
        for (i, r) in s.players.filter({ $0.role == .runner }).enumerated() {
            let t = 1_010_000 + i * 5_000
            s = GameEngine.updatePosition(s, playerId: hunter, pos: start, ctx: EngineContext(now: t)).state
            s = GameEngine.updatePosition(s, playerId: r.id, pos: start, ctx: EngineContext(now: t)).state
            s = GameEngine.requestCapture(s, hunterId: hunter, ctx: EngineContext(now: t)).state
        }
        XCTAssertEqual(s.phase, .finished)
        XCTAssertEqual(s.result?.winner, .hunters)
        XCTAssertEqual(s.result?.reason, .allCaught)
        XCTAssertTrue(s.positions.isEmpty)
        XCTAssertTrue(s.privacy.secrets.isEmpty)
        XCTAssertTrue(s.missions.schedule.isEmpty)
        let summary = try XCTUnwrap(s.resultSummary)
        let text = String(data: try JSONEncoder().encode(summary), encoding: .utf8)!
        XCTAssertFalse(text.contains("\"lat\""), "結果に座標を含めない")
        let view = try XCTUnwrap(ResultSummaries.view(summary, viewerId: hunter))
        XCTAssertNil(view.summary.personal, "他人の個人結果を含めない")
    }

    func testBlurPolicyLevels() {
        XCTAssertEqual(BlurPolicy.after(300, result: .success), 400)
        XCTAssertEqual(BlurPolicy.after(300, result: .failure), 200)
        XCTAssertEqual(BlurPolicy.after(1000, result: .success), 1000)
        XCTAssertEqual(BlurPolicy.after(50, result: .failure), 50)
        var b = 300.0
        for _ in 0..<4 { b = BlurPolicy.after(b, result: .success) }
        XCTAssertEqual(b, 1000)
    }

    func testMissionScheduleFitsFourMissionsForEveryDuration() throws {
        for minutes in GameSettings.durationOptionsMin {
            let durationMs = minutes * 60_000
            for seed in 0..<50 {
                let schedule = try MissionSchedule.generate(durationMs: durationMs, rng: Random.seeded(UInt32(seed)))
                XCTAssertEqual(schedule.count, 4)
                for (a, b) in zip(schedule, schedule.dropFirst()) {
                    XCTAssertGreaterThanOrEqual(b.offsetMs, a.offsetMs + a.limitMs, "ミッションは重ならない")
                }
                XCTAssertLessThanOrEqual(schedule.last!.offsetMs + schedule.last!.limitMs, durationMs)
            }
        }
    }

    func testRematchKeepsRoomMembersAndSettingsOnly() throws {
        var s = try startedGame()
        s = GameEngine.abort(s, ctx: EngineContext(now: 1_100_000)).state
        let next = try GameEngine.prepareRematch(s)
        XCTAssertEqual(next.phase, .setup)
        XCTAssertEqual(next.room, s.room)
        XCTAssertEqual(next.players.map(\.id), s.players.map(\.id))
        XCTAssertTrue(next.players.allSatisfy { $0.role == nil })
        XCTAssertNil(next.startPoint)
        XCTAssertNil(next.resultSummary)
        XCTAssertThrowsError(try GameEngine.returnToLobby(next), "開始地点を設定し直すまでロビーに戻れない")
    }

    func testDummySimulatorOnlyUsesViewsAndMovesDummies() throws {
        var s = GameEngine.updateSettings(.initial(), .default)
        s = try GameEngine.setStartPoint(s, start)
        let me = Player(id: "me", name: "わたし", isHost: true)
        s = GameEngine.enterLobby(s, room: RoomInfo(code: "0000", hostId: "me"), selfId: "me",
                                  players: [me, Dummies.makePlayer(index: 0), Dummies.makePlayer(index: 1)])
        let positions = Dummies.initialPositions(s.players, area: s.area!, selfPosition: nil, rng: Random.seeded(9))
        s = try GameEngine.startGame(s, initialPositions: positions, ctx: EngineContext(now: 0)).state
        let sim = DummySimulator(rng: Random.seeded(10))
        let actions = sim.step(s, controlledId: "me", now: 1000, dt: 1)
        XCTAssertFalse(actions.contains { if case let .move(id, _) = $0 { return id == "me" } else { return false } }, "人が操作しているプレイヤーは動かさない")
        XCTAssertEqual(actions.filter { if case .move = $0 { return true } else { return false } }.count, 2)
    }
}
