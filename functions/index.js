// Cloud Functions（第2世代）の入口
//
// 呼び出し型（クライアントの要求）: 部屋の作成・参加・退出、設定、開始、確保、到達の申告、目的地の変更、途中終了、もう一度遊ぶ
// DB トリガー: 端末が /locations/{roomId}/{uid} に位置を書いたとき
// タスクキュー（Cloud Tasks）: 次に何かが起きる時刻に advanceGame を1件だけ予約する
// 定期実行（Cloud Scheduler）: 掃除係（止まったゲームの再予約・放置された部屋の削除）
//
// ゲームのルールは functions/shared（oni-game/js/game のコピー。npm run build で作る）を使う。
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { onValueWritten } from 'firebase-functions/v2/database';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFunctions } from 'firebase-admin/functions';
import * as rooms from './src/rooms.js';
import * as game from './src/game.js';

const REGION = 'asia-northeast1'; // 東京（呼び出し型・タスク・定期実行）
// RTDB トリガーは、データベースのインスタンスと同じ場所で動かす必要がある。
// RTDB を作るときに選べる場所は us-central1 / europe-west1 / asia-southeast1 なので、既定はシンガポール
const DATABASE_REGION = defineString('DATABASE_REGION', { default: 'asia-southeast1' });

setGlobalOptions({ region: REGION, maxInstances: 10 });
initializeApp();

/** advanceGame を dueAt に予約する（Cloud Tasks） */
async function schedule({ roomId, gameId, dueAt }) {
  const queue = getFunctions().taskQueue(`locations/${REGION}/functions/advanceGame`);
  await queue.enqueue({ roomId, gameId }, { scheduleTime: new Date(Math.max(dueAt, Date.now())) });
}
const deps = { schedule };

const call = (handler) => onCall(async (request) => handler(getDatabase(), request.auth, request.data, Date.now(), deps));

// ---- 部屋 ----
export const createRoom = call(rooms.createRoom);
export const joinRoom = call(rooms.joinRoom);
export const leaveRoom = call(rooms.leaveRoom);

// ---- ゲーム ----
export const configureGame = call(game.configureGame);
export const startGame = call(game.startGame);
export const requestCapture = call(game.requestCapture);
export const claimArrival = call(game.claimArrival);
export const changeDestination = call(game.changeDestination);
export const abortGame = call(game.abortGame);
export const prepareRematch = call(game.prepareRematch);

// ---- 位置 ----
export const onLocationWritten = onValueWritten(
  { ref: '/locations/{roomId}/{uid}', region: DATABASE_REGION },
  async (event) => {
    const value = event.data.after.val();
    if (value == null) return; // 削除（終了時の片付け）では何もしない
    await game.handleLocationWrite(getDatabase(), event.params, value, Date.now(), deps);
  },
);

// ---- 時間で進む処理 ----
export const advanceGame = onTaskDispatched(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 5 }, rateLimits: { maxConcurrentDispatches: 20 } },
  async (request) => {
    await game.advanceGame(getDatabase(), request.data, Date.now(), deps);
  },
);

export const sweepRooms = onSchedule('every 10 minutes', async () => {
  await game.sweep(getDatabase(), Date.now(), deps);
});
