// ビュー（その人に見せてよい情報）から、地図に描く円とピンを作る
// （Web 版 map/playerLayer.js・missionLayer.js・markers.js と同じルール）
// 入力は PlayerView だけ。実位置の状態には触れない。

import SwiftUI
import OniGameCore

enum MapLayers {
    static let hunterColor = Color(hex: 0xDC2626)
    static let runnerColor = Color(hex: 0x2563EB)
    static let caughtColor = Color(hex: 0x6B7280)

    static func circles(for v: PlayerView) -> [MapCircleItem] {
        var items: [MapCircleItem] = []
        if let area = v.area { items.append(MapCircleItem(id: "area", circle: area, style: .area)) }
        for (i, z) in v.exclusionZones.enumerated() {
            items.append(MapCircleItem(id: "exclusion-\(i)", circle: z, style: .exclusion))
        }
        // 自分が鬼にどう見えているか（青）
        if let own = v.me?.possibleArea {
            items.append(MapCircleItem(id: "own-area", circle: GeoCircle(center: own.center, radiusM: own.radiusM), style: .ownPossibleArea))
        }
        // 鬼から見た逃走者の可能性エリア（紫）
        for other in v.others {
            if case let .area(a) = other.display {
                items.append(MapCircleItem(id: "area-\(other.id)", circle: GeoCircle(center: a.center, radiusM: a.radiusM), style: .possibleArea))
            }
        }
        // 自分の目的地（本人のビューにだけある）
        if let m = v.me?.mission, let d = m.destination {
            items.append(MapCircleItem(id: "destination", circle: GeoCircle(center: d.latLng, radiusM: m.arrivalRadiusM), style: .destination))
        }
        // 鬼の確保範囲
        if v.phase == .playing, let me = v.me, me.player.isActiveHunter, let pos = me.position {
            items.append(MapCircleItem(id: "capture", circle: GeoCircle(center: pos.latLng, radiusM: Double(v.settings.captureRadiusM)), style: .capture))
        }
        return items
    }

    static func pins(for v: PlayerView) -> [MapPinItem] {
        var items: [MapPinItem] = []
        if let area = v.area {
            items.append(MapPinItem(id: "start", position: area.center, emoji: "🚩", label: "スタート", tint: .orange))
        }
        if let m = v.me?.mission, let d = m.destination {
            items.append(MapPinItem(id: "destination-pin", position: d.latLng, emoji: "🎯", label: d.label, tint: .green))
        }
        for other in v.others {
            switch other.display {
            case let .exact(pos):
                items.append(playerPin(other.player, position: pos, isSelf: false))
            case let .area(a):
                // ❓ は円の中心に置くと「中心にいる」と誤解されるため、円の北端に置く
                let north = Geo.destinationPoint(a.center, distance: a.radiusM, bearingDeg: 0)
                items.append(MapPinItem(id: "area-label-\(other.id)", position: north, emoji: "❓",
                                        label: "\(other.player.name)はこの中のどこか", tint: .purple))
            case .hidden:
                break
            }
        }
        if let me = v.me, let pos = me.position {
            items.append(playerPin(me.player, position: pos.latLng, isSelf: true))
        }
        return items
    }

    /// プレイヤーのピン。position は必ずビューから受け取った「表示してよい位置」を渡すこと
    static func playerPin(_ p: PublicPlayer, position: LatLng, isSelf: Bool) -> MapPinItem {
        let hunter = p.role == .hunter
        let out = p.isCaught
        return MapPinItem(
            id: "player-\(p.id)",
            position: position,
            emoji: out ? "⛓" : hunter ? "👹" : "🏃",
            label: isSelf ? "\(p.name)（あなた）" : p.name,
            tint: out ? caughtColor : hunter ? hunterColor : runnerColor,
            emphasized: isSelf
        )
    }
}
