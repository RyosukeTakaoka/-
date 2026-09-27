# 👹 リアル鬼ごっこ（iOS 版・SwiftUI ＋ Firebase）

Web 版（[`oni-game/`](../oni-game/)）と**同じ仕様**のゲームを、iPhone アプリ（SwiftUI）として作り直したものです。
サーバーは CloudKit ではなく **Firebase**（Realtime Database ＋ Cloud Functions）を使います。

- 鬼には逃走者の正確な位置は見えず、「この円の中のどこかにいる」という**可能性エリア**だけが見えます
- ゲーム中に**ミッションが4回**発生し、成功すると位置がぼやけ、失敗すると絞り込まれます
- 確保・ミッションの成功/失敗・勝敗などの**判定はすべてサーバー**で行い、iPhone は「要求」と「表示」だけをします

## 全体の構成

```
iPhone（SwiftUI アプリ）                         Firebase
┌────────────────────────┐   要求（呼び出し型関数）   ┌───────────────────────────────┐
│ 画面（Views/）          │ ───────────────────────▶ │ Cloud Functions（functions/）   │
│ GameService            │   createRoom・startGame・ │  ゲームのルール（JS 版と同じ）   │
│  ├ FirebaseGameService │   requestCapture など     │  判定・可能性エリア・ミッション  │
│  └ LocalGameService    │                          │         │ 書き出す               │
│ OniGameCore（ルール）   │ ◀─────────────────────── │ Realtime Database               │
└────────────────────────┘   読めるデータだけ購読     │  public・channels・views・結果   │
        │ 自分の GPS                                  │  locations（実位置・誰も読めない）│
        └───────────────▶ /locations/{部屋}/{自分} ──▶│  private（サーバー専用の状態）    │
                                                     └───────────────────────────────┘
```

| フォルダ | 中身 |
| --- | --- |
| `ios/OniGame/` | アプリ本体（SwiftUI の画面・地図・GPS・Firebase との通信） |
| `ios/OniGameCore/` | ゲームのルール（Swift パッケージ）。画面にも Firebase にも依存しないので、Mac でも Linux でもテストできる |
| `ios/OniGame.xcodeproj` | Xcode プロジェクト（`git pull` するだけで最新になる） |
| `ios/project.yml` | Xcode プロジェクトの設計図（`.xcodeproj` はここから XcodeGen で作ってある） |
| `functions/` | サーバー（Cloud Functions）。ルールは `oni-game/js/game` を共有して使う |
| `database.rules.json` | Security Rules（誰が何を読み書きできるか） |

### アプリのファイル

| ファイル | 役割 |
| --- | --- |
| `App/OniGameApp.swift` | アプリの入口 |
| `App/AppConfig.swift` | 設定（オンライン / 端末内モード、エミュレーター / 本番） |
| `App/AppModel.swift` | アプリ全体の状態（どのサービスを使うか・通知・開発用の視点） |
| `Services/GameService.swift` | 画面が使う唯一の窓口（インターフェース） |
| `Services/FirebaseGameService.swift` | オンライン版。要求の送信と、読めるデータの購読・組み立て |
| `Services/LocalGameService.swift` | 端末内モード（開発用）。ダミーの友達で1台で確認できる |
| `Services/LocationService.swift` | GPS（CoreLocation） |
| `Views/` | 画面（ホーム・作成・ロビー・ゲーム・結果） |
| `Map/` | 地図（MapKit）。ビューから円とピンを作って描く |

### OniGameCore（ルール）のファイル

Web 版 `oni-game/js/game/` をそのまま Swift に移したものです。

| Swift | JS 版 | 内容 |
| --- | --- | --- |
| `GameEngine.swift` | `gameEngine.js` | 状態遷移のすべて（開始・位置・確保・到達・目的地変更・時間経過・途中終了） |
| `Privacy.swift` | `privacyArea.js`・`locationPublisher.js` | 可能性エリアの作り方と公開スケジュール |
| `Missions.swift` | `missionSchedule.js`・`destinations.js`・`mission.js` | ミッションの発生時刻・目的地・判定 |
| `Rules.swift` | `capture.js`・`outcome.js`・`blurPolicy.js`・`gameArea.js`・`gameTimer.js` | 確保・勝敗・ぼかしの段階・エリア・時計 |
| `ViewChannels.swift` | `visibility.js`・`viewChannels.js` | 「誰に何を見せるか」 |
| `ResultSummary.swift` | `resultSummary.js` | 結果（位置情報を含まない） |
| `Dummies.swift` | `dev/dummyData.js`・`dummySimulator.js` | 開発用のダミー |

**JS 版と同じ結果になることをテストで確認しています**（`Tests/OniGameCoreTests/GoldenTests.swift`）。
JS 版で3ゲーム（通常・増え鬼・途中終了）を最後まで進めた記録（合計505ステップ）を作り、
Swift 版で同じ操作をして、状態・ログ・結果・チャンネル・全員分のビューがすべて一致することを比べています。
乱数（mulberry32）とハッシュ（FNV-1a）はビット単位で JS と同じになるように作ってあります。

> 👉 なぜ Swift にもルールがあるの？
> オンライン対戦では判定はサーバー（JS）だけが行います。Swift のルールは
> ①サーバーから届いたデータを画面用に組み立てる（`ViewChannels.assemble`）、
> ②端末内モード（開発用）で1台でゲームを動かす、の2つに使います。

## 必要なもの

- Mac と **Xcode 16 以上**（iOS 17 以上の iPhone またはシミュレーター）
- サーバーを手元で動かすとき: Node.js 22、Java 11 以上（Firebase Emulator 用）

## 動かし方

### 1. 最新にして Xcode で開く

```bash
git pull                 # 最新のコードとプロジェクトを受け取る（XcodeGen は不要）
open ios/OniGame.xcodeproj
```

`git pull` したとき Xcode を開いたままなら、Xcode が自動で読み込み直します。

初回は Xcode が Firebase のライブラリ（Swift Package）をダウンロードします（数分かかります）。
実機で動かすときは、Xcode の「Signing & Capabilities」で自分のチーム（Apple ID）を選び、
Bundle Identifier を自分のもの（例: `com.あなたの名前.onigame`）に変えてください。

### 2-A. 1台で試す（端末内モード・開発用）

サーバーなしで、ダミーの友達と1台で全機能を確認できます（Web 版の `?dev` と同じ）。

1. アプリを起動し、ホーム画面右上の 🛠（歯車）→「端末内モード（開発用・ダミー）」を選ぶ
2. ゲームを作成 → ロビーで「＋ ダミーの友達を追加」→ ゲーム開始
3. ゲーム画面の「🛠 視点」で、どのプレイヤーとして見るかを切り替えられます（見える情報はそのプレイヤーのルールどおり）
4. 地図をタップすると、今の視点のプレイヤーがその場所へ移動します（GPS の代わり）

### 2-B. オンラインで試す（Firebase Emulator・本番には接続しない）

```bash
# リポジトリのルートで
npm install
npm run functions:install
npm run emulators        # Auth・RTDB・Functions・Tasks のエミュレーターを起動（projectId: demo-oni-game）
```

- **シミュレーター**: そのまま Xcode で実行します（`OniEmulatorHost` が `127.0.0.1`）
- **実機**: iPhone と Mac を同じ Wi-Fi につなぎ、
  1. `firebase.json` の各エミュレーターの `"host"` を `"0.0.0.0"` にする（ほかの機器から接続できるようにする）
  2. `ios/OniGame/Info.plist` の `OniEmulatorHost` を Mac の IP アドレス（「システム設定 → Wi-Fi → 詳細」で確認）にする
- 2台（シミュレーター＋実機、または2つのシミュレーター）で起動すると、別々の匿名ユーザーとして同じ部屋で遊べます
- 1人ではゲームを開始できません（鬼1人＋逃走者1人以上が必要）

### 3. 本番の Firebase を使うとき

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作り、**Blaze（従量課金）プラン**にする
   （Cloud Functions・Cloud Tasks・Cloud Scheduler に必要。**必ず予算アラートを設定**してください）
2. Authentication で「匿名」ログインを有効にする
3. Realtime Database を作る（場所は `asia-southeast1`（シンガポール）を推奨。DB トリガーの関数は DB と同じ場所で動かす必要があるため。
   ほかの場所にしたときは、デプロイ時に `DATABASE_REGION` パラメーターでその場所を指定する）
4. サーバーをデプロイする
   ```bash
   npx firebase deploy --only database,functions --project <本番のプロジェクトID>
   ```
5. コンソールで iOS アプリを追加し（バンドル ID は `project.yml` と同じ）、`GoogleService-Info.plist` をダウンロードして
   `ios/OniGame/` に置く（**.gitignore 済み。GitHub に上げない**）
6. `ios/OniGame/Info.plist` の `OniFirebaseMode` を `production` にする

> 🔐 `GoogleService-Info.plist` の API キーは「秘密の鍵」ではありませんが、守りの前提にはしません。
> 誰が何を読めるかは **Security Rules と Cloud Functions** で決めています（下の表）。

## サーバー（Firebase）の設計

### データの置き場所（Realtime Database）

| パス | 中身 | 読める人 | 書ける人 |
| --- | --- | --- | --- |
| `/rooms/{部屋}/meta` | ホスト・参加コード・フェーズ | メンバー | サーバー |
| `/rooms/{部屋}/members/{uid}` | 名前・参加時刻 | メンバー | サーバー（名前だけ本人） |
| `/rooms/{部屋}/presence/{uid}` | オンラインか | メンバー | 本人 |
| `/rooms/{部屋}/access` | 各人の役割・状態（ルールの判定用） | メンバー | サーバー |
| `/rooms/{部屋}/public/doc` | 全員に見せてよいゲーム情報 | メンバー | サーバー |
| `/rooms/{部屋}/channels/hunterPositions` | 鬼の位置 | 参加中の鬼（設定 ON なら全員） | サーバー |
| `/rooms/{部屋}/channels/runnerPositions` | 逃走者の位置（仲間用） | 参加中の逃走者だけ | サーバー |
| `/rooms/{部屋}/channels/possibleAreas` | 可能性エリア（ぼかした円） | 参加中の鬼だけ | サーバー |
| `/rooms/{部屋}/views/{uid}` | 自分の円・目的地・クールダウン | 本人だけ | サーバー |
| `/rooms/{部屋}/results/public`・`personal/{uid}` | 結果・自分のミッション結果 | メンバー・本人だけ | サーバー |
| `/locations/{部屋}/{uid}` | **実位置**（GPS） | **誰も読めない** | 本人（ゲーム中・参加中・2秒以上あけて・時刻はサーバー時刻） |
| `/private/games/{部屋}` | サーバー専用の状態（実位置・秘密値・ミッションの予定と目的地） | 誰も読めない | サーバー |

ゲームの状態やビューは **JSON 文字列**で保存します（RTDB は null や空の配列を保存できず、形が崩れるため）。
ルールの判定に使う `access` だけは、ルールから読めるように普通のデータにしています。

### サーバーの関数（`functions/`）

| 関数 | 種類 | すること |
| --- | --- | --- |
| `createRoom` / `joinRoom` / `leaveRoom` | 呼び出し型 | 部屋の作成（4桁コード）・参加・退出（ホストが出ると解散） |
| `configureGame` | 呼び出し型 | ホストが設定・開始地点・除外エリアを決めてロビーへ（もう一度遊ぶとき） |
| `startGame` | 呼び出し型 | 役割・秘密値・ミッションの予定をサーバーで作って開始 |
| `requestCapture` | 呼び出し型 | 「確保！」。対象はサーバーが実位置から選ぶ（15秒より古い位置は使わない） |
| `claimArrival` | 呼び出し型 | 「目的地に着いた」の申告。サーバーの実位置で判定 |
| `changeDestination` | 呼び出し型 | 目的地の変更（1ゲーム1回） |
| `abortGame` / `prepareRematch` | 呼び出し型 | 途中終了・もう一度遊ぶ（ホストだけ） |
| `onLocationWritten` | DB トリガー | GPS が届いたら検証（ゲーム中・参加中・秒速12m以下）して到達判定・公開 |
| `advanceGame` | タスクキュー | 次に何かが起きる時刻（公開・ミッション開始/終了・時間切れ）に1件だけ予約して進める |
| `sweepRooms` | 定期実行（10分ごと） | 止まったゲームの再予約・放置された部屋（1日）の削除 |

どの要求も、最初に「遅れている処理（時間切れ・ミッション）」を片付けてから判定するので、
予約の実行が遅れても、時間切れ後の確保や終了後の到達は成立しません。
ゲームが終わると、実位置・秘密値・可能性エリアはすぐに消えます。

## テスト

```bash
# ゲームのルール（Swift）: JS 版との一致テスト＋ルールのテスト
cd ios/OniGameCore && swift test

# ゲームのルール（JS）
npm test

# サーバー（エミュレーター）: 部屋・ゲーム全体の流れ・ミッション・掃除係・Security Rules の攻撃テスト
npm run test:emulator
```

JS 版のルール（`oni-game/js/game`）を変えたら、`npm run ios:golden` で一致テストの記録を作り直し、
Swift 版も同じように直して `swift test` が通ることを確認してください。

## Web 版との違い

| 項目 | Web 版 | iOS 版 |
| --- | --- | --- |
| 地図 | Google Maps（APIキーが必要）/ 簡易マップ | MapKit（iOS 標準・APIキー不要） |
| 開発モード | URL に `?dev` | ホーム画面の 🛠 メニューで「端末内モード」 |
| 招待 | `?room=1234` のリンク | `onigame://join?code=1234` のリンク（共有シート） |
| 通知 | 画面下のメッセージ＋バイブ | 画面下のメッセージ＋触覚フィードバック |
| 画面を消したとき | 位置が送れなくなる | ゲーム中だけバックグラウンドでも位置を送る（画面上部に青い表示。終了で停止） |
| オンライン対戦 | 部屋の作成・参加まで | ゲームの開始から結果・もう一度遊ぶまで全部 |

ゲームのルール（可能性エリア・ミッション・ぼかし・確保・勝敗・結果）は同じです。

## 防げないこと（前提）

- **GPS の偽装**: 位置は端末の申告なので、本物かどうかはサーバーでは確かめられません（不自然な速さの移動は無視します）
- **受信済みのデータ**: 権限を失う前に受け取ったデータは、その端末に残ります（例: 鬼になった直後の元逃走者）
- **目的地の安全**: 地図データを使っていないため、車道・水辺・私有地などはホストの除外エリアに頼ります

## 安全のために

- 道路への飛び出し・歩きスマホはしない
- 私有地・立入禁止区域・水辺など危険な場所には入らない
- 公園や学校など、許可のある安全な場所で遊ぶ
