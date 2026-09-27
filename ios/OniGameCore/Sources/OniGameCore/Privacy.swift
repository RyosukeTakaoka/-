// 可能性エリア（「逃走者はこの円の中のどこかにいる」）の生成と公開スケジュール
// （oni-game/js/game/privacyArea.js と locationPublisher.js の移植。アルゴリズムの説明は JS 版のコメントを参照）
//
// ■ アルゴリズム（R = blurM）
//  1. 逃走者ごとの秘密の値で「回転・平行移動した一辺 0.9R のマス目」を作り、実位置が入るマスを求める
//     （前回のマスの中心から 0.65R 以内なら前回のマスを使い続ける）
//  2. マスの中心から、秘密のシード＋公開回数＋マスで決まる量（最大 0.25R）だけずらした点を円の中心にする
//  3. 半径は R
// 公開時点の実位置は必ず円の中（中心から最大 0.9R）にあり、中心とは 0.1R 以上離れる。
// この処理は実位置を使うので、実行するのは実位置を持つ側だけ（端末内モードの端末、オンラインではサーバー）。

import Foundation

public struct PrivacySecret: Codable, Equatable, Sendable {
    public var seed: Int
    public var gridAngle: Double // マス目の回転
    public var gridU: Double // マス目の原点のずれ（0〜1、マスの一辺に対する割合）
    public var gridV: Double
}

public struct PrivacyCell: Codable, Equatable, Sendable {
    public var i: Int
    public var j: Int
    public var radiusM: Double
}

/// 公開済みの可能性エリア（内部用。ビューには中心・半径・公開時刻だけが出る）
public struct PublishedArea: Codable, Equatable, Sendable {
    public var center: LatLng
    public var radiusM: Double
    public var epoch: Int
    public var publishedAt: Millis
}

/// state.privacy（内部用。鬼の端末には渡さない）
public struct PrivacyState: Codable, Equatable, Sendable {
    public var secrets: [String: PrivacySecret]
    public var cells: [String: PrivacyCell]
    public var published: [String: PublishedArea]
    public var epoch: Int // 最後に公開した公開回数

    public static let empty = PrivacyState(secrets: [:], cells: [:], published: [:], epoch: -1)
}

public enum PrivacyArea {
    public static let cellRatio = 0.9
    public static let jitterRatio = 0.25
    public static let keepCellRatio = 0.65
    public static let minOffsetRatio = 0.1
    static let maxAttempts = 16

    /// 逃走者ごとの秘密の値（ゲーム開始時に1回作る）
    public static func createSecret(_ rng: Rng) -> PrivacySecret {
        let seed = Int(floor(rng() * 4_294_967_296))
        let angle = rng() * (Double.pi / 2)
        let u = rng()
        let v = rng()
        return PrivacySecret(seed: seed, gridAngle: angle, gridU: u, gridV: v)
    }

    typealias XY = (x: Double, y: Double)

    static func rotate(_ p: XY, _ a: Double) -> XY {
        (p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a))
    }

    static func dist(_ a: XY, _ b: XY) -> Double { hypot(a.x - b.x, a.y - b.y) }

    static func toGrid(_ xy: XY, _ s: PrivacySecret, _ cellM: Double) -> XY {
        let r = rotate(xy, -s.gridAngle)
        return (r.x / cellM + s.gridU, r.y / cellM + s.gridV)
    }

    static func cellCenterXY(_ c: PrivacyCell, _ s: PrivacySecret, _ cellM: Double) -> XY {
        rotate(((Double(c.i) + 0.5 - s.gridU) * cellM, (Double(c.j) + 0.5 - s.gridV) * cellM), s.gridAngle)
    }

    static func chooseCell(_ p: XY, radiusM: Double, _ s: PrivacySecret, _ cellM: Double, previous: PrivacyCell?) -> PrivacyCell {
        if let prev = previous, prev.radiusM == radiusM {
            if dist(p, cellCenterXY(prev, s, cellM)) <= keepCellRatio * radiusM { return prev }
        }
        let g = toGrid(p, s, cellM)
        return PrivacyCell(i: Int(floor(g.x)), j: Int(floor(g.y)), radiusM: radiusM)
    }

    static func randomInDisk(_ rng: Rng, _ r: Double) -> XY {
        let d = r * sqrt(rng())
        let a = rng() * 2 * Double.pi
        return (d * cos(a), d * sin(a))
    }

    /// 可能性エリアを作る（同じ入力なら同じ結果）
    public static func compute(position: LatLng, blurM: Double, secret: PrivacySecret, epoch: Int,
                               origin: LatLng, previousCell: PrivacyCell?) -> (center: LatLng, radiusM: Double, cell: PrivacyCell) {
        precondition(blurM > 0, "blurM が正しくありません")
        let radiusM = blurM
        let cellM = cellRatio * radiusM
        let p = Geo.toLocalXY(origin: origin, position)
        let cell = chooseCell(p, radiusM: radiusM, secret, cellM, previous: previousCell)
        let q = cellCenterXY(cell, secret, cellM)
        let minOffset = minOffsetRatio * radiusM

        var c: XY?
        var attempt = 0
        while attempt < maxAttempts && c == nil {
            let rng = Random.seeded(Random.hashToSeed([
                jsNumber(secret.seed), jsNumber(epoch), jsNumber(cell.i), jsNumber(cell.j), jsNumber(radiusM), jsNumber(attempt),
            ]))
            let j = randomInDisk(rng, jitterRatio * radiusM)
            let candidate: XY = (q.x + j.x, q.y + j.y)
            if dist(p, candidate) >= minOffset { c = candidate }
            attempt += 1
        }
        if c == nil {
            // 念のための保険: 実位置から離れる向きにずらす
            let dd = dist(p, q)
            let d = dd == 0 ? 1 : dd
            let uxRaw = (q.x - p.x) / d
            let uyRaw = (q.y - p.y) / d
            let ux = (uxRaw == 0 || uxRaw.isNaN) ? 1 : uxRaw
            let uy = uyRaw.isNaN ? 0 : uyRaw
            c = (q.x + ux * jitterRatio * radiusM, q.y + uy * jitterRatio * radiusM)
        }
        return (Geo.fromLocalXY(origin: origin, x: c!.x, y: c!.y), radiusM, cell)
    }
}

/// 可能性エリアの公開スケジュール（locationPublisher.js）
public enum LocationPublisher {
    /// ゲーム開始時: 全員分の秘密の値を作る（増え鬼などで役割が変わっても使えるよう全員分）
    public static func initPrivacy(_ players: [Player], rng: Rng) -> PrivacyState {
        var s = PrivacyState.empty
        for p in players { s.secrets[p.id] = PrivacyArea.createSecret(rng) }
        return s
    }

    static func intervalMs(_ settings: GameSettings) -> Int { settings.revealIntervalSec * 1000 }

    /// 開始からの公開回数（0, 1, 2, ...）
    public static func revealEpoch(now: Millis, startedAt: Millis, settings: GameSettings) -> Int {
        max(0, Int(floor(Double(now - startedAt) / Double(intervalMs(settings)))))
    }

    /// 次に公開される時刻
    public static func nextRevealAt(now: Millis, startedAt: Millis, settings: GameSettings) -> Millis {
        startedAt + (revealEpoch(now: now, startedAt: startedAt, settings: settings) + 1) * intervalMs(settings)
    }

    static func publishOne(_ state: GameState, _ privacy: PrivacyState, _ runner: Player, epoch: Int, now: Millis) -> PrivacyState {
        guard let position = state.positions[runner.id]?.latLng,
              let secret = privacy.secrets[runner.id],
              let blurM = runner.blurM, blurM > 0,
              let area = state.area else { return privacy }
        let r = PrivacyArea.compute(position: position, blurM: blurM, secret: secret, epoch: epoch,
                                    origin: area.center, previousCell: privacy.cells[runner.id])
        var next = privacy
        next.cells[runner.id] = r.cell
        next.published[runner.id] = PublishedArea(center: r.center, radiusM: r.radiusM, epoch: epoch, publishedAt: now)
        return next
    }

    /// 公開タイミングなら全逃走者の可能性エリアを作り直す
    public static func publishIfDue(_ state: GameState, now: Millis) -> (privacy: PrivacyState, revealed: Bool) {
        guard let startedAt = state.startedAt else { return (state.privacy, false) }
        let epoch = revealEpoch(now: now, startedAt: startedAt, settings: state.settings)
        if epoch <= state.privacy.epoch { return (state.privacy, false) }
        var privacy = state.privacy
        privacy.published = [:]
        privacy.epoch = epoch
        for runner in Players.activeRunners(state.players) {
            privacy = publishOne(state, privacy, runner, epoch: epoch, now: now)
        }
        return (privacy, true)
    }

    /// まだ公開されていない逃走者（開始時に位置が無かった人）を公開する
    public static func publishMissing(_ state: GameState, now: Millis) -> PrivacyState {
        var privacy = state.privacy
        for runner in Players.activeRunners(state.players) where privacy.published[runner.id] == nil {
            privacy = publishOne(state, privacy, runner, epoch: privacy.epoch, now: now)
        }
        return privacy
    }

    /// 確保された逃走者の公開情報を消す
    public static func withdraw(_ privacy: PrivacyState, playerId: String) -> PrivacyState {
        var next = privacy
        next.published[playerId] = nil
        next.cells[playerId] = nil
        return next
    }
}
