// ゲーム設定の選択肢・初期値・検証（oni-game/js/game/settings.js の移植）

public struct GameSettings: Codable, Equatable, Sendable {
    public var durationMin: Int // ゲーム時間（分）
    public var radiusM: Int // ゲームエリア半径（m）
    public var initialBlurM: Int // 初期の位置情報ぼかし精度（m）
    public var hunterCount: Int // 鬼の人数
    public var captureRadiusM: Int // 鬼が逃走者を確保できる距離（m）
    public var zombieMode: Bool // 増え鬼: ON なら捕まった逃走者が鬼になる / OFF なら脱落
    public var revealIntervalSec: Int // 逃走者の可能性エリアが更新・公開される間隔（秒）
    public var showHuntersToRunners: Bool // 鬼の位置を逃走者（と脱落者）に見せるか

    public static let durationOptionsMin = [5, 10, 20, 30, 60]
    public static let radiusOptionsM = [100, 300, 500, 1000, 3000, 5000]
    public static let blurOptionsM = [50, 100, 300, 500, 1000]
    public static let captureRadiusOptionsM = [5, 10, 20, 30]
    public static let revealIntervalOptionsSec = [30, 60, 120, 180, 300]
    public static let minHunters = 1
    public static let maxHunters = 10

    public static let `default` = GameSettings(
        durationMin: 10, radiusM: 300, initialBlurM: 300, hunterCount: 1, captureRadiusM: 10,
        zombieMode: false, revealIntervalSec: 60, showHuntersToRunners: true
    )

    public init(durationMin: Int, radiusM: Int, initialBlurM: Int, hunterCount: Int, captureRadiusM: Int,
                zombieMode: Bool, revealIntervalSec: Int, showHuntersToRunners: Bool) {
        self.durationMin = durationMin
        self.radiusM = radiusM
        self.initialBlurM = initialBlurM
        self.hunterCount = hunterCount
        self.captureRadiusM = captureRadiusM
        self.zombieMode = zombieMode
        self.revealIntervalSec = revealIntervalSec
        self.showHuntersToRunners = showHuntersToRunners
    }

    /// 入力を検証して、正しい設定を返す（選択肢にない値は現在値のまま）
    public func sanitized() -> GameSettings {
        func pick(_ v: Int, _ options: [Int], _ fallback: Int) -> Int { options.contains(v) ? v : fallback }
        let d = GameSettings.default
        return GameSettings(
            durationMin: pick(durationMin, Self.durationOptionsMin, d.durationMin),
            radiusM: pick(radiusM, Self.radiusOptionsM, d.radiusM),
            initialBlurM: pick(initialBlurM, Self.blurOptionsM, d.initialBlurM),
            hunterCount: min(Self.maxHunters, max(Self.minHunters, hunterCount)),
            captureRadiusM: pick(captureRadiusM, Self.captureRadiusOptionsM, d.captureRadiusM),
            zombieMode: zombieMode,
            revealIntervalSec: pick(revealIntervalSec, Self.revealIntervalOptionsSec, d.revealIntervalSec),
            showHuntersToRunners: showHuntersToRunners
        )
    }

    /// 組み合わせのチェック。警告文の配列
    public var warnings: [String] {
        var w: [String] = []
        if initialBlurM > radiusM { w.append("ぼかし精度がゲームエリアより大きいため、鬼にはほぼ位置が分かりません") }
        return w
    }

    /// 「30秒」「2分」
    public static func formatInterval(_ sec: Int) -> String {
        sec < 60 ? "\(sec)秒" : "\(sec / 60)分"
    }
}
