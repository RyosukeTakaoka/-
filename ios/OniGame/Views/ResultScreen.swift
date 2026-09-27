// 結果画面
// 表示に使うのは gameService.resultView(...)（結果を本人向けに絞ったもの）だけ。位置情報は扱わない。

import SwiftUI
import OniGameCore

struct ResultScreen: View {
    @Environment(AppModel.self) private var app
    @State private var busy = false

    var body: some View {
        let session = app.service.session
        Group {
            if let view = app.service.resultView(viewerId: app.devViewerId) {
                content(view, isHost: session.isHost)
            } else {
                ProgressView("結果を読み込み中…")
            }
        }
        .onAppear { app.toasts.clear() } // ゲーム中の通知を結果画面に持ち込まない
    }

    private func content(_ view: ResultView, isHost: Bool) -> some View {
        let s = view.summary
        let me = s.players.first { $0.id == view.you }
        let mySide: Winner = me?.finalRole == .hunter ? .hunters : .runners
        return ScrollView {
            VStack(spacing: 14) {
                VStack(spacing: 6) {
                    Text(s.winner == .hunters ? "👹" : s.winner == .runners ? "🏃" : "🏁").font(.system(size: 64))
                    Text(s.headline).font(.title.bold()).multilineTextAlignment(.center)
                    if let winner = s.winner, me != nil {
                        Text(mySide == winner ? "あなたの陣営の勝利！" : "あなたの陣営の負け…").font(.title3.bold())
                    }
                    Text("プレイ時間 \(GameClock.format(s.playedMs)) / 設定 \(s.durationMin)分\(s.zombieMode ? "・増え鬼" : "")")
                        .foregroundStyle(.secondary)
                }
                .padding(.top)

                Card(title: "プレイヤー") {
                    ForEach(sortedPlayers(s.players)) { p in
                        HStack {
                            Text(p.name + (p.id == view.you ? "（あなた）" : "")).bold(p.id == view.you)
                            Spacer()
                            Text(roleText(p)).font(.caption).foregroundStyle(p.finalRole == .hunter ? MapLayers.hunterColor : MapLayers.runnerColor)
                            Text(statusText(p, zombieMode: s.zombieMode)).font(.caption)
                        }
                    }
                }

                Card(title: "ミッション", hint: "全員の結果は人数だけを表示します（あなた自身の結果は「あなた」の列）") {
                    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
                        GridRow {
                            Text("")
                            Text("成功").bold()
                            Text("失敗").bold()
                            Text("無効").bold()
                            Text("あなた").bold()
                        }
                        ForEach(s.missions, id: \.index) { m in
                            let held = m.status != .notHeld
                            GridRow {
                                VStack(alignment: .leading) {
                                    Text("第\(m.index)ミッション")
                                    if let note = note(m.status) { Text(note).font(.caption2).foregroundStyle(.secondary) }
                                }
                                Text(held ? "\(m.success)人" : "－")
                                Text(held ? "\(m.failure)人" : "－")
                                Text(held ? "\(m.cancelled)人" : "－")
                                Text(personalText(view.own?.missions.first { $0.index == m.index }?.result ?? .notParticipated))
                            }
                        }
                    }
                    .font(.callout)
                }

                if isHost {
                    Button {
                        rematch()
                    } label: {
                        Text("もう一度遊ぶ").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(busy)
                }
                Text(isHost ? "同じメンバー・同じ設定でロビーに戻ります（開始地点は設定し直します）" : "ホストが「もう一度遊ぶ」を選ぶのを待っています")
                    .font(.footnote).foregroundStyle(.secondary)
                Button {
                    Task { await app.service.leaveRoom() }
                } label: {
                    Text("ホームに戻る").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .padding()
        }
    }

    /// 鬼 → 逃げ切った逃走者 → 確保された逃走者 の順
    private func sortedPlayers(_ players: [ResultPlayer]) -> [ResultPlayer] {
        let order = { (p: ResultPlayer) in p.startRole == .hunter ? 0 : p.survived ? 1 : 2 }
        return players.enumerated().sorted { a, b in
            (order(a.element), -a.element.captures, a.offset) < (order(b.element), -b.element.captures, b.offset)
        }.map(\.element)
    }

    private func roleText(_ p: ResultPlayer) -> String {
        let start = p.startRole?.label ?? "-"
        return p.roleChanged ? "\(start) → \(p.finalRole?.label ?? "-")" : start
    }

    private func statusText(_ p: ResultPlayer, zombieMode: Bool) -> String {
        if p.startRole == .hunter { return "確保 \(p.captures)人" }
        if p.survived { return "🏃 逃げ切り" }
        let when = p.caughtAfterMin.map { "開始\($0)分台に" } ?? ""
        let after = zombieMode ? "（鬼として確保 \(p.captures)人）" : ""
        return "⛓ \(when)確保\(after)"
    }

    private func note(_ status: MissionSummaryStatus) -> String? {
        switch status {
        case .endedByGameOver: return "（ゲーム終了で打ち切り）"
        case .notHeld: return "（発生前に終了）"
        case .skipped: return "（無効）"
        case .completed: return nil
        }
    }

    private func personalText(_ r: PersonalResult) -> String {
        switch r {
        case .success: return "✅ 成功"
        case .failure: return "❌ 失敗"
        case .cancelled: return "無効"
        case .notParticipated: return "－"
        }
    }

    private func rematch() {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await app.service.prepareRematch()
            } catch {
                app.toasts.show(AppModel.message(for: error))
            }
        }
    }
}
