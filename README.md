# リアル鬼ごっこ

「鬼ごっこ ＋ リアルタイムミッション ＋ 情報戦」のスマホ向けゲームです。

| フォルダ | 中身 |
| --- | --- |
| [`ios/`](ios/) | **iOS アプリ（SwiftUI）**。使い方は [ios/README.md](ios/README.md) |
| [`functions/`](functions/)・`database.rules.json` | **サーバー（Firebase: Cloud Functions ＋ Realtime Database）**。iOS 版のオンライン対戦で使う |
| [`oni-game/`](oni-game/) | Web 版（元の実装）。ゲームのルール `oni-game/js/game` はサーバーと共有している。詳しくは [oni-game/README.md](oni-game/README.md) |

```bash
npm test                 # ゲームのルールのテスト（Node.js 20 以上）
npm run test:emulator    # サーバーのテスト（Firebase Emulator。Java が必要）
npm run emulators        # サーバーを手元で動かす（iOS アプリから接続できる。本番には接続しない）
cd ios/OniGameCore && swift test   # Swift 版のルールのテスト（JS 版と同じ結果になるかも確認）
npm start                # Web 版を http://localhost:8000 で起動（Python 3 が必要）
```

- `firebase.json` `.firebaserc` `database.rules.json` … Firebase の設定（エミュレーター用の `demo-oni-game`）
- `functions/` … Cloud Functions（第2世代）。ゲームロジックは `oni-game/js` から `functions/shared` にコピーして使う（`npm run functions:build`）
- `tests-emulator/` … エミュレーターを使うテスト（部屋・ゲーム全体の流れ・Security Rules の攻撃テスト）
