# 👹 リアル鬼ごっこ（oni-game）

友達同士で、学校・公園・街などのリアルな空間を使って遊ぶ鬼ごっこアプリです。
地図（Google Maps）をゲームボードにして、開始地点を中心とした円形エリアで遊びます。

- 鬼には逃走者の正確な位置は見えず、「この円の中のどこかにいる」という**可能性エリア**だけが見えます
- ゲーム中に**ミッションが4回**発生し、成功すると位置がぼやけ、失敗すると絞り込まれます

## 開発の進み具合

| STEP | 内容 | 状態 |
| --- | --- | --- |
| 1 | Google Maps＋基本ゲーム画面 | ✅ 完了 |
| 2 | ゲームエリア・プレイヤーシステム | 未着手 |
| 3 | 位置情報のプライバシー処理 | 未着手 |
| 4 | ミッションシステム | 未着手 |
| 5 | ミッション結果による精度変更 | 未着手 |
| 6 | ゲーム終了・結果画面 | 未着手 |
| 7 | Firebase連携 | 未着手 |
| 8 | 実機テスト・改善 | 未着手 |

## 動かし方

ビルドは不要です。ES Modules を使うため、ファイルを直接開くのではなく HTTP サーバー経由で開いてください。

```bash
# リポジトリのルートで
npm start
# または
python3 -m http.server 8000 --directory oni-game
```

ブラウザで http://localhost:8000 を開きます。
PCのブラウザの開発者ツールで「スマホ表示」にすると確認しやすいです。

### Google Maps を使う

APIキーが無くても、方眼紙の**簡易マップ**で全機能を確認できます。Google Maps を使うときは:

1. 設定ファイルを作る
   ```bash
   cp oni-game/config/config.example.js oni-game/config/config.js
   ```
2. `oni-game/config/config.js` の `googleMapsApiKey` に自分のキーを書く

`config/config.js` は `.gitignore` 済みなので GitHub には上がりません。

#### APIキーを安全に管理するために

Google Maps JavaScript API のキーは、仕組み上ブラウザに送られるため「完全に隠す」ことはできません。
そのため、**キーが漏れても悪用されない設定**にすることが大切です。Google Cloud Console で次を設定してください。

- **アプリケーションの制限**: 「HTTPリファラー」にして、`http://localhost:8000/*` と公開先のURL（例: `https://<ユーザー名>.github.io/*`）だけを許可
- **APIの制限**: 「Maps JavaScript API」だけに限定（STEP 4 で Places API を使う場合はそれも追加）
- **割り当て（クォータ）と予算アラート**: 使いすぎたときに気付けるようにする
- キーは GitHub・スクリーンショット・チャットに貼らない。漏れたらすぐ再発行する

公開時（GitHub Pages など）は、GitHub Actions の Secrets からデプロイ時に `config.js` を生成する方式にします（公開の段階で追加予定）。

### スマホの実機で確認する

位置情報は **HTTPS**（または localhost）でしか使えません。実機で確認するときは GitHub Pages などの HTTPS で公開するか、
`npx cloudflared tunnel --url http://localhost:8000` のようなトンネルを使ってください。

## 現在できること（STEP 1）

1. **ホーム**: 名前入力、ゲーム作成、ルームコード入力（参加はFirebase導入後）、遊び方と安全上の注意
2. **ゲーム作成**: ゲーム時間（5〜60分）、エリア半径（100m〜5km）、初期ぼかし（50m〜1km）、鬼の人数（1〜10人）
3. **開始地点**: 現在地を使う、または地図タップで選ぶ。エリアの円がその場でプレビューされる
4. **ルーム**: ルームコード表示、招待リンクの共有、参加者一覧、ダミーの友達の追加（開発用）
5. **ゲーム開始**: 鬼をランダムに決定（複数鬼対応）、地図にエリア・開始地点・プレイヤーを表示、残り時間のカウントダウン

> ⚠ STEP 1 では確認のため全員の位置をそのまま表示しています（画面にも「開発表示」と出ます）。
> STEP 3 で、鬼には可能性エリアだけを見せる表示に置き換えます。

## フォルダ構成

```
oni-game/
├── index.html              読み込むだけの入れ物（画面は JS が描画）
├── config/
│   └── config.example.js   設定のひな形（本物のキーは config.js に書く・Git管理外）
├── css/
│   ├── reset.css / common.css   リセット・共通部品
│   ├── home.css / create.css / lobby.css / game.css   画面ごと
│   └── map.css             地図上のマーカー・簡易マップ
├── js/
│   ├── main.js             入口。画面を登録して起動
│   ├── core/               アプリの土台
│   │   ├── router.js       画面遷移
│   │   ├── store.js        購読できる状態管理
│   │   └── config.js       設定ファイルの読み込み
│   ├── screens/            画面のUIと操作（ルールは持たない）
│   │   ├── home.js / create.js / lobby.js / game.js
│   │   └── components/optionGroup.js
│   ├── game/               ゲームのルール（DOMや地図に依存しない）
│   │   ├── gameState.js    ゲーム全体の状態とアクション
│   │   ├── settings.js     設定の選択肢と検証
│   │   ├── gameArea.js     円形エリア・エリア内判定・ランダム地点
│   │   ├── player.js       プレイヤーと役割（鬼・逃走者）
│   │   └── gameTimer.js    残り時間
│   ├── map/                地図（ゲームボード）
│   │   ├── map.js          ボードを作る窓口（Google / 簡易 を自動選択）
│   │   ├── loader.js       Google Maps API の読み込み
│   │   ├── googleBoard.js  Google Maps 版ボード
│   │   ├── fallbackBoard.js 簡易マップ版ボード
│   │   └── markers.js      円・マーカーの見た目
│   ├── services/           外部とのやりとり（Firebase で差し替える層）
│   │   ├── roomService.js  ルーム作成・参加・参加者
│   │   └── locationService.js 端末のGPS
│   ├── dev/dummyData.js    ダミープレイヤー・ダミー位置
│   └── utils/              汎用処理（distance.js / random.js / dom.js）
└── assets/                 アイコン・画像
```

今後のSTEPで追加するファイル:

- STEP 3: `js/map/privacyArea.js`（可能性エリアの計算）
- STEP 4〜5: `js/game/mission.js` ほか（発生スケジュール・目的地生成）
- STEP 6: `js/screens/result.js`、`css/result.css`
- STEP 7: `js/firebase/`（`firebaseConfig.js`・`auth.js`・`room.js`・`realtime.js`・`locationSync.js`）

## 設計のポイント

- **ルールと画面の分離**: `game/` はDOMや地図を知らない純粋なロジックなので、Node.js でテストできます（リポジトリ直下の `tests/`）
- **地図の差し替え**: 画面は `map/map.js` の「ボード」だけを使うので、Google Maps と簡易マップを同じコードで扱えます
- **Firebase を後から足しやすく**: 画面は `services/roomService.js` のメソッドだけを呼びます。STEP 7 では同じメソッドを持つ Firebase 版に差し替え、受け取ったデータを `gameState` に入れるだけで画面が更新されます
- **位置情報のプライバシー**: 実際のGPS座標は `services/locationService.js` から入り、鬼側に渡すときは必ず `map/privacyArea.js`（STEP 3）を通します。Firebase 導入後も、鬼の端末に正確な座標が届かない構成にします

## 安全のために

- 道路への飛び出し・歩きスマホはしない
- 私有地・立入禁止区域・水辺など危険な場所には入らない
- 公園や学校など、許可のある安全な場所で遊ぶ
