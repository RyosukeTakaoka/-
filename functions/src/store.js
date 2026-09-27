// サーバー専用のゲーム状態の読み書きと、公開用データ（チャンネル）への書き出し
//
// ゲームの状態は /private/games/{roomId}/state に JSON 文字列で1つにまとめて持つ。
// 状態を変える処理はすべて mutateGame() を通す:
//   1. トランザクションで「状態を読む → gameEngine の純粋関数で新しい状態を作る → 書き戻す」
//      （同時に2人が確保しても、状態は1つずつ順番に更新される）
//   2. 変わった部分だけを、読める人ごとの場所（public/doc・channels・views・access・results）へ書き出す（fanout）
//   3. 次に何かが起きる時刻（nextDueAt）に advanceGame を予約する
// 実位置・秘密値・ミッションの予定と目的地は 1 の状態にだけあり、2 で書き出すデータには入らない（buildChannels の規則）。

import { HttpsError } from 'firebase-functions/v2/https';
import * as engine from '../shared/game/gameEngine.js';
import { buildChannels } from '../shared/game/viewChannels.js';
import { resultViewFor } from '../shared/game/resultSummary.js';
import {
  gameStatePath, scheduledAtPath, metaPath, accessPath, publicDocPath, channelPath, viewPath,
  publicResultPath, personalResultPath, resultsPath, roomLocationsPath, CHANNEL_NAMES,
} from './paths.js';

const parse = (json) => (typeof json === 'string' ? JSON.parse(json) : null);

export async function loadGame(db, roomId) {
  return parse((await db.ref(gameStatePath(roomId)).get()).val());
}

/**
 * ゲームの状態をトランザクションで更新する。
 * @param {(state: object) => { state: object, result?: any }} fn 純粋関数（何度呼ばれても同じ結果になること）。
 *   HttpsError を投げると、状態は変えずにそのエラーを呼び出し元へ返す
 * @param {number} now サーバー時刻（予約の判定に使う）
 * @returns {Promise<{ before, after, result }>}
 */
export async function mutateGame(db, roomId, now, fn, deps = {}) {
  let outcome = null;
  const tx = await db.ref(gameStatePath(roomId)).transaction((current) => {
    // 最初はローカルの推測値（null のことが多い）で呼ばれる。null のときは何も変えずに返し、
    // サーバーの値と違えば SDK がサーバーの値でもう一度呼ぶ
    if (current == null) {
      outcome = null;
      return current;
    }
    const before = parse(current);
    try {
      const { state, result } = fn(before);
      outcome = { before, after: state, result, error: null };
      return state === before ? current : JSON.stringify(state);
    } catch (err) {
      // 検証エラーでも「変えない」で確定させる（古い推測値での判定のまま中止しないため）
      outcome = { before, after: before, result: undefined, error: err };
      return current;
    }
  });
  if (!tx.committed || tx.snapshot.val() == null || !outcome) throw new HttpsError('not-found', '部屋が見つかりません');
  if (outcome.error) throw toHttpsError(outcome.error);
  if (outcome.after !== outcome.before) {
    await fanout(db, roomId, outcome.before, outcome.after);
    await scheduleNext(db, roomId, outcome.after, deps, now);
  }
  return outcome;
}

/** gameEngine が投げる Error（「ロビーからのみ開始できます」など）を、クライアントへ返せるエラーにする */
export function toHttpsError(err) {
  if (err instanceof HttpsError) return err;
  return new HttpsError('failed-precondition', err?.message ?? 'この操作はできません');
}

/** Security Rules が参照する「誰がどの役割か」（ロール未定は 'none'。RTDB は null を保存できないため） */
export function accessFor(state) {
  const players = {};
  for (const p of state.players) players[p.id] = { role: p.role ?? 'none', status: p.status ?? 'active' };
  return {
    phase: state.phase,
    showHunters: Boolean(state.settings?.showHuntersToRunners),
    players,
  };
}

/** 状態の変化を、読める人ごとの場所へ書き出す（変わった部分だけ） */
export async function fanout(db, roomId, before, after) {
  const prev = before ? buildChannels(before) : null;
  const next = buildChannels(after);
  const updates = {};
  const put = (path, oldValue, newValue) => {
    const a = oldValue === undefined ? undefined : JSON.stringify(oldValue);
    const b = newValue === undefined ? undefined : JSON.stringify(newValue);
    if (a !== b) updates[path] = b ?? null;
  };

  put(publicDocPath(roomId), prev?.public, next.public);
  for (const name of CHANNEL_NAMES) put(channelPath(roomId, name), prev?.[name], next[name]);
  const uids = new Set([...Object.keys(prev?.views ?? {}), ...Object.keys(next.views)]);
  for (const uid of uids) put(viewPath(roomId, uid), prev?.views[uid], next.views[uid]);

  const accessBefore = before ? JSON.stringify(accessFor(before)) : null;
  const access = accessFor(after);
  if (JSON.stringify(access) !== accessBefore) updates[accessPath(roomId)] = access;
  if (before?.phase !== after.phase) updates[`${metaPath(roomId)}/phase`] = after.phase;

  // 結果（終了時に作られる）: 公開用と本人用に分ける
  const summaryBefore = JSON.stringify(before?.resultSummary ?? null);
  const summaryAfter = JSON.stringify(after.resultSummary ?? null);
  if (summaryBefore !== summaryAfter) {
    if (after.resultSummary) {
      const { personal, ...shared } = after.resultSummary;
      updates[publicResultPath(roomId)] = JSON.stringify(shared);
      for (const p of after.players) {
        updates[personalResultPath(roomId, p.id)] = JSON.stringify(resultViewFor(after.resultSummary, p.id).self);
      }
    } else {
      updates[resultsPath(roomId)] = null; // もう一度遊ぶ: 前の結果を消す
    }
  }

  // ゲームが終わったら、端末から届いた実位置も消す（状態の中の実位置は gameEngine の finish で消えている）
  if (before?.phase === engine.PHASE.PLAYING && after.phase !== engine.PHASE.PLAYING) {
    updates[roomLocationsPath(roomId)] = null;
  }

  if (Object.keys(updates).length > 0) await db.ref().update(updates);
  return updates;
}

/**
 * 次に何かが起きる時刻に advanceGame を1件予約する。
 * すでにそれより早い（または同じ）予約があれば何もしない。予約が遅れても判定は変わらない
 * （どの要求の処理も最初に advance で遅れを片付ける）。
 */
export async function scheduleNext(db, roomId, state, { schedule } = {}, now = Date.now()) {
  const dueAt = engine.nextDueAt(state);
  if (dueAt == null || !schedule) return null;
  const ref = db.ref(scheduledAtPath(roomId));
  const tx = await ref.transaction((scheduledAt) => {
    if (scheduledAt != null && scheduledAt <= dueAt && scheduledAt > now) return undefined;
    return dueAt;
  });
  if (!tx.committed) return null;
  await schedule({ roomId, gameId: state.gameId, dueAt });
  return dueAt;
}
