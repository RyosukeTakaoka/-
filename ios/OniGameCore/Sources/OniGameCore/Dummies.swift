// 開発用のダミー（oni-game/js/dev/dummyData.js・dummySimulator.js の移植）
// 1台の端末でゲームの流れを確認するためのもの。端末内モード（開発モード）だけで使う。
//
// シミュレーターは「ほかの端末の代わり」なので、ゲーム側と同じ操作（位置の更新・確保）だけを使う。
// ダミーの鬼が追いかける先も、本物の鬼と同じく自分のビュー（逃走者の可能性エリア）だけから決める。

import Foundation

public enum Dummies {
    static let names = ["たろう", "はなこ", "けんた", "さくら", "ゆうと", "みお", "そうた", "あおい", "りく", "ひなた"]

    /// 開始地点が決まっていないときの既定の地図中心（東京駅付近）
    public static let defaultCenter = LatLng(lat: 35.681236, lng: 139.767125)

    public static func makePlayer(index: Int) -> Player {
        Player(id: "dummy-\(Random.id(length: 8))", name: "\(names[index % names.count])(仮)", isDummy: true)
    }

    /// ゲーム開始時の実位置: ダミーはエリア内のランダムな地点、それ以外は selfPosition（なければ開始地点）
    public static func initialPositions(_ players: [Player], area: GeoCircle, selfPosition: LatLng?, rng: Rng = Random.standard) -> [String: LatLng] {
        var positions: [String: LatLng] = [:]
        for p in players {
            positions[p.id] = p.isDummy
                ? GameArea.randomPoint(in: area, rng: rng, marginM: area.radiusM * 0.1)
                : (selfPosition ?? area.center)
        }
        return positions
    }
}

/// ダミーの動きをまねる（1秒ごとに step を呼ぶ）
public final class DummySimulator {
    public static let hunterSpeedMps = 3.0 // 鬼の速さ（小走り）
    public static let runnerSpeedMps = 2.0 // 逃走者の速さ
    public static let missionAttemptRate = 0.7 // ミッションに挑戦する割合（成功・失敗の両方を確認できるように）

    public enum Action: Equatable {
        case move(playerId: String, to: LatLng)
        case capture(hunterId: String)
    }

    private var headings: [String: Double] = [:]
    private var attempts: [String: Bool] = [:]
    private let rng: Rng

    public init(rng: @escaping Rng = Random.standard) {
        self.rng = rng
    }

    /// 次の1歩で行う操作。controlledId は人が操作しているプレイヤー（動かさない）
    public func step(_ state: GameState, controlledId: String?, now: Millis, dt: Double) -> [Action] {
        guard state.phase == .playing, let area = state.area else { return [] }
        let dummies = state.players.filter {
            $0.isDummy && $0.status == .active && $0.id != controlledId && state.positions[$0.id] != nil
        }
        var actions: [Action] = []
        for p in dummies {
            let pos = state.positions[p.id]!.latLng
            let heading: Double
            if p.role == .hunter {
                heading = chaseHeading(state, hunterId: p.id, pos: pos, now: now) ?? wander(p.id, pos: pos, area: area)
            } else {
                heading = missionHeading(state, runnerId: p.id, pos: pos, now: now) ?? wander(p.id, pos: pos, area: area)
            }
            let speed = p.role == .hunter ? Self.hunterSpeedMps : Self.runnerSpeedMps
            actions.append(.move(playerId: p.id, to: Geo.destinationPoint(pos, distance: speed * dt, bearingDeg: heading)))
        }
        for p in dummies where p.role == .hunter { actions.append(.capture(hunterId: p.id)) }
        return actions
    }

    /// 一番近い可能性エリアの方へ向かう（エリアの中に入ったら、その中を探し回る）
    func chaseHeading(_ state: GameState, hunterId: String, pos: LatLng, now: Millis) -> Double? {
        guard let view = ViewChannels.view(of: state, viewerId: hunterId, now: now) else { return nil }
        var best: (d: Double, area: AreaDisplay)?
        for other in view.others {
            guard case let .area(a) = other.display else { continue }
            let d = Geo.distanceM(pos, a.center)
            if best == nil || d < best!.d { best = (d, a) }
        }
        guard let target = best, target.d >= target.area.radiusM * 0.5 else { return nil }
        return Geo.bearingDeg(pos, target.area.center)
    }

    /// ミッション中なら（挑戦すると決めた場合）自分の目的地へ向かう。目的地は本人のビューから読む
    func missionHeading(_ state: GameState, runnerId: String, pos: LatLng, now: Millis) -> Double? {
        guard let mission = ViewChannels.view(of: state, viewerId: runnerId, now: now)?.me?.mission,
              let destination = mission.destination else { return nil }
        let key = "\(runnerId):\(mission.index)"
        if attempts[key] == nil { attempts[key] = rng() < Self.missionAttemptRate }
        return attempts[key]! ? Geo.bearingDeg(pos, destination.latLng) : nil
    }

    /// ふらふら歩く。エリアの端に近づいたら中心へ戻る
    func wander(_ id: String, pos: LatLng, area: GeoCircle) -> Double {
        var h = headings[id] ?? rng() * 360
        h += (rng() - 0.5) * 60
        if Geo.distanceM(area.center, pos) > area.radiusM * 0.85 { h = Geo.bearingDeg(pos, area.center) }
        headings[id] = h
        return h
    }
}
