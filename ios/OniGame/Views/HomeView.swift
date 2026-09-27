// ホーム画面: 名前・ゲーム作成・ルームコードで参加・遊び方・安全の注意
import SwiftUI
import OniGameCore

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("oni.playerName") private var name = ""
    @State private var code = ""
    @State private var joining = false
    @State private var goCreate = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(spacing: 6) {
                    Text("👹").font(.system(size: 64))
                    Text("リアル鬼ごっこ").font(.largeTitle.bold())
                    Text("鬼ごっこ × ミッション × 情報戦").foregroundStyle(.secondary)
                }
                .padding(.top, 12)

                VStack(alignment: .leading, spacing: 6) {
                    Text("あなたの名前").font(.subheadline.bold())
                    TextField("例: たろう", text: $name)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.nickname)
                        .onChange(of: name) { _, v in
                            if v.count > Player.maxNameLength { name = String(v.prefix(Player.maxNameLength)) }
                        }
                }

                Button {
                    guard readName() != nil else { return }
                    goCreate = true
                } label: {
                    Text("ゲームを作成").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                VStack(alignment: .leading, spacing: 6) {
                    Text("ルームコードで参加").font(.subheadline.bold())
                    HStack {
                        TextField("4桁の数字（例: 1234）", text: $code)
                            .keyboardType(.numberPad)
                            .textFieldStyle(.roundedBorder)
                            .onChange(of: code) { _, v in
                                let digits = String(v.filter(\.isNumber).prefix(4))
                                if digits != v { code = digits }
                            }
                        Button("参加する") { join() }
                            .buttonStyle(.bordered)
                            .disabled(joining)
                    }
                }

                Card {
                    DisclosureGroup("あそびかた") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("1. ホストがゲームを作り、開始地点とエリアを決める")
                            Text("2. 友達をルームに招待し、鬼と逃走者を決める")
                            Text("3. 鬼には逃走者の正確な位置は見えず「この円のどこかにいる」だけが分かる")
                            Text("4. ゲーム中に4回ミッションが発生。成功すると位置がぼやけ、失敗すると絞られる")
                        }
                        .font(.callout)
                        .padding(.top, 6)
                    }
                }

                Card(title: "⚠ 安全に遊ぶために") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("・道路への飛び出し・歩きスマホはしない")
                        Text("・私有地・立入禁止の場所には入らない")
                        Text("・公園や学校など、許可のある安全な場所で遊ぶ")
                    }
                    .font(.callout)
                }
            }
            .padding()
        }
        .navigationDestination(isPresented: $goCreate) {
            CreateView(mode: .create(hostName: Player.sanitizeName(name)))
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { backendMenu }
        }
        .onAppear {
            if let invited = app.invitedCode {
                code = invited
                app.invitedCode = nil
            }
        }
        .onChange(of: app.invitedCode) { _, invited in
            if let invited {
                code = invited
                app.invitedCode = nil
            }
        }
    }

    /// 開発用: 端末内モード（ダミーで1台確認）とオンラインの切り替え
    private var backendMenu: some View {
        Menu {
            Button {
                app.switchBackend(.firebase)
            } label: {
                Label("オンライン（Firebase）", systemImage: app.service.mode == .firebase ? "checkmark" : "network")
            }
            Button {
                app.switchBackend(.local)
            } label: {
                Label("端末内モード（開発用・ダミー）", systemImage: app.service.mode == .local ? "checkmark" : "hammer")
            }
        } label: {
            Image(systemName: app.isDevMode ? "hammer.fill" : "gearshape")
        }
        .accessibilityLabel("モードの切り替え")
    }

    private func readName() -> String? {
        let clean = Player.sanitizeName(name)
        guard !clean.isEmpty else {
            app.toasts.show("名前を入力してください")
            return nil
        }
        name = clean
        return clean
    }

    private func join() {
        guard let n = readName() else { return }
        joining = true
        Task {
            defer { joining = false }
            do {
                try await app.service.joinRoom(code: code.trimmingCharacters(in: .whitespaces), name: n)
            } catch {
                app.toasts.show(AppModel.message(for: error), seconds: 3.5)
            }
        }
    }
}
