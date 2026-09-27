// 画面下に順番に表示する短い通知（Web 版の toast と同じ）と、振動
import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

struct Toast: Equatable, Identifiable {
    let id = UUID()
    var text: String
    var seconds: Double
}

@MainActor
@Observable
final class ToastCenter {
    private(set) var current: Toast?
    @ObservationIgnored private var queue: [Toast] = []
    @ObservationIgnored private var task: Task<Void, Never>?

    func show(_ text: String, seconds: Double = 2.5) {
        queue.append(Toast(text: text, seconds: seconds))
        if task == nil { next() }
    }

    /// 画面が変わったとき、前の画面の通知を持ち込まない
    func clear() {
        queue.removeAll()
        task?.cancel()
        task = nil
        current = nil
    }

    private func next() {
        guard !queue.isEmpty else {
            current = nil
            task = nil
            return
        }
        let toast = queue.removeFirst()
        current = toast
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(toast.seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.next()
        }
    }
}

/// 振動（Web 版の navigator.vibrate の代わり）
enum Haptics {
    enum Kind {
        case light, success, warning, error, heavy
    }

    @MainActor
    static func play(_ kind: Kind) {
        #if canImport(UIKit) && os(iOS)
        switch kind {
        case .light: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .heavy: UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        #endif
    }
}
