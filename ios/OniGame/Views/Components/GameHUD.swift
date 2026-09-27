// ゲーム画面の HUD（役割・残り時間・人数・位置公開までの時間・警告・確保ボタン・ミッション）
// 受け取るのは PlayerView だけ（Web 版 components/gameHud.js・missionPanel.js）。

import SwiftUI
import OniGameCore

struct GameHUD: View {
    var view: PlayerView

    var body: some View {
        let left = view.phase == .playing ? GameClock.remainingMs(endsAt: view.endsAt ?? view.now, now: view.now) : 0
        HStack(alignment: .center) {
            Text(roleText)
                .font(.subheadline.bold())
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(roleColor.opacity(0.9), in: Capsule())
                .foregroundStyle(.white)
            Spacer()
            Text(GameClock.format(left))
                .font(.system(size: 30, weight: .heavy, design: .monospaced))
                .foregroundStyle(view.phase == .playing && left < 60_000 ? Color.red : Color.primary)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("逃走者 残り \(view.runnersRemaining)/\(view.runnersTotal)")
                if let next = view.nextRevealAt {
                    Text("位置公開まで \(GameClock.format(max(0, next - view.now)))")
                }
            }
            .font(.caption.bold())
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var roleText: String {
        guard let me = view.me?.player, let role = me.role else { return "-" }
        if me.isCaught { return "⛓ 脱落" }
        return "\(role == .hunter ? "👹" : "🏃") \(role.label)"
    }

    private var roleColor: Color {
        guard let me = view.me?.player else { return .gray }
        if me.isCaught { return MapLayers.caughtColor }
        return me.role == .hunter ? MapLayers.hunterColor : MapLayers.runnerColor
    }
}

struct GameBanners: View {
    var view: PlayerView

    var body: some View {
        let playing = view.phase == .playing
        VStack(spacing: 6) {
            if playing, view.me?.outOfArea == true {
                banner("⚠ ゲームエリアの外にいます。エリア内に戻ってください", color: .red)
            }
            if let text = statusText {
                banner(text, color: .black)
            }
            if playing, view.me != nil, view.me?.position == nil {
                banner("📡 位置情報を取得しています…", color: .black)
            }
        }
    }

    private var statusText: String? {
        guard view.phase == .playing, let me = view.me else { return nil }
        if me.player.isCaught { return "確保されました。観戦中です（逃走者の位置は表示されません）" }
        if me.player.isActiveRunner, let blur = me.blurM {
            let b = Int(blur)
            guard let shown = me.possibleArea?.radiusM else { return "次の位置公開で、鬼にはあなたの位置が半径\(b)mの円で見えます" }
            return Int(shown) == b
                ? "鬼にはあなたの位置が半径\(Int(shown))mの円（青い円）で見えています"
                : "鬼には半径\(Int(shown))mの円で見えています（次の位置公開から半径\(b)m）"
        }
        if me.player.originalRole == .runner && me.player.role == .hunter { return "確保されて鬼になりました。逃走者を捕まえよう！" }
        return nil
    }

    private func banner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote.bold())
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(8)
            .background(color.opacity(0.75), in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.white)
    }
}

struct CaptureButton: View {
    var view: PlayerView
    var action: () -> Void

    var body: some View {
        let waitMs = (view.me?.captureReadyAt ?? 0) - view.now
        Button(action: action) {
            Text(waitMs > 0 ? "🫳 確保（あと\(Int(ceil(Double(waitMs) / 1000)))秒）" : "🫳 確保！")
                .font(.title2.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
        .controlSize(.large)
        .disabled(waitMs > 0 || view.me?.position == nil)
    }
}

struct MissionPanel: View {
    var view: PlayerView
    var onReroll: () -> Void

    var body: some View {
        if let shared = view.mission {
            let left = GameClock.format(GameClock.remainingMs(endsAt: shared.endsAt, now: view.now))
            let own = view.me?.mission
            VStack(alignment: .leading, spacing: 6) {
                if let own, own.result == .pending, let dest = own.destination {
                    Text("🎯 ミッション \(shared.index)/\(shared.total)　残り \(left)").font(.headline)
                    Text("制限時間内に目的地（🎯・半径\(Int(own.arrivalRadiusM))m）へ到達せよ\(distanceText(dest))").font(.callout)
                    Text("⚠ 道路・水辺・私有地など危ない場所や入れない場所なら、向かわずに目的地を変更してください")
                        .font(.caption).foregroundStyle(.orange)
                    if own.canReroll {
                        Button("この目的地には行けない（1ゲームに1回だけ変更）", action: onReroll)
                            .buttonStyle(.bordered)
                            .font(.footnote)
                    }
                } else if let own {
                    Text("ミッション \(shared.index)/\(shared.total)　残り \(left)").font(.headline)
                    Text(resultText(own.result)).font(.callout)
                } else {
                    Text("⚠ ミッション \(shared.index)/\(shared.total) 発生中　残り \(left)").font(.headline)
                    Text("逃走者が目的地へ向かっています（目的地は鬼には分かりません）").font(.callout)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background((view.me?.mission != nil ? Color.green : Color.orange).opacity(0.18), in: RoundedRectangle(cornerRadius: 14))
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private func distanceText(_ dest: Destination) -> String {
        guard let pos = view.me?.position else { return "" }
        return "（あと約\(Geo.formatDistance(Geo.distanceM(pos.latLng, dest.latLng)))）"
    }

    private func resultText(_ r: MissionStatus) -> String {
        switch r {
        case .success: return "✅ ミッション成功！"
        case .failure: return "❌ ミッション失敗…"
        case .cancelled: return "このミッションは無効になりました"
        case .pending: return ""
        }
    }
}
