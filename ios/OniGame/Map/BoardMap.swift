// 地図（ゲームボード）。Web 版の Google Maps / 簡易マップの代わりに、iOS 標準の MapKit を使う（APIキー不要）
// 「何をどう描くか」は MapLayers.swift で PlayerView（見せてよい情報）から作り、ここは描くだけ。

import SwiftUI
import MapKit
import OniGameCore

extension LatLng {
    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
}

/// 円の見た目（Web 版 markers.js の CIRCLE_STYLE）
struct CircleStyle: Equatable {
    var stroke: Color
    var fill: Color
    var fillOpacity: Double
    var lineWidth: CGFloat

    static let area = CircleStyle(stroke: Color(hex: 0xEF4444), fill: Color(hex: 0xEF4444), fillOpacity: 0.06, lineWidth: 3)
    static let preview = CircleStyle(stroke: Color(hex: 0xF59E0B), fill: Color(hex: 0xF59E0B), fillOpacity: 0.08, lineWidth: 2)
    static let capture = CircleStyle(stroke: Color(hex: 0xFCA5A5), fill: Color(hex: 0xEF4444), fillOpacity: 0.15, lineWidth: 1)
    /// 鬼から見た逃走者（紫）
    static let possibleArea = CircleStyle(stroke: Color(hex: 0xA855F7), fill: Color(hex: 0xA855F7), fillOpacity: 0.18, lineWidth: 2)
    /// 自分が鬼にどう見えているか（青）
    static let ownPossibleArea = CircleStyle(stroke: Color(hex: 0x60A5FA), fill: Color(hex: 0x60A5FA), fillOpacity: 0.08, lineWidth: 1)
    /// ミッション目的地の到達範囲（緑）
    static let destination = CircleStyle(stroke: Color(hex: 0x22C55E), fill: Color(hex: 0x22C55E), fillOpacity: 0.25, lineWidth: 2)
    /// 目的地の除外エリア（灰色）
    static let exclusion = CircleStyle(stroke: Color(hex: 0x9CA3AF), fill: Color(hex: 0x6B7280), fillOpacity: 0.35, lineWidth: 1)
}

struct MapCircleItem: Identifiable, Equatable {
    var id: String
    var circle: GeoCircle
    var style: CircleStyle
}

struct MapPinItem: Identifiable, Equatable {
    var id: String
    var position: LatLng
    var emoji: String
    var label: String
    var tint: Color
    var emphasized = false // 自分
}

struct BoardMap: View {
    @Binding var camera: MapCameraPosition
    var circles: [MapCircleItem]
    var pins: [MapPinItem]
    var onTap: ((LatLng) -> Void)?

    var body: some View {
        MapReader { proxy in
            Map(position: $camera) {
                ForEach(circles) { item in
                    MapCircle(center: item.circle.center.coordinate, radius: item.circle.radiusM)
                        .foregroundStyle(item.style.fill.opacity(item.style.fillOpacity))
                        .stroke(item.style.stroke, lineWidth: item.style.lineWidth)
                }
                ForEach(pins) { pin in
                    Annotation(pin.label, coordinate: pin.position.coordinate, anchor: .bottom) {
                        PinView(pin: pin)
                    }
                    .annotationTitles(.hidden) // 名前は PinView の中に表示する
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .onTapGesture { point in
                guard let onTap, let c = proxy.convert(point, from: .local) else { return }
                onTap(LatLng(lat: c.latitude, lng: c.longitude))
            }
        }
    }

    /// 円全体が見えるカメラ位置
    static func fit(_ circle: GeoCircle) -> MapCameraPosition {
        .region(MKCoordinateRegion(center: circle.center.coordinate,
                                   latitudinalMeters: circle.radiusM * 2.4, longitudinalMeters: circle.radiusM * 2.4))
    }

    static func around(_ point: LatLng, meters: Double = 600) -> MapCameraPosition {
        .region(MKCoordinateRegion(center: point.coordinate, latitudinalMeters: meters, longitudinalMeters: meters))
    }
}

/// 地図のピン（絵文字＋名前）。名前は Text で表示する（Web 版の textContent と同じく、文字として扱う）
struct PinView: View {
    var pin: MapPinItem

    var body: some View {
        VStack(spacing: 2) {
            Text(pin.emoji)
                .font(.system(size: pin.emphasized ? 26 : 22))
                .padding(4)
                .background(Circle().fill(pin.tint.opacity(0.9)))
                .overlay(Circle().stroke(.white, lineWidth: pin.emphasized ? 3 : 1.5))
            if !pin.label.isEmpty {
                Text(pin.label)
                    .font(.caption2.bold())
                    .lineLimit(1)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(.black.opacity(0.65)))
                    .foregroundStyle(.white)
            }
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
