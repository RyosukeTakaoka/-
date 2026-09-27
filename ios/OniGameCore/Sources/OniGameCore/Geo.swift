// 緯度経度の距離・座標計算（oni-game/js/utils/distance.js の移植）
// 座標は LatLng（度）、距離はメートルで扱う。

import Foundation

/// 地点（緯度・経度）
public struct LatLng: Codable, Equatable, Hashable, Sendable {
    public var lat: Double
    public var lng: Double

    public init(lat: Double, lng: Double) {
        self.lat = lat
        self.lng = lng
    }

    /// 緯度経度として正しい値か
    public var isValid: Bool {
        lat.isFinite && lng.isFinite && abs(lat) <= 90 && abs(lng) <= 180
    }
}

/// 円（ゲームエリア・除外エリア・可能性エリアなど）。JSON では { center, radiusM }
public struct GeoCircle: Codable, Equatable, Sendable {
    public var center: LatLng
    public var radiusM: Double

    public init(center: LatLng, radiusM: Double) {
        self.center = center
        self.radiusM = radiusM
    }
}

public enum Geo {
    static let earthRadiusM = 6_371_000.0
    static let mPerDegLat = 110_574.0
    static let mPerDegLngAtEquator = 111_320.0

    static func toRad(_ deg: Double) -> Double { deg * Double.pi / 180 }
    static func toDeg(_ rad: Double) -> Double { rad * 180 / Double.pi }

    /// 2地点間の距離（メートル、ハバーサイン公式）
    public static func distanceM(_ a: LatLng, _ b: LatLng) -> Double {
        let dLat = toRad(b.lat - a.lat)
        let dLng = toRad(b.lng - a.lng)
        let h = pow(sin(dLat / 2), 2) + cos(toRad(a.lat)) * cos(toRad(b.lat)) * pow(sin(dLng / 2), 2)
        return 2 * earthRadiusM * asin(min(1, sqrt(h)))
    }

    /// origin から方位 bearingDeg（北=0, 東=90）へ distance メートル進んだ地点
    public static func destinationPoint(_ origin: LatLng, distance: Double, bearingDeg: Double) -> LatLng {
        let delta = distance / earthRadiusM
        let theta = toRad(bearingDeg)
        let phi1 = toRad(origin.lat)
        let lambda1 = toRad(origin.lng)
        let phi2 = asin(sin(phi1) * cos(delta) + cos(phi1) * sin(delta) * cos(theta))
        let lambda2 = lambda1 + atan2(sin(theta) * sin(delta) * cos(phi1), cos(delta) - sin(phi1) * sin(phi2))
        return LatLng(lat: toDeg(phi2), lng: jsRemainder(toDeg(lambda2) + 540, 360) - 180)
    }

    /// a から b への方位（度、北=0 時計回り）
    public static func bearingDeg(_ a: LatLng, _ b: LatLng) -> Double {
        let phi1 = toRad(a.lat)
        let phi2 = toRad(b.lat)
        let dLambda = toRad(b.lng - a.lng)
        let y = sin(dLambda) * cos(phi2)
        let x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLambda)
        return jsRemainder(toDeg(atan2(y, x)) + 360, 360)
    }

    /// origin を原点とした平面座標（東 = x, 北 = y、メートル）。ゲームエリア程度の範囲で使う近似
    public static func toLocalXY(origin: LatLng, _ p: LatLng) -> (x: Double, y: Double) {
        let cosLat = cos(toRad(origin.lat))
        return ((p.lng - origin.lng) * cosLat * mPerDegLngAtEquator, (p.lat - origin.lat) * mPerDegLat)
    }

    /// toLocalXY の逆変換
    public static func fromLocalXY(origin: LatLng, x: Double, y: Double) -> LatLng {
        let cosLat = cos(toRad(origin.lat))
        return LatLng(lat: origin.lat + y / mPerDegLat, lng: origin.lng + x / (cosLat * mPerDegLngAtEquator))
    }

    /// JavaScript の % と同じ（符号は割られる数に合わせる）
    static func jsRemainder(_ a: Double, _ b: Double) -> Double {
        a.truncatingRemainder(dividingBy: b)
    }

    /// 表示用に距離を「850m」「1.2km」のような文字列にする
    public static func formatDistance(_ meters: Double) -> String {
        if meters >= 1000 {
            let km = meters / 1000
            return km == km.rounded() ? "\(Int(km))km" : String(format: "%.1fkm", km)
        }
        return "\(Int(meters.rounded()))m"
    }
}
