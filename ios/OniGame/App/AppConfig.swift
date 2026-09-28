// アプリの設定（Info.plist から読む。値は ios/project.yml の info.properties で決める）
//
// OniBackend      … "online"（オンライン対戦・Supabase）/ "local"（端末内モード＝開発モード。ダミーの友達で1台で確認）
// OniSupabaseMode … "emulator"（Mac の supabase start に接続。本番には接続しない）/ "production"（本番）
// OniEmulatorHost … エミュレーターの場所。シミュレーターなら 127.0.0.1、実機なら Mac の IP アドレス
// OniSupabaseUrl / OniSupabaseAnonKey … 本番の Supabase プロジェクトの Project URL・anon key
//   （どちらも「公開してよい」値。実際のアクセス制限は Row Level Security で行う）
//
// なぜ Firebase ではなく Supabase か: Cloud Functions は Firebase の無料（Spark）プランでは動かせない
// （Blaze への変更＝カード登録が必須）。Supabase は無料プランのままオンライン対戦のサーバーを動かせる
// （詳しくは ios/README.md）。

import Foundation

enum BackendMode: String {
    case local
    case online
}

enum SupabaseMode: String {
    case emulator
    case production
}

struct AppConfig {
    var backend: BackendMode
    var supabaseMode: SupabaseMode
    var emulatorHost: String
    var supabaseUrl: String?
    var supabaseAnonKey: String?

    static let backendOverrideKey = "oni.backendOverride"

    static func load(bundle: Bundle = .main, defaults: UserDefaults = .standard) -> AppConfig {
        let info = bundle.infoDictionary ?? [:]
        let plistBackend = BackendMode(rawValue: info["OniBackend"] as? String ?? "") ?? .online
        // 開発中はホーム画面の 🛠 メニューで切り替えられる（端末に保存）
        let override = defaults.string(forKey: backendOverrideKey).flatMap(BackendMode.init(rawValue:))
        return AppConfig(
            backend: override ?? plistBackend,
            supabaseMode: SupabaseMode(rawValue: info["OniSupabaseMode"] as? String ?? "") ?? .emulator,
            emulatorHost: info["OniEmulatorHost"] as? String ?? "127.0.0.1",
            supabaseUrl: info["OniSupabaseUrl"] as? String,
            supabaseAnonKey: info["OniSupabaseAnonKey"] as? String
        )
    }

    /// エミュレーターの API の場所（supabase start が localhost:54321 で立てるゲートウェイ）
    var emulatorApiURL: URL { URL(string: "http://\(emulatorHost):54321")! }
    /// ローカルの supabase start が常に発行する、エミュレーター専用の anon key（本番のキーではない）
    static let emulatorAnonKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
}
