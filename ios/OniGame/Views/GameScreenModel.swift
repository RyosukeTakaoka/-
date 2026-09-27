// ゲーム画面の裏側: 0.25秒ごとにビューを取り直し、変化に合わせて通知・振動を出す（Web 版 screens/game.js）
// 表示はすべて gameService.view(...)（その人に見せてよい情報）から作る。ゲームの状態は直接読まない。

import Foundation
import Observation
import OniGameCore

@MainActor
@Observable
final class GameScreenModel {
    private(set) var view: PlayerView?

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let location = LocationService()
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var sharingLocation = false
    @ObservationIgnored private var lastLogId = 0
    @ObservationIgnored private var lastOwnResult: String? // 自分のミッション結果の変化を知らせるため
    @ObservationIgnored private var lastOwn: (viewerId: String, historyLength: Int, blurM: Double?)? // 自分のぼかし精度の変化

    /// 今どのプレイヤーとして見ているか（開発モードでは切り替えられる）
    var viewerId: String? { app?.devViewerId ?? app?.service.session.selfId }

    func start(app: AppModel) {
        self.app = app
        lastLogId = 0
        if let local = app.service as? LocalGameService {
            // 開発モード: 地図タップで今の視点のプレイヤーを動かす。そのプレイヤーはダミーの動きから外す
            local.controlledId = { [weak app] in app?.devViewerId }
            app.toasts.show("開発モード: 地図をタップすると、今の視点のプレイヤーが移動します", seconds: 4)
        } else {
            startLocationSharing(app: app)
        }
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        stopLocationSharing()
    }

    private func startLocationSharing(app: AppModel) {
        guard !sharingLocation else { return }
        sharingLocation = true
        location.start(onUpdate: { [weak app] pos in
            guard let app, let selfId = app.service.session.selfId else { return }
            app.service.reportPosition(playerId: selfId, position: pos)
        }, onError: { [weak app] message in
            app?.toasts.show(message, seconds: 4)
        })
    }

    /// 位置の共有を止める（終了したら必ず止める）
    private func stopLocationSharing() {
        guard sharingLocation else { return }
        sharingLocation = false
        location.stop()
    }

    func refresh() {
        guard let app else { return }
        app.service.tick()
        guard let v = app.service.view(viewerId: viewerId, now: app.service.now()) else { return }
        notifyOwnMissionResult(v)
        notifyOwnBlurChange(v) // 本人向けの通知を、全員向けのログの通知より先に並べる
        notifyNewLogs(v)
        view = v
        if v.phase != .playing { stopLocationSharing() } // 終了: 位置の監視を止める（結果画面は位置情報を使わない）
    }

    /// 開発モードで視点を変える
    func switchViewer(to id: String) {
        app?.devViewerId = id
        refresh()
    }

    // MARK: 通知

    private func notifyNewLogs(_ v: PlayerView) {
        guard let app else { return }
        for entry in v.log where entry.id > lastLogId {
            lastLogId = entry.id
            switch entry.type {
            case "mission_start":
                app.toasts.show(v.me?.mission?.destination != nil ? "🎯 ミッション発生！ 制限時間内に目的地へ向かえ" : entry.text, seconds: 3.5)
                Haptics.play(.warning)
            case "reveal":
                guard let me = v.me?.player, me.status != .caught else { continue }
                app.toasts.show(me.role == .hunter ? "🔔 逃走者の可能性エリアが更新された" : "⚠ あなたの可能性エリアが鬼に公開された")
                Haptics.play(.light)
            case "capture" where entry.playerId == viewerId:
                app.toasts.show("あなたは確保された…", seconds: 3.5)
                Haptics.play(.error)
            default:
                app.toasts.show(entry.text, seconds: 3)
                if entry.type != "start" { Haptics.play(.heavy) }
            }
        }
    }

    private func notifyOwnMissionResult(_ v: PlayerView) {
        let own = v.me?.mission
        let key = own.map { "\($0.index):\($0.result.rawValue)" }
        if let own, let key, key != lastOwnResult, lastOwnResult?.hasPrefix("\(own.index):") == true, own.result == .success {
            app?.toasts.show("✅ ミッション成功！", seconds: 3)
            Haptics.play(.success)
        }
        lastOwnResult = key
    }

    /// ミッション終了で自分の blurM が変わったことを本人にだけ知らせる（鬼には通知しない）
    private func notifyOwnBlurChange(_ v: PlayerView) {
        guard let me = v.me, let viewerId else {
            lastOwn = nil
            return
        }
        let prev = lastOwn
        let now = (viewerId: viewerId, historyLength: me.missionHistory.count, blurM: me.blurM)
        lastOwn = now
        guard let prev, prev.viewerId == viewerId, now.historyLength > prev.historyLength,
              me.player.isActiveRunner else { return }
        let before = prev.blurM.map { Int($0) } ?? 0
        let after = now.blurM.map { Int($0) } ?? 0
        let change = "\(before)m → \(after)m・次の位置公開から反映"
        switch me.missionHistory.last?.result {
        case .success?:
            app?.toasts.show(after > before ? "✅ ミッション成功！ 位置情報のぼかしが強くなりました（\(change)）" : "✅ ミッション成功！ ぼかしはすでに最大です", seconds: 4.5)
        case .failure?:
            app?.toasts.show(after < before ? "❌ ミッション失敗… 位置情報のぼかしが弱くなりました（\(change)）" : "❌ ミッション失敗… ぼかしはすでに最小です", seconds: 4.5)
            Haptics.play(.error)
        case nil:
            break
        }
    }
}
