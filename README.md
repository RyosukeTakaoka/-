# リアル鬼ごっこ

「鬼ごっこ ＋ リアルタイムミッション ＋ 情報戦」のスマホ向けWebアプリです。
アプリ本体は [`oni-game/`](oni-game/) にあります。詳しくは [oni-game/README.md](oni-game/README.md) を見てください。

```bash
npm start   # http://localhost:8000 で起動（Python 3 が必要）
npm test    # ロジックのテスト（Node.js 20 以上）
npm run test:emulator  # Firebase Emulator を使うテスト（Java が必要）
```

- `firebase.json` `.firebaserc` `database.rules.json` … Firebase の設定（エミュレーター用の `demo-oni-game`）
- `functions/` … Cloud Functions（第2世代）。ゲームロジックは `oni-game/js` から `functions/shared` にコピーして使う（`npm run functions:build`）
- `tests-emulator/` … エミュレーターを使うテスト（Security Rules の許可・拒否など）
