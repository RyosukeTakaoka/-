// 端末の位置情報（GPS）
// 実際の座標はここからゲームに渡る。オンラインではサーバーだけが読める /locations に送られ、
// 鬼へは必ずサーバーでぼかした「可能性エリア」だけが届く。
//
// ゲーム中はポケットに入れて画面を消しても位置を送れるよう、バックグラウンドでの取得を有効にする
// （画面上部に青い表示が出る。ゲームが終わったら必ず止める）。

import CoreLocation
import OniGameCore

@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var onUpdate: ((OwnPosition) -> Void)?
    private var onError: ((String) -> Void)?
    private var oneShot: CheckedContinuation<OwnPosition, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.activityType = .fitness
    }

    /// 位置を監視し続ける（ゲーム画面）。stop() で必ず止める
    func start(onUpdate: @escaping (OwnPosition) -> Void, onError: @escaping (String) -> Void) {
        self.onUpdate = onUpdate
        self.onError = onError
        manager.distanceFilter = 3
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.pausesLocationUpdatesAutomatically = false
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        onUpdate = nil
        onError = nil
    }

    /// 現在地を1回だけ取得する（作成画面の「現在地を開始地点にする」）
    func currentPosition() async throws -> OwnPosition {
        if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            throw GameError.precondition("位置情報の利用が許可されていません（設定アプリで許可してください）")
        }
        oneShot?.resume(throwing: CancellationError())
        return try await withCheckedThrowingContinuation { continuation in
            oneShot = continuation
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
            manager.requestLocation()
        }
    }

    // MARK: CLLocationManagerDelegate（位置の通知はメインスレッドで届く）

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last, loc.horizontalAccuracy >= 0 else { return }
        let pos = OwnPosition(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude, accuracyM: loc.horizontalAccuracy)
        Task { @MainActor in
            if let c = self.oneShot {
                self.oneShot = nil
                c.resume(returning: pos)
            }
            self.onUpdate?(pos)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let message: String
        switch (error as? CLError)?.code {
        case .denied: message = "位置情報の利用が許可されていません"
        case .locationUnknown: message = "現在地を取得できませんでした"
        default: message = "位置情報エラー"
        }
        Task { @MainActor in
            if let c = self.oneShot {
                self.oneShot = nil
                c.resume(throwing: GameError.precondition(message))
            }
            self.onError?(message)
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            let status = self.manager.authorizationStatus
            if status == .denied || status == .restricted {
                self.onError?("位置情報の利用が許可されていません（設定アプリで「使用中のみ許可」にしてください）")
            }
        }
    }
}
