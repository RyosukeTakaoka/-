// ゲーム画面: 地図（ゲームボード）＋HUD＋ミッション
// 受け取るのは PlayerView（その人に見せてよい情報）だけ。

import SwiftUI
import MapKit
import OniGameCore

struct GameView: View {
    @Environment(AppModel.self) private var app
    @State private var model = GameScreenModel()
    @State private var camera: MapCameraPosition = .automatic
    @State private var didFit = false
    @State private var confirmEnd = false
    @State private var confirmReroll = false

    var body: some View {
        ZStack {
            if let v = model.view {
                BoardMap(camera: $camera, circles: MapLayers.circles(for: v), pins: MapLayers.pins(for: v),
                         onTap: app.isDevMode ? { (p: LatLng) in moveViewer(to: p) } : nil)
                    .ignoresSafeArea()
                VStack(spacing: 8) {
                    GameHUD(view: v)
                    GameBanners(view: v)
                    if app.isDevMode { devPanel(v) }
                    Spacer()
                    if v.phase == .playing, let me = v.me, me.player.isActiveHunter {
                        CaptureButton(view: v) { capture() }
                    }
                    MissionPanel(view: v) { confirmReroll = true }
                    footer(v)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            } else {
                ProgressView("読み込み中…")
            }
        }
        .onAppear { model.start(app: app) }
        .onDisappear { model.stop() }
        .onChange(of: model.view?.area) { _, area in
            if let area, !didFit {
                didFit = true
                camera = BoardMap.fit(area)
            }
        }
        .confirmationDialog("ゲームを終了しますか？", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("終了する", role: .destructive) {
                Task {
                    do { try await app.service.abortGame() } catch { app.toasts.show(AppModel.message(for: error)) }
                }
            }
        }
        .confirmationDialog("目的地を変更しますか？（1ゲームにつき1回だけ使えます）", isPresented: $confirmReroll, titleVisibility: .visible) {
            Button("変更する") { reroll() }
        }
    }

    @ViewBuilder
    private func footer(_ v: PlayerView) -> some View {
        HStack {
            Button("🎯 エリア全体") {
                if let area = v.area { withAnimation { camera = BoardMap.fit(area) } }
            }
            .buttonStyle(.bordered)
            .background(.regularMaterial, in: Capsule())
            Spacer()
            if v.phase == .playing, v.me?.player.isHost == true {
                Button("ゲーム終了", role: .destructive) { confirmEnd = true }
                    .buttonStyle(.bordered)
                    .background(.regularMaterial, in: Capsule())
            }
        }
    }

    /// 開発用: どのプレイヤーとして画面を見るか（見える情報は、そのプレイヤーの表示ルールどおり）
    private func devPanel(_ v: PlayerView) -> some View {
        let players = ([v.me?.player].compactMap { $0 } + v.others.map(\.player))
        return HStack {
            Text("🛠 視点")
            Picker("視点を切り替え", selection: Binding(
                get: { model.viewerId ?? "" },
                set: { model.switchViewer(to: $0) }
            )) {
                ForEach(players) { p in
                    Text("\(p.name)（\(p.role?.label ?? "-")\(p.isCaught ? "・脱落" : "")）").tag(p.id)
                }
            }
            .pickerStyle(.menu)
        }
        .font(.footnote)
        .padding(.horizontal, 10)
        .background(.regularMaterial, in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func moveViewer(to point: LatLng) {
        guard let id = model.viewerId else { return }
        app.service.reportPosition(playerId: id, position: OwnPosition(lat: point.lat, lng: point.lng))
        model.refresh()
    }

    private func capture() {
        Task {
            let result = await app.service.requestCapture(hunterId: model.viewerId)
            if result.ok {
                Haptics.play(.success)
            } else {
                let reason = result.reason ?? ""
                app.toasts.show(CaptureFailure(rawValue: reason)?.message ?? reason)
            }
            model.refresh()
        }
    }

    private func reroll() {
        Task {
            let result = await app.service.requestNewDestination(runnerId: model.viewerId)
            app.toasts.show(result.ok ? "目的地を変更しました" : "目的地を変更できませんでした")
            model.refresh()
        }
    }
}
