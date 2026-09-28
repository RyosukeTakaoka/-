# リアル鬼ごっこ

「鬼ごっこ ＋ リアルタイムミッション ＋ 情報戦」のスマホ向けゲームです。

| フォルダ | 中身 |
| --- | --- |
| [`ios/`](ios/) | **iOS アプリ（SwiftUI）**。使い方は [ios/README.md](ios/README.md) |
| [`supabase/`](supabase/) | **サーバー（Supabase: Edge Functions ＋ Postgres）**。iOS 版のオンライン対戦で使う（無料プランのまま動く） |
| [`functions/`](functions/)・`database.rules.json` | サーバー（Firebase 版・Web 版のオンライン対戦で使う。部屋の作成・参加・メンバー・在席のみ） |
| [`oni-game/`](oni-game/) | Web 版（元の実装）。ゲームのルール `oni-game/js/game` は両方のサーバーと共有している。詳しくは [oni-game/README.md](oni-game/README.md) |

```bash
npm test                 # ゲームのルールのテスト（Node.js 20 以上）
npm run supabase:start   # サーバー（Supabase）を手元で動かす（iOS アプリから接続できる。Docker が必要）
npm run supabase:test    # サーバー（Supabase）のテスト
npm run test:emulator    # サーバー（Firebase・Web版）のテスト（Firebase Emulator。Java が必要）
npm run emulators        # サーバー（Firebase・Web版）を手元で動かす（本番には接続しない）
cd ios/OniGameCore && swift test   # Swift 版のルールのテスト（JS 版と同じ結果になるかも確認）
npm start                # Web 版を http://localhost:8000 で起動（Python 3 が必要）
```

- `supabase/migrations/` … テーブル定義・Row Level Security（誰が何を読み書きできるか）
- `supabase/functions/` … Edge Functions（Deno）。ゲームロジックは `oni-game/js` から `_shared/` にコピーして使う（`npm run supabase:build`）
- `firebase.json` `.firebaserc` `database.rules.json` … Firebase の設定（エミュレーター用の `demo-oni-game`）
- `functions/` … Cloud Functions（第2世代）。ゲームロジックは `oni-game/js` から `functions/shared` にコピーして使う（`npm run functions:build`）
- `tests-emulator/` … Firebase エミュレーターを使うテスト（部屋・ゲーム全体の流れ・Security Rules の攻撃テスト）
