// 乱数（oni-game/js/utils/random.js の移植）
// Rng は「0以上1未満の数を返す関数」。テストや JS との一致確認のために、シード付き乱数も作れる。
// シード付き乱数（mulberry32）とハッシュ（FNV-1a）は JS 版とビット単位で同じ結果になる。

import Foundation

public typealias Rng = () -> Double

public enum Random {
    /// シード付き乱数（mulberry32）。同じシードなら JS 版と同じ乱数列になる
    public static func seeded(_ seed: UInt32) -> Rng {
        var a = seed
        return {
            a = a &+ 0x6D2B_79F5
            var t = a
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    /// 暗号学的に安全な 0以上1未満の数（秘密の値・役割・ミッションの予定に使う）
    public static func secure() -> Double {
        var g = SystemRandomNumberGenerator() // OS の暗号学的乱数（iOS では SecRandom と同等）
        return Double(g.next() as UInt32) / 4_294_967_296
    }

    /// 普通の乱数（ダミーの動きなど、推測されても困らないもの）
    public static func standard() -> Double {
        Double.random(in: 0..<1)
    }

    /// 複数の値から 32bit のシードを作る（FNV-1a）。parts は JS の join('|') と同じ文字列にする
    public static func hashToSeed(_ parts: [String]) -> UInt32 {
        var h: UInt32 = 0x811C_9DC5
        for unit in parts.joined(separator: "|").utf16 {
            h ^= UInt32(unit)
            h = h &* 0x0100_0193
        }
        return h
    }

    /// 元の配列を変更せずにシャッフルした配列（Fisher–Yates。JS 版と同じ順番で乱数を使う）
    public static func shuffle<T>(_ items: [T], _ rng: Rng) -> [T] {
        var a = items
        var i = a.count - 1
        while i > 0 {
            let j = Int(floor(rng() * Double(i + 1)))
            a.swapAt(i, j)
            i -= 1
        }
        return a
    }

    /// 推測されにくいID（英数字）
    public static func id(length: Int = 16) -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        var g = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in chars[Int(g.next() as UInt8) % chars.count] })
    }

    /// 4桁の数字の参加コード
    public static func joinCode(_ rng: Rng = standard) -> String {
        String(format: "%04d", Int(floor(rng() * 10_000)))
    }
}

/// JS の数値を文字列にしたときと同じ表記（整数なら小数点なし）。hashToSeed の入力に使う
func jsNumber(_ v: Double) -> String {
    if v == v.rounded(), abs(v) < 1e15 { return String(Int64(v)) }
    return String(v)
}

func jsNumber(_ v: Int) -> String { String(v) }
