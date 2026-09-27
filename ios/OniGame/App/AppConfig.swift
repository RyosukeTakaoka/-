// アプリの設定（Info.plist から読む。値は ios/project.yml の info.properties で決める）
//
// OniBackend        … "firebase"（オンライン対戦）/ "local"（端末内モード＝開発モード。ダミーの友達で1台で確認）
// OniFirebaseMode   … "emulator"（Mac の Firebase Emulator に接続。本番には接続しない）/ "production"（本番）
// OniEmulatorHost   … エミュレーターの場所。シミュレーターなら 127.0.0.1、実機なら Mac の IP アドレス
// OniFunctionsRegion… Cloud Functions のリージョン（functions/index.js と同じ asia-northeast1）
//
// 本番に接続するときは Firebase コンソールで iOS アプリを追加し、GoogleService-Info.plist を
// ios/OniGame/ に置く（.gitignore 済み。GitHub に上げない）。

import Foundation

enum BackendMode: String {
    case local
    case firebase
}

enum FirebaseMode: String {
    case emulator
    case production
}

struct AppConfig {
    var backend: BackendMode
    var firebaseMode: FirebaseMode
    var emulatorHost: String
    var emulatorProjectId: String
    var functionsRegion: String

    static let backendOverrideKey = "oni.backendOverride"

    static func load(bundle: Bundle = .main, defaults: UserDefaults = .standard) -> AppConfig {
        let info = bundle.infoDictionary ?? [:]
        let plistBackend = BackendMode(rawValue: info["OniBackend"] as? String ?? "") ?? .firebase
        // 開発中はホーム画面の 🛠 メニューで切り替えられる（端末に保存）
        let override = defaults.string(forKey: backendOverrideKey).flatMap(BackendMode.init(rawValue:))
        return AppConfig(
            backend: override ?? plistBackend,
            firebaseMode: FirebaseMode(rawValue: info["OniFirebaseMode"] as? String ?? "") ?? .emulator,
            emulatorHost: info["OniEmulatorHost"] as? String ?? "127.0.0.1",
            emulatorProjectId: "demo-oni-game", // "demo-" で始まる ID は Firebase の仕様で本番に接続されない
            functionsRegion: info["OniFunctionsRegion"] as? String ?? "asia-northeast1"
        )
    }
}
