# 👹 リアル鬼ごっこ（iOS 版・SwiftUI ＋ Supabase）

Web 版（[`oni-game/`](../oni-game/)）と**同じ仕様**のゲームを、iPhone アプリ（SwiftUI）として作り直したものです。
サーバーは CloudKit ではなく **Supabase**（Postgres ＋ Edge Functions）を使います。

- 鬼には逃走者の正確な位置は見えず、「この円の中のどこかにいる」という**可能性エリア**だけが見えます
- ゲーム中に**ミッションが4回**発生し、成功すると位置がぼやけ、失敗すると絞り込まれます
- 確保・ミッションの成功/失敗・勝敗などの**判定はすべてサーバー**で行い、iPhone は「要求」と「表示」だけをします

> なぜ Firebase ではなく Supabase？ Cloud Functions は Firebase の無料（Spark）プランでは動かせず、
> Blaze（従量課金）プランへの変更＝カード登録が必須になります。Supabase なら無料プランのまま
> オンライン対戦のサーバーを動かせます。判定のルール自体（`oni-game/js/game`）は変えていません。

## 全体の構成

```
iPhone（SwiftUI アプリ）                          Supabase
┌────────────────────────┐   要求（呼び出し型 Function） ┌───────────────────────────────┐
│ 画面（Views/）          │ ─────────────────────────▶ │ Edge Functions（supabase/functions/）│
│ GameService            │   create-room・start-game・ │  ゲームのルール（JS 版と同じ）   │
│  ├ SupabaseGameService │   request-capture など      │  判定・可能性エリア・ミッション  │
│  └ LocalGameService    │                            │         │ 書き出す               │
│ OniGameCore（ルール）   │ ◀───────────────────────── │ Postgres（Row Level Security）  │
└────────────────────────┘   一定間隔で読み直す          │  public_doc・channels・views・結果│
        │ 自分の GPS                                    │  locations（実位置・誰も読めない）│
        └───────────────▶ report-location（呼び出し型）─▶│  game_state（サーバー専用の状態） │
                                                       └───────────────────────────────┘
```

| フォルダ | 中身 |
| --- | --- |
| `ios/OniGame/` | アプリ本体（SwiftUI の画面・地図・GPS・Supabase との通信） |
| `ios/OniGameCore/` | ゲームのルール（Swift パッケージ）。画面にも Supabase にも依存しないので、Mac でも Linux でもテストできる |
| `ios/OniGame.xcodeproj` | Xcode プロジェクト（`git pull` するだけで最新になる） |
| `ios/project.yml` | Xcode プロジェクトの設計図（`.xcodeproj` はここから XcodeGen で作ってある） |
| `supabase/functions/` | サーバー（Edge Functions）。ルールは `oni-game/js/game` を共有して使う |
| `supabase/migrations/` | テーブル定義・Row Level Security（誰が何を読み書きできるか） |

### アプリのファイル

| ファイル | 役割 |
| --- | --- |
| `App/OniGameApp.swift` | アプリの入口 |
| `App/AppConfig.swift` | 設定（オンライン / 端末内モード、ローカル / 本番） |
| `App/AppModel.swift` | アプリ全体の状態（どのサービスを使うか・通知・開発用の視点） |
| `Services/GameService.swift` | 画面が使う唯一の窓口（インターフェース） |
| `Services/SupabaseGameService.swift` | オンライン版。要求の送信と、読めるデータの定期的な読み直し |
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
- サーバーを手元で動かすとき: Node.js 22、[Supabase CLI](https://supabase.com/docs/guides/cli)、Docker Desktop（ローカルの Supabase は Docker で動く）

## 動かし方

### 1. 最新にして Xcode で開く

```bash
git pull                 # 最新のコードとプロジェクトを受け取る（XcodeGen は不要）
open ios/OniGame.xcodeproj
```

`git pull` したとき Xcode を開いたままなら、Xcode が自動で読み込み直します。

初回は Xcode が Supabase のライブラリ（Swift Package）をダウンロードします（数分かかります）。
実機で動かす・App Store に出すときは、**Team を `ios/Config/Local.xcconfig` に書きます**（最初の1回だけ）。

```bash
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
# Local.xcconfig を開き、DEVELOPMENT_TEAM = の後ろを自分の Team ID（10文字）にする
```

- `Local.xcconfig` は Git 管理外なので、`git pull` や `xcodegen generate` をしても Team は変わりません
- Bundle Identifier の既定値（`com.takaoka.app.onigame`）は `ios/Config/Signing.xcconfig` にあります
- Xcode の「Signing & Capabilities」画面で Team を選ばないでください（共有の `project.pbxproj` が書き換わり、`git pull` でぶつかります）
- バージョン・ビルド番号も `Local.xcconfig` に `MARKETING_VERSION = 1.0.1`・`CURRENT_PROJECT_VERSION = 2` のように書きます
  （Info.plist には `$(MARKETING_VERSION)`・`$(CURRENT_PROJECT_VERSION)` と書いてあり、ここの値が入ります。Xcode の General 画面では変えないでください）

### 2-A. 1台で試す（端末内モード・開発用）

サーバーなしで、ダミーの友達と1台で全機能を確認できます（Web 版の `?dev` と同じ）。

1. アプリを起動し、ホーム画面右上の 🛠（歯車）→「端末内モード（開発用・ダミー）」を選ぶ
2. ゲームを作成 → ロビーで「＋ ダミーの友達を追加」→ ゲーム開始
3. ゲーム画面の「🛠 視点」で、どのプレイヤーとして見るかを切り替えられます（見える情報はそのプレイヤーのルールどおり）
4. 地図をタップすると、今の視点のプレイヤーがその場所へ移動します（GPS の代わり）

### 2-B. オンラインで試す（ローカルの Supabase・本番には接続しない）

```bash
# リポジトリのルートで
npm install
npm run supabase:start   # Postgres・Auth・Edge Functions をローカルで起動（Docker が必要）
```

初回はコンテナのダウンロードで数分かかります。起動すると `http://127.0.0.1:54321` で API が立ち上がります
（`http://127.0.0.1:54323` の Studio 画面でテーブルの中身を見られます）。

- **シミュレーター**: そのまま Xcode で実行します（`OniEmulatorHost` が `127.0.0.1`）
- **実機**: iPhone と Mac を同じ Wi-Fi につなぎ、`ios/OniGame/Info.plist` の `OniEmulatorHost` を
  Mac の IP アドレス（「システム設定 → Wi-Fi → 詳細」で確認）にする
- 2台（シミュレーター＋実機、または2つのシミュレーター）で起動すると、別々の匿名ユーザーとして同じ部屋で遊べます
- 1人ではゲームを開始できません（鬼1人＋逃走者1人以上が必要）
- 終わったら `npx supabase stop` で止められます

### 3. 本番の Supabase を使うとき

1. [Supabase](https://supabase.com/) で無料アカウントを作り、新しいプロジェクトを作る（**カード登録は不要**）
2. Authentication で「Anonymous Sign-Ins」を有効にする（Providers 画面）
3. サーバーをデプロイする
   ```bash
   npx supabase login
   npx supabase link --project-ref <プロジェクトの参照ID>   # Project Settings → General で確認
   npm run supabase:build                                  # oni-game/js/game を Edge Functions 用にコピー
   npx supabase db push                                    # テーブル・Row Level Security を反映
   npx supabase functions deploy                            # Edge Functions をデプロイ
   ```
4. `supabase/production-setup.sql` の指示に沿って、SQL Editor で1回だけ SQL を実行する
   （ゲームの時間経過を進める定期実行 `pg_cron` に、本番の URL と鍵を教える。実行しないとゲームは動くが、
   誰も操作しないと時間経過だけが止まったままになる）
5. `ios/project.yml` の `OniSupabaseUrl`（Project Settings → API → Project URL）・
   `OniSupabaseAnonKey`（同 → anon public key。どちらも「公開してよい」値）のコメントを外して値を入れ、
   `OniSupabaseMode` を `production` にして、`xcodegen generate`

> 🔐 anon key は「秘密の鍵」ではありませんが、守りの前提にはしません。
> 誰が何を読めるかは **Row Level Security と Edge Functions** で決めています（下の表）。
> 予算アラートは Supabase では必須ではありません（無料枠を超えると新規の書き込みが止まるだけで、
> 意図せず高額請求になる設計にはなっていません）が、心配なら Billing 画面で使用量を確認してください。

## サーバー（Supabase）の設計

### テーブル（Postgres）

Firebase 版の Realtime Database のパス構成を、そのままテーブルに置き換えています。

| テーブル | 中身 | 読める人 | 書ける人 |
| --- | --- | --- | --- |
| `rooms` | ホスト・参加コード・フェーズ | メンバー | サーバー |
| `members` | 名前・参加時刻 | メンバー | サーバー（名前だけ `rename_self()` 経由で本人） |
| `presence` | オンラインか（ハートビート） | メンバー | 本人 |
| `access` | 各人の役割・状態（RLS の判定用） | メンバー | サーバー |
| `public_doc` | 全員に見せてよいゲーム情報 | メンバー | サーバー |
| `channels`（`hunterPositions`） | 鬼の位置 | 参加中の鬼（設定 ON なら全員） | サーバー |
| `channels`（`runnerPositions`） | 逃走者の位置（仲間用） | 参加中の逃走者だけ | サーバー |
| `channels`（`possibleAreas`） | 可能性エリア（ぼかした円） | 参加中の鬼だけ | サーバー |
| `views` | 自分の円・目的地・クールダウン | 本人だけ | サーバー |
| `results_public` / `results_personal` | 結果・自分のミッション結果 | メンバー・本人だけ | サーバー |
| `locations` | **実位置**（GPS） | **誰も読めない** | サーバーだけ（`report-location` 経由） |
| `game_state` | サーバー専用の状態（実位置・秘密値・ミッションの予定と目的地） | 誰も読めない | サーバー |

ゲームの状態やビューは jsonb 列にそのまま保存します。誰が何を読めるかは Row Level Security（`supabase/migrations/*_rls.sql`）で決めています。

### サーバーの関数（`supabase/functions/`）

| 関数 | 種類 | すること |
| --- | --- | --- |
| `create-room` / `join-room` / `leave-room` | 呼び出し型 | 部屋の作成（4桁コード）・参加・退出（ホストが出ると解散） |
| `configure-game` | 呼び出し型 | ホストが設定・開始地点・除外エリアを決めてロビーへ（もう一度遊ぶとき） |
| `start-game` | 呼び出し型 | 役割・秘密値・ミッションの予定をサーバーで作って開始 |
| `request-capture` | 呼び出し型 | 「確保！」。対象はサーバーが実位置から選ぶ（15秒より古い位置は使わない） |
| `claim-arrival` | 呼び出し型 | 「目的地に着いた」の申告。サーバーの実位置で判定 |
| `change-destination` | 呼び出し型 | 目的地の変更（1ゲーム1回） |
| `abort-game` / `prepare-rematch` | 呼び出し型 | 途中終了・もう一度遊ぶ（ホストだけ） |
| `report-location` | 呼び出し型 | GPS の送信。検証（ゲーム中・参加中・秒速12m以下）して到達判定・公開 |
| `advance-due-games` | 定期実行（`pg_cron`・1分ごと） | 次に何かが起きる時刻（公開・ミッション開始/終了・時間切れ）を過ぎたゲームを進める。掃除係も兼ねる |

Cloud Tasks に相当するサービスが無いため、Firebase 版の「1ゲームに1件、正確な時刻に予約する」方式ではなく、
1分ごとに全部屋をポーリングする方式にしています。正しさには影響しません。
どの要求も、最初に「遅れている処理（時間切れ・ミッション）」を片付けてから判定するので、
ポーリングの間隔がずれても、時間切れ後の確保や終了後の到達は成立しません。
ゲームが終わると、実位置・秘密値・可能性エリアはすぐに消えます。

### リアルタイム表示について

Firebase 版は RTDB の購読（`onValue`）で更新を即座に受け取っていましたが、iOS 版は
**一定間隔（約1.2秒）で読み直す**方式にしています。ゲーム画面はもともと 0.25秒ごとに時計を更新する作りなので、
その仕組みをそのまま流用しています。Supabase には Realtime（Postgres の変更を購読する仕組み）もありますが、
まずは実装と検証がしやすいポーリング方式にしました。表示の即時性を上げたくなったら、
`SupabaseGameService.swift` の `poll()` を Realtime の購読に置き換えられます。

## テスト

```bash
# ゲームのルール（Swift）: JS 版との一致テスト＋ルールのテスト
cd ios/OniGameCore && swift test

# ゲームのルール（JS）
npm test

# サーバー（ローカルの Supabase）: 部屋・ゲーム全体の流れ・ミッション・Row Level Security のテスト
npm run supabase:test
```

JS 版のルール（`oni-game/js/game`）を変えたら、`npm run ios:golden` で一致テストの記録を作り直し、
Swift 版も同じように直して `swift test` が通ることを確認してください。

## Web 版との違い

| 項目 | Web 版 | iOS 版 |
| --- | --- | --- |
| サーバー | Firebase（部屋の作成・参加まで） | Supabase（ゲームの開始から結果・もう一度遊ぶまで全部） |
| 地図 | Google Maps（APIキーが必要）/ 簡易マップ | MapKit（iOS 標準・APIキー不要） |
| 開発モード | URL に `?dev` | ホーム画面の 🛠 メニューで「端末内モード」 |
| 招待 | `?room=1234` のリンク | `onigame://join?code=1234` のリンク（共有シート） |
| 通知 | 画面下のメッセージ＋バイブ | 画面下のメッセージ＋触覚フィードバック |
| 画面を消したとき | 位置が送れなくなる | ゲーム中だけバックグラウンドでも位置を送る（画面上部に青い表示。終了で停止） |

ゲームのルール（可能性エリア・ミッション・ぼかし・確保・勝敗・結果）は同じです。

## 防げないこと（前提）

- **GPS の偽装**: 位置は端末の申告なので、本物かどうかはサーバーでは確かめられません（不自然な速さの移動は無視します）
- **受信済みのデータ**: 権限を失う前に受け取ったデータは、その端末に残ります（例: 鬼になった直後の元逃走者）
- **目的地の安全**: 地図データを使っていないため、車道・水辺・私有地などはホストの除外エリアに頼ります

## 安全のために

- 道路への飛び出し・歩きスマホはしない
- 私有地・立入禁止区域・水辺など危険な場所には入らない
- 公園や学校など、許可のある安全な場所で遊ぶ
