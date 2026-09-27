# STEP 7-A 設計レビュー：ゲームの権威をサーバーへ移す

> 状態: 7-A 承認済み。7-A2（Firebase なしの準備）実装済み。7-B 以降は未着手（Firebase SDK・Cloud Functions のコードは未追加）。
>
> **7-A2 での見直し**: GPS 由来のデータの持ち方を再検討し、「端末は `/locations` にだけ書き、公開用の位置はサーバーが作る（案B）」に変更した（→ 11章）。6章・7章・10章はこの結論に合わせて更新済み。

方針は「Firebase を追加する」ではなく「**ゲームの判定をすべてサーバー側で確定させ、クライアントは要求と表示だけにする**」。

---

## 1. 現在のコード構造（STEP 6 時点の確認結果）

| 層 | ファイル | サーバーへ移植できるか |
| --- | --- | --- |
| ルール（純粋関数） | `game/capture.js` `outcome.js` `visibility.js` `locationPublisher.js` `mission.js` `missionSchedule.js` `destinations.js` `blurPolicy.js` `resultSummary.js` `player.js` `settings.js` `gameArea.js` `gameTimer.js` | **そのまま移植可能**。DOM・window・navigator を一切使っていない。時刻（`now`）と乱数（`rng`）は引数で受け取る形になっている |
| 可能性エリア | `map/privacyArea.js` | **そのまま移植可能**。依存は `utils/distance.js` と `utils/random.js` だけ。ただし表示ではなくロジックなので `game/` へ移すのが適切（下記） |
| 汎用 | `utils/distance.js` `utils/random.js` | 移植可能。`random.js` は `globalThis.crypto` を使うが Node.js 20 以上（Cloud Functions の実行環境）にもある |
| 状態の管理 | `game/gameState.js` | **このままでは移植できない**。モジュール全体で1つの状態（シングルトン）を持ち、`Date.now()` を既定値に使い、`missionRandom` をモジュール変数で持っている。サーバーでは部屋ごとに状態を読み込んで処理する必要がある |
| 画面 | `screens/*.js` | 大半は `getPlayerView()` の結果だけを使っているが、**生の状態（`gameStore.getState()`）を直接読んでいる箇所**がある（`game.js` の公開通知時の役割判定・開始時の `selfId`/`area`、`lobby.js`・`create.js`・`result.js`）。Firebase 版ではクライアントに生の状態が無いので、ここを直す必要がある |
| 通信の窓口 | `services/roomService.js` | ルーム作成・参加・ダミー追加だけ。ゲームの操作（開始・確保・目的地変更など）は画面が `gameState.js` を直接呼んでいる |
| 開発用 | `dev/dummySimulator.js` `dev/devPanel.js` | 生の状態を読む。**端末内モード専用**として残す |

ポイント:

- 移植が必要な「ルール」の大部分は、すでに `now` と `rng` を引数で受け取る純粋関数になっており、Node.js のテスト（101件）で動いている。**アルゴリズムを書き直す必要はない**
- 作り直しが必要なのは「状態をどこに持つか（`gameState.js`）」と「画面がどこからデータを受け取るか」の2か所

---

## 2. サーバーへ移す責務（クライアントでは確定させない）

| 責務 | 今の場所 | Firebase 版での場所 |
| --- | --- | --- |
| 役割の決定・ゲーム開始 | `gameState.startGame` | Cloud Functions（呼び出し型） |
| 秘密値の生成・管理 | `locationPublisher.initPrivacy` | Cloud Functions（private に保存） |
| ミッションのスケジュール・目的地の生成と管理 | `missionSchedule` `destinations` | Cloud Functions（private に保存） |
| 可能性エリアの生成・公開 | `locationPublisher.publishIfDue` | Cloud Functions（予約実行） |
| 確保の判定 | `capture.attemptCapture` | Cloud Functions（呼び出し型） |
| ミッション到達・失敗の判定 | `mission.checkArrivals` / `advanceMissions` | Cloud Functions |
| ミッションの開始・終了 | `mission.advanceMissions` | Cloud Functions（予約実行） |
| blurM の変更 | `mission.applyMissionOutcome` | Cloud Functions |
| 勝敗・ゲーム終了・位置情報の破棄 | `gameState.finish` / `outcome.judgeOutcome` | Cloud Functions |
| 結果データ | `resultSummary.buildResultSummary` | Cloud Functions（公開用と本人用に分けて書き込む） |
| 「誰に何を見せるか」 | `visibility.buildPlayerView` | Cloud Functions（見せてよい部分だけを書き込む） |

## 3. クライアントに残す責務

- 画面表示、地図（Google Maps / 簡易マップ）の描画
- 自分の GPS の取得と送信（間引きあり）
- **要求の送信だけ**: ルーム作成・参加、設定変更（ホスト）、ゲーム開始、確保、ミッション到達の申告、目的地の変更、途中終了、もう一度遊ぶ
- 自分が読んでよいデータの購読と、それを組み立てて画面用のビューにすること
- 残り時間の表示（サーバー時刻との差を補正。**表示だけ**で、判定には使わない）
- 自分のエリア外警告（自分の位置と公開済みのエリアから計算。表示だけ）
- 開発モード（`?dev`）とダミー: 今の**端末内モードのまま残す**（Firebase 版とは切り替え）

## 4. Cloud Functions に移す責務

**呼び出し型（クライアントの要求を受けて検証する）**

| 関数 | 検証すること |
| --- | --- |
| `createRoom` / `joinRoom(code, name)` | ログイン済みか、名前、部屋が満員でないか、ゲーム中でないか |
| `updateSettings` / `setStartPoint` / `setExclusionZones` | ホストか、ロビー中か、`sanitizeSettings` を通す |
| `startGame` | ホストか、人数、開始地点があるか |
| `requestCapture` | 下記のとおり |
| `claimArrival` | 下記のとおり |
| `rerollDestination` | 挑戦中か、1ゲーム1回か、同じ安全ルールを通すか |
| `abortGame` / `prepareRematch` | ホストか、状態が正しいか |

`requestCapture` の流れ（要求するのは「確保ボタンを押した」ことだけ）:

1. サーバー時刻 `now` を取る
2. **まず `advance(state, now)` で遅れている処理を片付ける**（時間切れならここで終了し、確保は拒否される）
3. 要求者が参加中の鬼か、ゲーム中か、クールダウン中でないか
4. 鬼と全逃走者の最新の実位置をサーバー側で読む（**新しさも確認**: 例えば15秒より古い位置は使わない）
5. 確保距離以内で一番近い参加中の逃走者を1人選ぶ（`attemptCapture` をそのまま使う）
6. トランザクションで状態を更新し、公開データ・各自のビューを書き直す
7. 返すのは `{ ok, capturedId }` か `{ ok: false, reason }` だけ（距離・座標は返さない）

> 要求例の「playerA を捕まえた」のように対象を指定する方式は取らない。鬼には逃走者の実位置が見えないので、対象はサーバーが実位置から選ぶ（STEP 2 からのルール）。

`claimArrival` の流れ:

1. 逃走者の端末は、自分の目的地と自分の位置から「20m以内に入った」と判断したら自動で申告する
2. サーバーは `advance` → 挑戦中か → **サーバーに保存されている最新の実位置**と**秘密の目的地**の距離を計算 → 位置の記録時刻がミッション終了時刻より前か → 20m以内なら成功
3. 申告が届かなかった場合に備えて、ミッション終了の処理でも挑戦中の全員を最新の実位置で1回判定する（記録時刻が終了時刻より前の位置だけを使う）

**予約実行型（時刻が来たら動く）**: `advanceGame(roomId, gameId)`

- 可能性エリアの公開、ミッションの開始・終了、時間切れの処理を行う（中身は `advance(state, now)`）

## 5. Firestore / Realtime Database の選択

| 観点 | Realtime Database（RTDB） | Firestore |
| --- | --- | --- |
| 高頻度の GPS 更新 | 小さな書き込みを低い遅延で頻繁に行う用途に向く | 書き込み・読み込みの**件数ごと**に課金。数秒おきの更新を人数分購読すると件数が増えやすい |
| 位置情報のアクセス制御 | パスごとのルール。**上の階層で許可すると下の階層すべてに効く**ので設計に注意が必要 | ドキュメントごとのルール。細かく書きやすい |
| コスト | 主に保存容量と通信量で課金 | 主に操作件数で課金 |
| リアルタイム性 | 非常に良い（小さな差分の配信が速い） | 良い |
| サーバーでの距離判定 | どちらも Cloud Functions で行う（差なし） | 同左 |
| ミッションの予約実行 | どちらも持たない → Cloud Tasks | 同左 |
| ゲーム終了処理 | 複数パスの同時更新・トランザクションあり | トランザクションが強力 |
| 同時アクセス | 1つのノードへのトランザクションで直列化できる | ドキュメント単位のトランザクション |
| 接続状態（在席） | `onDisconnect` が標準である | 標準機能はない |

**提案: RTDB を使い、判定は Cloud Functions（第2世代）、予約実行は Cloud Tasks（タスクキュー関数）で行う。Firestore は使わない。**

理由:

- このゲームの一番多いデータは「数秒おきの位置」。RTDB の課金と遅延の特性がこれに合う
- 部屋の状態はまとまった JSON 1つで表せて、検索（クエリ）が要らない。Firestore の強み（複雑な検索）を使う場面がない
- RTDB と Firestore の両方を使うと、ルールが2種類になり、ミスの余地が増える
- 在席確認（`onDisconnect`）が標準で使える

注意:

- RTDB のルールは「上で許可すると下に全部効く」。`rooms/{roomId}` の階層で `.read` を許可すると、その下の全データが読めてしまう。**部屋の階層では許可せず、子ごとに許可する**。さらに実位置と秘密値は `rooms` の外の別の最上位パスに置き、誤って一緒に許可されないようにする
- Cloud Functions と Cloud Tasks を使うには **Blaze（従量課金）プラン**が必要（クレジットカード登録）。予算アラートの設定を前提にする
- 料金の具体的な金額は、規模を決めてから公式の料金計算で見積もる（ここでは断定しない）

## 6. データ構造（RTDB）

**GPS → サーバー専用の実位置 → Cloud Functions → 公開用の派生データ** の一方向にする（11章の案B）。

- 端末が書けるのは自分の `/locations/{roomId}/{uid}` だけ。クライアントからは誰も読めない
- 鬼・仲間の位置（`channels/hunterPositions`・`channels/runnerPositions`）は、サーバーが実位置から作る派生データ。端末は書けない
- 実位置の書き込みで動く関数（`onLocationWritten`）が、検証（メンバー・ゲーム中・役割・新しさ・不自然な移動）をしてから、見てよい人がいるチャンネルにだけ書く
- 確保・到達・公開・ミッション開始は、サーバーが `/locations` の実位置を読んで判定する

```
/roomCodes/{code}                       → roomId（参加は joinRoom 経由。クライアントは読めない）

/rooms/{roomId}/meta                    { hostUid, code, phase, gameId, createdAt }
/rooms/{roomId}/members/{uid}           { name, joinedAt }
/rooms/{roomId}/presence/{uid}          true（onDisconnect で消える）
/rooms/{roomId}/public                  全員に見せてよいゲーム情報
    settings, area, exclusionZones, startedAt, endsAt, nextRevealAt,
    players/{uid}: { name, isHost, role, originalRole, status, captures },
    mission: { index, total, startedAt, endsAt } | null,
    missionsCompleted, lastMission: { index, success, failure, cancelled },
    runnersRemaining, runnersTotal, log[], result: { winner, reason }
/rooms/{roomId}/channels/hunterPositions/{uid}   { lat, lng }  鬼の位置（サーバーが実位置から作る）
/rooms/{roomId}/channels/runnerPositions/{uid}   { lat, lng }  逃走者の位置（仲間用。サーバーが実位置から作る）
/rooms/{roomId}/channels/possibleAreas/{uid}     { center, radiusM, publishedAt }（サーバーが書く）
/rooms/{roomId}/views/{uid}             本人だけのデータ（サーバーが書く）
    blurM, possibleArea（自分の円）, mission: { index, endsAt, arrivalRadiusM, result, destination, canReroll },
    missionHistory[], captureReadyAt
/rooms/{roomId}/results/public          resultSummary から personal を除いたもの
/rooms/{roomId}/results/personal/{uid}  本人のミッション結果

/locations/{roomId}/{uid}               { lat, lng, acc, t }  全員の実位置（本人が書く・クライアントは誰も読めない）
/private/{roomId}/game                  サーバー専用の状態（クライアントは読み書きとも不可）
    players（blurM・missionHistory など全項目）, missions（schedule・active と目的地・history・rerollsUsed）,
    privacy（secrets・cells・published）, captureAttempts, version
```

補足:

- 端末は役割に関係なく `/locations/{roomId}/{自分}` にだけ書く。どのチャンネルに出すか（出さないか）はサーバーが役割と設定から決める（`buildChannels` と同じ規則）
- 派生データに入れるのは緯度経度だけ（精度・記録時刻は入れない）
- `views/{uid}` は「本人だけのデータ」に限る。頻繁に変わる共有データ（鬼・仲間の位置）は audience（見てよい人の集まり）ごとの `channels` に分ける。人数分の views を毎回書き直すと、書き込みが人数の2乗で増えるため
- クライアントは `public`・読める `channels`・自分の `views` を組み立てて、今の `buildPlayerView()` と**同じ形**のビューを作る（`assembleView()`）。「サーバーがチャンネルに分けたもの（`buildChannels(state)`）を組み立てると、全員について `buildPlayerView(state, uid)` と一致する」ことをテストで保証し、STEP 2〜5 の表示ルールと食い違わないようにする

## 7. Security Rules の方針

- 既定はすべて拒否。`/private` と `/roomCodes` はクライアントから読み書きとも不可（関数は Admin SDK で読み書きする）
- `rooms/{roomId}` の階層では `.read` / `.write` を許可しない（下の全データに効いてしまうため）
- 役割・状態の判定には、サーバーだけが書ける `public/players/{uid}` を使う
- クライアントが書ける GPS 由来のデータは `/locations/{roomId}/{自分}` だけ。ルールで「本人のパス」「ゲーム中」「参加中（脱落していない）」「形式が正しい（lat/lng の範囲など）」「`t` がサーバー時刻」「前回から2秒以上たっている」を確認する
- `channels/*` はすべてサーバーだけが書ける

| データ | 自分 | 他の逃走者 | 鬼 | 脱落者 | サーバー |
| --- | --- | --- | --- | --- | --- |
| 自分の実位置 `/locations/{r}/{自分}` | write のみ（ゲーム中） | × | × | × | read / delete |
| 他人の実位置 `/locations/{r}/{他人}` | × | × | × | × | read / delete |
| 鬼の位置 `channels/hunterPositions` | （書けない） | read（設定 ON のとき） | read | read（設定 ON のとき） | write |
| 逃走者の位置 `channels/runnerPositions` | （書けない。参加中の逃走者なら read） | read（参加中の逃走者のみ） | **×** | **×** | write |
| 可能性エリア `channels/possibleAreas` | × | × | read（参加中の鬼のみ） | × | write |
| `/private/{r}/*` | × | × | × | × | read / write |
| 自分の view `views/{自分}` | read | × | × | × | write |
| 他人の view `views/{他人}` | × | × | × | × | write |
| public 状態 `rooms/{r}/public` | read | read | read | read | write |
| `meta` / `members` | read（members は参加時の自分の名前だけ write 可） | read | read | read | write |
| 公開の結果 `results/public` | read | read | read | read | write |
| 個人の結果 `results/personal/{uid}` | 自分の分だけ read | × | × | × | write |

- 「メンバーであること」は `members/{auth.uid}` の存在で確認する
- 役割が変わる（増え鬼・脱落）と、読める範囲も変わる。RTDB で読み込み中に権限を失った購読がどう打ち切られるか（キャンセル通知の出方）は 7-H のエミュレーターで確認する。**権限を失う前に受け取ったデータは端末に残る**（例: 鬼になった元逃走者が直前に見ていた仲間の位置）。これは防げない前提として扱う

## 8. 時間処理の方針

- **基準はサーバー時刻**。関数内の `Date.now()` と、RTDB のサーバータイムスタンプを使う。クライアントは `.info/serverTimeOffset` で表示だけを補正する
- **毎秒の処理はしない**。1ゲームにつき「次に何かが起きる時刻」だけを Cloud Tasks に1件予約する
  1. 新しい純粋関数 `nextDueAt(state)`: 次の公開・ミッション開始・ミッション終了・ゲーム終了のうち一番早い時刻
  2. 予約された `advanceGame` が動いたら `advance(state, now)` で、期限を過ぎた処理を全部片付ける（公開・ミッション・勝敗）
  3. 次の `nextDueAt` を1件だけ予約する
  - 常に「1ゲームに予約1件」なので、ゲーム数が増えても予約は同時進行中のゲーム数までしか増えない
  - 1ゲームの実行回数はおおよそ「公開回数 + ミッション8回（開始と終了）+ 終了1回」。例えば60分・公開間隔30秒なら約130回
- **予約の実行が遅れても判定は変わらない**
  - どの要求の処理も最初に `advance(state, now)` を行う
  - 時間切れ後の確保は拒否され、終了時刻より後に記録された位置でミッション成功にはならない
  - 予約は「誰も操作しないときに進める」ためのもので、正しさは予約の時間の正確さに依存しない
- **重複・古い予約は無視する**: 予約には `roomId`・`gameId`・予定時刻を入れる。`gameId` が違う（もう一度遊んだ後）なら何もしない。`advance` は同じ時刻で何度呼んでも結果が同じ（冪等）
- **Cloud Scheduler** はゲームの進行には使わない（最小間隔が1分で粗いため）。代わりに数分〜1時間おきの「掃除係」として使う
  - 止まったゲームの再予約
  - 放置された部屋の削除
  - 古い `/locations` の削除（RTDB には自動期限切れの機能がないため）
- ミッションの発生時刻（秘密）は、Cloud Tasks の予約とサーバー専用の状態にしかない。クライアントからは見えない

## 9. gameEngine への切り出し方

`gameState.js` のシングルトン部分を、**「状態 + 操作 → 新しい状態 + 起きたこと」**の純粋関数（`game/gameEngine.js`）に分ける。中で使うルールは今の各ファイルをそのまま呼ぶ。

```js
// ctx = { now, rng }（時刻と乱数は外から渡す）
startGame(state, { initialPositions }, ctx)      → { state, events }
updatePosition(state, { playerId, pos }, ctx)    → { state, events }  // 端末内モード用
requestCapture(state, { hunterId }, ctx)          → { state, result, events }
claimArrival(state, { runnerId }, ctx)            → { state, result, events }
rerollDestination(state, { runnerId }, ctx)       → { state, result }
advance(state, ctx)                               → { state, events }  // 時間切れ・ミッション開始/終了（成功/失敗の確定）・公開
abort(state, ctx)                                 → { state, events }
prepareRematch(state)                             → state
nextDueAt(state)                                  → 時刻 | null
```

- `startMission` / `completeMission` / `failMission` / `finish` は `advance`・`claimArrival`・`requestCapture` の内部で呼ばれる（今の `mission.js` の `advanceMissions` / `checkArrivals` / `closeActive` と `gameState.finish` がそれに当たる）
- `gameState.js` は「ストア + `gameEngine` を呼ぶだけ」の薄い層にする（端末内モード用）。**今の101件のテストは `gameState.js` の関数を使っているので、そのまま回帰テストになる**
- サーバーでは、関数ごとに「部屋の状態を読み込む → `gameEngine` → 書き戻す → 公開用データを書く」を行う
- 新しい純粋関数
  - `game/viewChannels.js`: `buildChannels(state)`（サーバー用）と `assembleView(parts, uid)`（クライアント用）
  - `nextDueAt`
- ファイルの移動: `map/privacyArea.js` → `game/privacyArea.js`（表示ではなくルールで、サーバーでも使うため。`map/` を表示専用にする方針とも合う）

**クライアント側の窓口**: 画面が `gameState.js` の関数を直接呼ぶのをやめ、`services/gameService.js`（インターフェース）経由にする。

- `LocalGameService`: 今の動き（`gameState.js`・ダミー・`?dev`）
- `FirebaseGameService`: `firebase/` 以下を使う

どちらも画面には「`session`（部屋・自分の ID・ロビー情報・ビュー・結果）」という同じ形のデータを渡す。**画面が生の状態を読んでいる箇所（`game.js`・`lobby.js`・`create.js`・`result.js`）は、この session を読むように直す。**

**予定のファイル構成**

```
oni-game/js/
  game/        （純粋関数。クライアントとサーバーで共有）
    gameEngine.js, viewChannels.js, privacyArea.js（map/ から移動）, 既存のルールファイル
    gameState.js（端末内モード用の薄いストア）
  services/
    gameService.js（窓口） localGameService.js  locationService.js
  firebase/
    firebaseConfig.js  auth.js  room.js  realtime.js（購読と assembleView）  locationSync.js  commands.js（呼び出し型関数）
functions/
  index.js  handlers/（rooms, game, capture, missions, advance）  lib/（repo, fanout, scheduler）
  shared/    ← oni-game/js/game と utils/distance・random をデプロイ前にコピー（コードは二重に書かない）
database.rules.json  firebase.json（エミュレーター設定）
tests/rules/  tests/functions/
```

## 10. STEP 7-A〜H の実装順

| 段階 | 内容 | Firebase SDK | 完了の条件 |
| --- | --- | --- | --- |
| **7-A** | この設計レビュー | なし | 承認 |
| **7-A2（追加提案）** | Firebase なしの準備: `gameEngine.js`・`nextDueAt`・`viewChannels.js`（`buildChannels`/`assembleView`）、`privacyArea.js` の移動、`gameService` の窓口と `LocalGameService`、画面が生の状態を読む箇所の修正 | なし | 既存101件＋新しいテスト（組み立てたビューが全員分 `buildPlayerView` と一致など）が通る。`?dev` の動作が STEP 6 と同じ |
| **7-B** | Firebase プロジェクト、エミュレーター設定、匿名認証、`createRoom`/`joinRoom`、members・在席・ロビーの同期 | 追加開始 | エミュレーター上で2つのブラウザが同じ部屋に入れる |
| **7-C** | `startGame`（サーバーで役割・秘密値・スケジュールを作成）、`public`・`views` の書き込みと購読、`assembleView` による表示 | | 各自の画面が端末内モードと同じ表示になる |
| **7-D** | 自分の GPS の送信（`/locations` だけ・間引きあり）、`onLocationWritten`（検証して派生チャンネルへ）、ルール、書き込み回数の実測 | | 鬼のアカウントで `runnerPositions`・`/locations` が読めない |
| **7-E** | `requestCapture`（サーバーの実位置・位置の新しさ・クールダウン・トランザクション） | | 同時に確保した場合も1人だけ・時間切れ後は拒否 |
| **7-F** | `claimArrival`・`rerollDestination`・ミッション終了時の判定、blurM の変更 | | 到達・失敗・無効が端末内モードと一致 |
| **7-G** | `advanceGame` の予約（Cloud Tasks）、公開・ミッション・時間切れ、終了時の破棄、`results/public`・`personal`、掃除係 | | 誰も操作しなくても最後まで進み、終了後に `/locations`・秘密値・`possibleAreas` が消える |
| **7-H** | Security Rules の攻撃テスト（エミュレーター）、App Check の検討 | | 下の攻撃テストがすべて拒否される |

**7-H の攻撃テスト**（エミュレーター上で、悪意のあるクライアントとして実行）:

- 鬼が `/locations/*` を読む → 拒否
- 鬼が `/private/*` を読む → 拒否
- 鬼が `channels/runnerPositions` を読む → 拒否
- 誰かが他人の `views/*` を読む → 拒否
- 逃走者が他人の目的地（他人の `views`）を読む → 拒否
- 脱落者が `runnerPositions` / `possibleAreas` を読む → 拒否
- 他人の `results/personal` を読む → 拒否
- クライアントが `public/players/{uid}/status = 'caught'` を書く → 拒否
- クライアントが `public/result/winner` を書く → 拒否
- クライアントがミッション成功（`views/*/mission/result`）を書く → 拒否
- クライアントが `/private/*` を書く → 拒否
- 他人の `/locations/*` を書く → 拒否
- 自分の分でも `channels/*` を書く → 拒否（派生データはサーバーだけが書く）
- ゲーム外（ロビー・終了後）に位置を書く → 拒否
- 脱落者が `/locations` に書く → 拒否
- 2秒未満の連続書き込み、`t` の偽装 → 拒否
- `rooms/{roomId}` や `/rooms` 全体を読む → 拒否（部屋の一覧が見えない）
- `requestCapture` を鬼以外・クールダウン中・終了後に呼ぶ → 拒否
- `claimArrival` を目的地から遠い位置で呼ぶ → 成功にならない

## 承認をお願いしたいこと

1. **Blaze（従量課金）プランの利用**: Cloud Functions と Cloud Tasks に必須。予算アラートを設定する前提
2. **RTDB を中心にし、Firestore を使わない構成**
3. **7-A2（Firebase なしの準備）を 7-B の前に入れること**
4. **`map/privacyArea.js` を `game/privacyArea.js` へ移動すること**
5. 確保は「対象の指定」ではなく「ボタンを押した」要求にし、サーバーが最も近い逃走者を選ぶ（STEP 2 のルールを維持）
6. 到達は端末が自動で申告し、サーバーが実位置で判定する。加えてミッション終了時にもサーバーが判定する
7. 端末内モード（`?dev`・ダミー）を開発用として残すこと
8. リージョン（例: `asia-northeast1`（東京））

## 防げないこと（前提として共有）

- **GPS の偽装**: 位置は本質的に端末の申告であり、サーバーは本物かどうかを確かめられない。明らかに不自然な移動（例: 秒速12m超）を記録・無視するなどの対策はできるが、完全には防げない
- **受信済みデータ**: 権限を失う前に受け取ったデータは、その端末に残る
- **アルゴリズムの公開**: 可能性エリアのアルゴリズムはクライアントにも配られる（公開されている）。安全性は秘密値がサーバーにしかないことに依存する

---

## 11. 7-A2: GPS データの保存・公開構造の比較と結論

| 観点 | A: 端末が `locations` と `channels` の両方へ書く | **B: 端末は `locations` だけ。公開用はサーバーが作る** | C1: 鬼だけ A、逃走者は B | C2: サーバーが一定間隔でまとめて公開 |
| --- | --- | --- | --- | --- |
| セキュリティ | 端末が「他人に見える位置」を直接書く。サーバーが検証する前に他人へ届く。役割が変わった直後に書けてしまう隙や、止まった端末の古いデータが残る問題をルールだけで防ぐ必要がある | **一方向**。端末が書ける GPS 由来のデータは自分の実位置1か所だけで、誰も読めない。公開前にサーバーが検証でき、役割の変化（脱落・増え鬼）もサーバーが同時に反映できる | 逃走者は B と同じ。鬼の位置だけ端末が直接公開する | B と同じ |
| 書き込み回数（位置の更新1回あたり） | 端末の書き込み1回（複数パス同時更新）。関数の実行なし | 端末1回 + 関数1回 + 派生データの書き込み（見てよい人がいるときだけ）1回 | 鬼は A、逃走者は B | 端末1回。派生データはゲームごと・一定間隔ごと |
| リアルタイム性 | 最も速い | 関数の起動分だけ遅れる（通常は1秒未満〜数秒。コールドスタート時はそれ以上） | 鬼の位置は速い | 間隔分だけ遅れる |
| 実装の複雑さ | ルールが複雑（パスごとの役割判定・レート制限が2か所）。端末が役割に応じて書き先を変える | 関数が1つ増える。端末は役割に関係なく1か所に書くだけ。ルールは単純 | 2方式の混在で複雑 | ゲームごとの定期実行が必要（「毎秒処理しない」方針に反する） |

**結論: B を採用する。**

- 「実位置 → サーバー → 公開用データ」の一方向になり、STEP 3〜5 の「実位置と表示用情報の分離」がデータベースの構造でもそのまま成り立つ
- 派生データの中身は `buildChannels(state)` と同じ規則で作る（7-A2 で実装・テスト済み）ので、表示ルールが1か所に保たれる
- 7-A で書いた「GPS の更新ごとに関数を動かさない」は取り下げる。関数の実行回数は GPS の頻度に比例する
  - 例: 10人・5秒おき・30分のゲームで約3,600回
  - 抑える工夫:
    - 端末側で間引く（例: 5秒おき、または10m以上動いたとき）
    - 見てよい人がいないチャンネルには書かない（例: 鬼の位置を見せない設定で鬼が1人のとき、参加中の逃走者が1人だけのとき）
    - 脱落者は送信しない（ルールで拒否）
- 7-D で実際の書き込み回数・遅延を測り、コストが問題になった場合の代替として C1（鬼の位置だけ端末が直接公開）を残しておく。鬼の位置は仕様上もともと公開する情報なので、C1 にしても逃走者の実位置の扱いは変わらない
- C2 は採用しない。ゲームごとの定期実行が必要で遅延も増えるため

## 12. 7-A2 で実装したこと（Firebase なし）

| ファイル | 責務 |
| --- | --- |
| `js/game/gameEngine.js`（新規） | 状態遷移のすべて。`state + 操作 + ctx(now, rng) → { state, events, result }`。ブラウザ API・Firebase・モジュール共有状態・`Date.now()` に依存しない |
| `js/game/gameState.js`（書き換え） | 端末内モードのストア。端末時刻と乱数を決めて gameEngine を呼ぶだけ。Firebase を持たない |
| `js/game/viewChannels.js`（新規） | `buildChannels`（サーバー用）/ `readableChannels`（誰が何を読めるか = ルールの仕様）/ `assembleView`（クライアント用） |
| `js/game/privacyArea.js`（`map/` から移動） | 表示ではなくルールなので `game/` へ。サーバーでもそのまま使える |
| `js/game/visibility.js`（補助関数を export） | 基準の実装 `buildPlayerView` はそのまま |
| `js/services/gameService.js`（新規） | 画面の窓口（インターフェースと、今使う実装） |
| `js/services/localGameService.js`（新規） | 端末内モードの実装（gameState + ダミーの部屋） |
| `js/screens/*.js` | `gameStore`・`gameState`・`roomService` を直接使わず、`gameService` だけを使う |

確認したこと（テスト）:

- **gameEngine 自体**：
  - ブラウザ API・Firebase・画面・地図に依存しない（ソースの検査）
  - モジュール直下の変更可能な変数と `Date.now()` を持たない
  - `ctx.now` が無いとエラーになる（時刻は外から注入）
  - 乱数・ゲームIDを外から渡せ、同じ入力なら同じ結果になる
  - 凍結した state を渡しても最後まで動く（入力を書き換えない）
- **gameState.js**：ストア・gameEngine・visibility にしか依存しない
- **resultSummary**：位置情報・秘密値を持たない入力で同じ結果を作れる
- **privacyArea**：Node.js でそのまま動く
- **viewChannels**：
  - 全員について「読めるチャンネルから組み立てたビュー = `buildPlayerView`」が一致する（ロビー・ミッション中・脱落・増え鬼・設定 OFF・終了後）
  - 鬼・脱落者が読めるチャンネルに逃走者の実位置が入っていない
  - 共有チャンネルに秘密値・未来のミッション予定・目的地・位置の精度や時刻が入っていない
- **画面**：`gameState.js`・`gameStore`・`roomService`・Firebase を使っていない

残っている、端末内モード専用の部分: `dev/dummySimulator.js` は開発用のダミーを動かすためにストアを直接読む。Firebase 版には含めない。
