// ゲーム作成・設定画面（時間・半径・ぼかし・公開間隔・鬼の人数・確保距離・増え鬼・開始地点・除外エリア）
// 「もう一度遊ぶ」でも使う（同じルーム・同じメンバー・同じ設定。開始地点と除外エリアは設定し直す）。

import SwiftUI
import MapKit
import OniGameCore

struct CreateView: View {
    enum Mode: Equatable {
        case create(hostName: String)
        case rematch
    }

    let mode: Mode
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var draft = GameDraft()
    @State private var camera: MapCameraPosition = BoardMap.around(Dummies.defaultCenter, meters: 1200)
    @State private var exclusionMode = false
    @State private var busy = false
    @State private var locating = false
    @State private var confirmLeave = false
    @State private var location = LocationService()

    private var isRematch: Bool { mode == .rematch }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Card(title: "ゲーム時間") {
                    OptionPicker(label: "ゲーム時間", options: GameSettings.durationOptionsMin, value: $draft.settings.durationMin) { "\($0)分" }
                }
                Card(title: "ゲームエリアの半径") {
                    OptionPicker(label: "ゲームエリアの半径", options: GameSettings.radiusOptionsM, value: $draft.settings.radiusM) {
                        Geo.formatDistance(Double($0))
                    }
                }
                Card(title: "初期の位置情報ぼかし", hint: "鬼に見える「逃走者がいるかもしれない円」の大きさ") {
                    OptionPicker(label: "初期の位置情報ぼかし", options: GameSettings.blurOptionsM, value: $draft.settings.initialBlurM) {
                        Geo.formatDistance(Double($0))
                    }
                }
                Card(title: "位置の公開間隔", hint: "この間隔ごとに、鬼に見える可能性エリアが更新されます。間隔中は同じ円のままです") {
                    OptionPicker(label: "位置の公開間隔", options: GameSettings.revealIntervalOptionsSec, value: $draft.settings.revealIntervalSec) {
                        GameSettings.formatInterval($0)
                    }
                }
                Card(title: "鬼の位置を逃走者に見せる") {
                    OptionPicker(label: "鬼の位置を逃走者に見せる", options: [true, false], value: $draft.settings.showHuntersToRunners) {
                        $0 ? "見せる" : "見せない"
                    }
                }
                Card(title: "鬼の人数") {
                    Stepper(value: $draft.settings.hunterCount, in: GameSettings.minHunters...GameSettings.maxHunters) {
                        Text("\(draft.settings.hunterCount)人").font(.title3.bold())
                    }
                }
                Card(title: "確保できる距離", hint: "鬼がこの距離まで近づくと「確保」できます（GPSの誤差があるため10m以上がおすすめ）") {
                    OptionPicker(label: "確保できる距離", options: GameSettings.captureRadiusOptionsM, value: $draft.settings.captureRadiusM) { "\($0)m" }
                }
                Card(title: "増え鬼", hint: "ON: 捕まった逃走者が鬼になる / OFF: 捕まった逃走者は脱落") {
                    OptionPicker(label: "増え鬼", options: [false, true], value: $draft.settings.zombieMode) { $0 ? "ON" : "OFF" }
                }

                Card(title: "ゲーム開始地点", hint: "地図をタップして開始地点を選ぶか、現在地を使ってください。ここがエリアの中心になります。") {
                    BoardMap(camera: $camera, circles: previewCircles, pins: previewPins) { point in
                        if exclusionMode {
                            draft.exclusionZones.append(point)
                        } else {
                            chooseStart(point)
                        }
                    }
                    .frame(height: 300)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    Button {
                        useCurrentLocation()
                    } label: {
                        Label("現在地を開始地点にする", systemImage: "location.fill")
                    }
                    .buttonStyle(.bordered)
                    .disabled(locating)
                    Text(startStatus).font(.footnote).foregroundStyle(.secondary)
                }

                Card(title: "ミッション目的地の除外エリア",
                     hint: "ミッションの目的地は、エリア内に自動で作られます（地図の建物・道路の情報は使いません）。車道・池や川・私有地・立入禁止の場所・建物がある所は、ここで除外エリア（灰色の円）にしてください。アプリは道路・水辺・建物などを自動では判定できないため、目的地の安全はこの設定に依存します。安全に過ごせる場所（校庭・公園など）をゲームエリアにしてください。") {
                    HStack {
                        Button {
                            exclusionMode.toggle()
                        } label: {
                            Text(exclusionMode ? "✅ 除外エリアの追加を終える" : "🚫 地図タップで除外エリアを置く")
                        }
                        .buttonStyle(.bordered)
                        .tint(exclusionMode ? .red : .accentColor)
                        Button("全部消す") { draft.exclusionZones = [] }
                            .buttonStyle(.bordered)
                    }
                    Text("除外エリア: \(draft.exclusionZones.count)か所\(exclusionMode ? "（地図をタップして追加中）" : "")")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                ForEach(draft.settings.warnings, id: \.self) { w in
                    Text(w).font(.footnote.bold()).foregroundStyle(.orange)
                }

                Button {
                    submit()
                } label: {
                    Text(isRematch ? "ロビーへ（同じメンバー）" : "ルームを作成").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)
            }
            .padding()
        }
        .navigationTitle(isRematch ? "もう一度遊ぶ：ゲーム設定" : "ゲーム作成")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isRematch)
        .toolbar {
            if isRematch {
                ToolbarItem(placement: .topBarLeading) {
                    Button("解散") { confirmLeave = true }
                }
            }
        }
        .confirmationDialog("ルームを解散してホームに戻りますか？", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("解散する", role: .destructive) { Task { await app.service.leaveRoom() } }
        }
        .onAppear {
            if isRematch { draft.settings = app.service.session.settings } // 設定は引き継ぐ
        }
        .onChange(of: draft.settings.radiusM) { _, _ in
            if let area = draft.area { camera = BoardMap.fit(area) }
        }
    }

    private var startStatus: String {
        guard let p = draft.startPoint else { return "開始地点が未設定です" }
        return String(format: "開始地点: %.5f, %.5f", p.lat, p.lng) + " / 半径 \(Geo.formatDistance(Double(draft.settings.radiusM)))"
    }

    private var previewCircles: [MapCircleItem] {
        var items: [MapCircleItem] = []
        if let area = draft.area { items.append(MapCircleItem(id: "area", circle: area, style: .preview)) }
        for (i, z) in draft.exclusionZones.enumerated() {
            items.append(MapCircleItem(id: "exclusion-\(i)", circle: GeoCircle(center: z, radiusM: GameEngine.exclusionRadiusM), style: .exclusion))
        }
        return items
    }

    private var previewPins: [MapPinItem] {
        guard let p = draft.startPoint else { return [] }
        return [MapPinItem(id: "start", position: p, emoji: "🚩", label: "スタート", tint: .orange)]
    }

    private func chooseStart(_ point: LatLng) {
        draft.startPoint = point
        if let area = draft.area { camera = BoardMap.fit(area) }
    }

    private func useCurrentLocation() {
        locating = true
        Task {
            defer { locating = false }
            do {
                chooseStart(try await location.currentPosition().latLng)
                app.toasts.show("現在地を開始地点にしました")
            } catch {
                app.toasts.show("\(AppModel.message(for: error))。地図をタップして選んでください", seconds: 4)
            }
        }
    }

    private func submit() {
        guard draft.startPoint != nil else {
            app.toasts.show("ゲーム開始地点を設定してください")
            return
        }
        busy = true
        Task {
            defer { busy = false }
            do {
                switch mode {
                case let .create(hostName):
                    try await app.service.createRoom(hostName: hostName, draft: draft)
                case .rematch:
                    try await app.service.configureGame(draft)
                }
            } catch {
                app.toasts.show(AppModel.message(for: error), seconds: 3.5)
            }
        }
    }
}
