// アプリ全体の状態: どちらのバックエンドを使うか・通知（トースト）・開発用の視点
import Foundation
import Observation
import OniGameCore

@MainActor
@Observable
final class AppModel {
    private(set) var config: AppConfig
    private(set) var service: any GameService
    let toasts = ToastCenter()
    /// 招待リンクで開いたときの参加コード（ホーム画面が使う）
    var invitedCode: String?
    /// 開発モードで「どのプレイヤーとして画面を見るか」（nil なら自分）
    var devViewerId: String?

    init(config: AppConfig) {
        self.config = config
        service = AppModel.makeService(config)
    }

    private static func makeService(_ config: AppConfig) -> any GameService {
        switch config.backend {
        case .local: return LocalGameService()
        case .online: return SupabaseGameService(config: config)
        }
    }

    /// 端末内モード（開発モード）か。ダミーの友達・地図タップで移動・視点の切り替えが使える
    var isDevMode: Bool { service.mode == .local }

    /// 開発用: バックエンドを切り替える（部屋に入っていないときだけ）
    func switchBackend(_ backend: BackendMode) {
        guard !service.session.inRoom, backend != config.backend else { return }
        UserDefaults.standard.set(backend.rawValue, forKey: AppConfig.backendOverrideKey)
        config.backend = backend
        service = AppModel.makeService(config)
        devViewerId = nil
        toasts.show(backend == .local ? "端末内モード（開発用）に切り替えました" : "オンライン（Supabase）に切り替えました")
    }

    func handle(url: URL) {
        guard url.scheme == "onigame",
              let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
              code.count == 4, code.allSatisfy(\.isNumber) else { return }
        invitedCode = code
    }

    /// 画面に出すエラーメッセージ
    static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? (error as NSError).localizedDescription
    }
}
