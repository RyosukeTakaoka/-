// ルーム（ロビー）画面: 友達の招待・ルール・参加者一覧・ゲーム開始
// 表示は session（gameService）だけを使う。参加者の変化はオンラインならリアルタイムに届く。

import SwiftUI
import OniGameCore

struct LobbyView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmLeave = false
    @State private var starting = false

    var body: some View {
        let s = app.service.session
        let needed = s.settings.hunterCount + 1
        ScrollView {
            VStack(spacing: 12) {
                Card {
                    VStack(spacing: 6) {
                        Text("ルームコード").foregroundStyle(.secondary)
                        Text(s.roomCode ?? "----")
                            .font(.system(size: 48, weight: .heavy, design: .monospaced))
                            .textSelection(.enabled)
                        if let code = s.roomCode {
                            ShareLink(item: inviteURL(code), message: Text("リアル鬼ごっこに参加しよう！ルームコード: \(code)")) {
                                Label("友達を招待", systemImage: "square.and.arrow.up")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }

                Card(title: "ルール") {
                    RulesList(settings: s.settings)
                }

                Card(title: "参加者 (\(s.players.count)人)") {
                    ForEach(s.players) { p in
                        HStack {
                            Text(p.name)
                            Spacer()
                            Text(tags(p, selfId: s.selfId)).font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                    if app.isDevMode {
                        Button("＋ ダミーの友達を追加（開発用）") {
                            do { try app.service.addDummyPlayer() } catch { app.toasts.show(AppModel.message(for: error)) }
                        }
                        .buttonStyle(.bordered)
                    }
                }

                Text("鬼と逃走者はゲーム開始時にランダムで決まります。").font(.footnote).foregroundStyle(.secondary)

                Button {
                    start()
                } label: {
                    Text("ゲーム開始").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!s.isHost || s.players.count < needed || starting)

                Text(startHint(s, needed: needed)).font(.footnote).foregroundStyle(.secondary)
            }
            .padding()
        }
        .navigationTitle("ルーム")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("退出") { confirmLeave = true }
            }
        }
        .confirmationDialog(s.isHost ? "ルームを解散してホームに戻りますか？" : "ルームから退出しますか？",
                            isPresented: $confirmLeave, titleVisibility: .visible) {
            Button(s.isHost ? "解散する" : "退出する", role: .destructive) {
                Task { await app.service.leaveRoom() }
            }
        }
    }

    private func inviteURL(_ code: String) -> URL {
        URL(string: "onigame://join?code=\(code)")!
    }

    private func tags(_ p: LobbyPlayer, selfId: String?) -> String {
        [
            p.isHost ? "👑 ホスト" : nil,
            p.id == selfId ? "あなた" : nil,
            p.isDummy ? "ダミー" : nil,
            p.online == false ? "オフライン" : nil, // 在席は目安（切断の反映には時間がかかることがある）
        ].compactMap { $0 }.joined(separator: " / ")
    }

    private func startHint(_ s: Session, needed: Int) -> String {
        if !s.isHost { return "ホストの開始を待っています…" }
        if s.players.count < needed { return "鬼\(s.settings.hunterCount)人＋逃走者1人以上、あと\(needed - s.players.count)人必要です" }
        return ""
    }

    private func start() {
        starting = true
        Task {
            defer { starting = false }
            do {
                try await app.service.startGame()
            } catch {
                app.toasts.show(AppModel.message(for: error))
            }
        }
    }
}

struct RulesList: View {
    var settings: GameSettings

    var body: some View {
        let rows: [(String, String)] = [
            ("ゲーム時間", "\(settings.durationMin)分"),
            ("エリア半径", Geo.formatDistance(Double(settings.radiusM))),
            ("初期ぼかし", Geo.formatDistance(Double(settings.initialBlurM))),
            ("位置の公開間隔", GameSettings.formatInterval(settings.revealIntervalSec)),
            ("鬼の位置", settings.showHuntersToRunners ? "逃走者に見せる" : "逃走者に見せない"),
            ("鬼の人数", "\(settings.hunterCount)人"),
            ("確保距離", "\(settings.captureRadiusM)m"),
            ("増え鬼", settings.zombieMode ? "ON（捕まると鬼になる）" : "OFF（捕まると脱落）"),
        ]
        Grid(alignment: .leading, verticalSpacing: 4) {
            ForEach(rows.indices, id: \.self) { i in
                GridRow {
                    Text(rows[i].0).foregroundStyle(.secondary)
                    Text(rows[i].1)
                }
            }
        }
        .font(.callout)
    }
}
