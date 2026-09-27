// 画面の切り替え
// 部屋に入ったあとは、ゲームのフェーズ（サーバーが決める）に合わせて自動で画面が変わる。
//   ホーム → 作成 →（部屋）ロビー → ゲーム → 結果 →（もう一度遊ぶ）作成（ホスト）/ 待機（ほかの人）→ ロビー

import SwiftUI
import OniGameCore

struct RootView: View {
    @Environment(AppModel.self) private var app
    @State private var leavingClosedRoom = false

    var body: some View {
        let session = app.service.session
        ZStack(alignment: .bottom) {
            content(session)
            ToastOverlay(center: app.toasts)
        }
        .animation(.default, value: session.phase)
        .onChange(of: session.inRoom) { _, inRoom in
            if !inRoom { app.devViewerId = nil } // 開発用の視点は部屋を出たら戻す
        }
        .onChange(of: session.closed) { _, closed in
            guard closed, !leavingClosedRoom else { return }
            // ホストが退出して部屋が解散した
            leavingClosedRoom = true
            app.toasts.show("ホストが部屋を解散しました", seconds: 4)
            Task {
                await app.service.leaveRoom()
                leavingClosedRoom = false
            }
        }
    }

    @ViewBuilder
    private func content(_ session: Session) -> some View {
        if !session.inRoom {
            NavigationStack { HomeView() }
        } else {
            switch session.phase {
            case .setup?:
                if session.isHost {
                    NavigationStack { CreateView(mode: .rematch) }
                } else {
                    WaitingForHostView()
                }
            case .lobby?, nil:
                NavigationStack { LobbyView() }
            case .playing?:
                GameView()
            case .finished?:
                ResultScreen()
            }
        }
    }
}

/// 画面下の通知
struct ToastOverlay: View {
    var center: ToastCenter

    var body: some View {
        if let toast = center.current {
            Text(toast.text)
                .font(.callout.bold())
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.bottom, 90)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .id(toast.id)
                .allowsHitTesting(false)
        }
    }
}

/// カードの見た目
struct Card<Content: View>: View {
    var title: String?
    var hint: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.headline) }
            if let hint { Text(hint).font(.footnote).foregroundStyle(.secondary) }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// 選択肢ボタン（Web 版 optionGroup.js）
struct OptionPicker<Value: Hashable>: View {
    var label: String
    var options: [Value]
    @Binding var value: Value
    var format: (Value) -> String

    var body: some View {
        Picker(label, selection: $value) {
            ForEach(options, id: \.self) { Text(format($0)).tag($0) }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel(label)
    }
}

/// もう一度遊ぶとき、ホスト以外の人が待つ画面
struct WaitingForHostView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 20) {
            ProgressView()
            Text("ホストが次のゲームを設定しています…").font(.headline)
            Text("同じメンバー・同じルームで、もう一度遊びます").foregroundStyle(.secondary)
            Button("ルームから退出", role: .destructive) {
                Task { await app.service.leaveRoom() }
            }
            .buttonStyle(.bordered)
        }
        .padding()
    }
}
