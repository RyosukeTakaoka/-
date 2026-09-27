// JS 版（oni-game/js/game）と Swift 版のエンジンが同じ結果になることの確認
//
// Fixtures/golden.json は scripts/make-golden.mjs が JS 版で作ったもの。
// 同じ設定・同じシードの乱数・同じ操作を Swift 版で行い、各ステップで次のものを比べる:
//   状態（実位置・秘密値・可能性エリア・ミッション・結果まで全部）/ 増えたログ / 操作の結果 / nextDueAt /
//   チャンネル（buildChannels）/ 全員分のビュー（readable → assemble）

import XCTest
@testable import OniGameCore

struct GoldenFixture: Decodable {
    struct Position: Decodable {
        var lat: Double
        var lng: Double
        var accuracyM: Double?
    }

    struct Action: Decodable {
        var type: String
        var now: Millis
        var initialPositions: [String: LatLng]?
        var playerId: String?
        var pos: Position?
        var hunterId: String?
        var runnerId: String?
    }

    struct Step: Decodable {
        var action: Action
        var state: JSONValue
        var events: JSONValue
        var result: JSONValue?
        var nextDueAt: Millis?
        var channels: JSONValue?
        var views: [String: JSONValue]?
    }

    struct Scenario: Decodable {
        var name: String
        var seed: UInt32
        var start: LatLng
        var settings: GameSettings
        var players: [String]
        var exclusion: [LatLng]
        var lobby: JSONValue
        var steps: [Step]
    }

    var scenarios: [Scenario]

    static func load() throws -> GoldenFixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "golden", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(GoldenFixture.self, from: Data(contentsOf: url))
    }
}

/// PlayerView を JS 版 assembleView と同じ形の JSON にする（比較用）
func jsShape(_ v: PlayerView) throws -> JSONValue {
    func info(_ p: PublicPlayer) throws -> [String: JSONValue] {
        guard case let .object(o) = try JSONValue.of(p) else { return [:] }
        return o
    }
    func display(_ d: Display) throws -> JSONValue {
        switch d {
        case .hidden: return .object(["kind": .string("hidden")])
        case let .exact(p): return .object(["kind": .string("exact"), "position": try JSONValue.of(p)])
        case let .area(a): return try JSONValue.of(a)
        }
    }
    var me: JSONValue = .null
    if let s = v.me {
        var o = try info(s.player)
        o["position"] = s.position.map { .object(["lat": .number($0.lat), "lng": .number($0.lng), "accuracyM": $0.accuracyM.map(JSONValue.number) ?? .null]) } ?? .null
        o["outOfArea"] = .bool(s.outOfArea)
        o["captureReadyAt"] = .number(Double(s.captureReadyAt))
        o["blurM"] = s.blurM.map(JSONValue.number) ?? .null
        o["possibleArea"] = try s.possibleArea.map(JSONValue.of) ?? .null
        o["mission"] = try s.mission.map(JSONValue.of) ?? .null
        o["missionHistory"] = try JSONValue.of(s.missionHistory)
        me = .object(o)
    }
    let others: [JSONValue] = try v.others.map { other in
        var o = try info(other.player)
        o["display"] = try display(other.display)
        return .object(o)
    }
    return .object([
        "phase": .string(v.phase.rawValue),
        "now": .number(Double(v.now)),
        "area": try v.area.map(JSONValue.of) ?? .null,
        "exclusionZones": try JSONValue.of(v.exclusionZones),
        "settings": try JSONValue.of(v.settings),
        "startedAt": v.startedAt.map { .number(Double($0)) } ?? .null,
        "endsAt": v.endsAt.map { .number(Double($0)) } ?? .null,
        "nextRevealAt": v.nextRevealAt.map { .number(Double($0)) } ?? .null,
        "result": try v.result.map(JSONValue.of) ?? .null,
        "mission": try v.mission.map(JSONValue.of) ?? .null,
        "missionsCompleted": .number(Double(v.missionsCompleted)),
        "lastMission": try v.lastMission.map(JSONValue.of) ?? .null,
        "self": me,
        "others": .array(others),
        "runnersRemaining": .number(Double(v.runnersRemaining)),
        "runnersTotal": .number(Double(v.runnersTotal)),
        "log": try JSONValue.of(v.log),
    ])
}

final class GoldenTests: XCTestCase {
    func testSwiftEngineMatchesJavaScriptEngine() throws {
        let fixture = try GoldenFixture.load()
        XCTAssertEqual(fixture.scenarios.count, 3)
        for sc in fixture.scenarios {
            try replay(sc)
        }
    }

    private func replay(_ sc: GoldenFixture.Scenario) throws {
        // ロビーまで（作成画面・ルームの操作）
        var state = GameState.initial()
        state = GameEngine.updateSettings(state, sc.settings)
        state = try GameEngine.setStartPoint(state, sc.start)
        for z in sc.exclusion { state = GameEngine.addExclusionZone(state, z) }
        state = GameEngine.enterLobby(
            state, room: RoomInfo(code: "1234", hostId: sc.players[0]), selfId: sc.players[0],
            players: sc.players.enumerated().map { i, id in Player(id: id, name: "プレイヤー\(i + 1)", isHost: i == 0) }
        )
        assertNoDiff(jsonDiff(sc.lobby, try JSONValue.of(state)), "\(sc.name) ロビー")

        let rng = EngineRandom(roles: Random.seeded(sc.seed), privacy: Random.seeded(sc.seed + 1),
                               schedule: Random.seeded(sc.seed + 2), destinations: Random.seeded(sc.seed + 3))
        let ctx = { (now: Millis) in EngineContext(now: now, rng: rng, newId: { "game-\(sc.name)" }) }

        for (i, step) in sc.steps.enumerated() {
            let a = step.action
            let label = "\(sc.name) #\(i) \(a.type)"
            let out: EngineStep
            switch a.type {
            case "start":
                out = try GameEngine.startGame(state, initialPositions: a.initialPositions ?? [:], ctx: ctx(a.now))
            case "advance":
                out = GameEngine.advance(state, ctx: ctx(a.now))
            case "updatePosition":
                let p = try XCTUnwrap(a.pos)
                out = GameEngine.updatePosition(state, playerId: a.playerId!, pos: LatLng(lat: p.lat, lng: p.lng), accuracyM: p.accuracyM, ctx: ctx(a.now))
            case "requestCapture":
                out = GameEngine.requestCapture(state, hunterId: a.hunterId!, ctx: ctx(a.now))
            case "claimArrival":
                out = GameEngine.claimArrival(state, runnerId: a.runnerId!, ctx: ctx(a.now))
            case "changeDestination":
                out = GameEngine.changeDestination(state, runnerId: a.runnerId!, ctx: ctx(a.now))
            case "abort":
                out = GameEngine.abort(state, ctx: ctx(a.now))
            default:
                XCTFail("知らない操作 \(a.type)")
                return
            }
            state = out.state

            var actual = try JSONValue.of(state)
            if step.state["log"] == nil { actual = actual.removing("log") } // ログを省いたステップ
            assertNoDiff(jsonDiff(step.state, actual), "\(label) 状態")
            assertNoDiff(jsonDiff(step.events, try JSONValue.of(out.events)), "\(label) ログ")
            assertNoDiff(jsonDiff(step.result ?? .null, try out.result.map(JSONValue.of) ?? .null), "\(label) 結果")
            XCTAssertEqual(GameEngine.nextDueAt(state), step.nextDueAt, "\(label) nextDueAt")

            if let expected = step.channels {
                assertNoDiff(jsonDiff(expected, try JSONValue.of(ViewChannels.build(state))), "\(label) チャンネル")
            }
            for (uid, expected) in step.views ?? [:] {
                let view = try XCTUnwrap(ViewChannels.view(of: state, viewerId: uid, now: a.now))
                assertNoDiff(jsonDiff(expected, try jsShape(view)), "\(label) \(uid) のビュー")
            }
            if testRun?.failureCount ?? 0 > 0 { return } // 最初にずれたステップで止める（後はすべてずれるため）
        }
    }

    private func assertNoDiff(_ diffs: [String], _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        if !diffs.isEmpty {
            XCTFail("\(label): \(diffs.count)件の違い\n" + diffs.prefix(10).joined(separator: "\n"), file: file, line: line)
        }
    }
}
