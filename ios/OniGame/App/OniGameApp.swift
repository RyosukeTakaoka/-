// アプリの入口
import SwiftUI

@main
struct OniGameApp: App {
    @State private var app = AppModel(config: .load())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                // 招待リンク（onigame://join?code=1234）で開いたら、参加コードを入れておく
                .onOpenURL { url in app.handle(url: url) }
        }
    }
}
