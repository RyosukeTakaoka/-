// ゲーム進行（STEP 7-C〜7-G）
//
// クライアントは「要求」だけを送り、判定はすべてここ（サーバー時刻・サーバーにある実位置）で行う。
// どの要求も、最初に advance(state, now) で遅れている処理（時間切れ・ミッション・位置の公開）を片付けてから判定する。
// そのため advanceGame の予約が遅れても、時間切れ後の確保や、終了後の到達は成立しない。
//
// 呼び出し型: configureGame / startGame / requestCapture / claimArrival / changeDestination / abortGame / prepareRematch
// 予約実行型: advanceGame（Cloud Tasks）
// DB トリガー: handleLocationWrite（/locations/{roomId}/{uid} に端末が位置を書いたとき）
// 定期実行:   sweep（止まったゲームの再予約・放置された部屋の削除）

import { HttpsError } from 'firebase-functions/v2/https';
import * as engine from '../shared/game/gameEngine.js';
import { STATUS } from '../shared/game/player.js';
import { distanceM } from '../shared/utils/distance.js';
import { mutateGame, scheduleNext, loadGame } from './store.js';
import { applyGameConfig, syncPlayers } from './rooms.js';
import { requireUid, requireRoomId, engineCtx, cleanPoint, deleteRoomData } from './common.js';
import { metaPath, membersPath, scheduledAtPath, gamesPath, roomLocationsPath } from './paths.js';

/** 確保の判定に使える位置の新しさ（これより古い位置は「位置が分からない」扱い） */
export const POSITION_MAX_AGE_MS = 15_000;
/** これより速い移動は GPS の飛び・偽装とみなして無視する（秒速12m ≒ 時速43km） */
export const MAX_SPEED_MPS = 12;
/** 予約が止まったとみなすまでの時間（sweep で再予約する） */
export const STALL_MS = 60_000;
/** 放置された部屋（ゲーム中でない）を消すまでの時間 */
export const ROOM_TTL_MS = 24 * 60 * 60_000;

const requirePlayer = (state, uid) => {
  const p = state.players.find((x) => x.id === uid);
  if (!p) throw new HttpsError('permission-denied', 'この部屋のメンバーではありません');
  return p;
};

const requireHost = (state, uid) => {
  if (state.room?.hostId !== uid) throw new HttpsError('permission-denied', 'ホストだけが操作できます');
};

/** まず時間を進める（どの要求の処理でも最初に行う） */
const advanced = (state, ctx) => engine.advance(state, ctx).state;

// ---- ロビー（ホスト） ----

/**
 * ゲームの設定・開始地点・除外エリアを変えて、ロビーにする（部屋の作成後の変更と「もう一度遊ぶ」で使う）。
 * data: { roomId, settings, startPoint, exclusionZones }
 */
export async function configureGame(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  if (!cleanPoint(data?.startPoint)) throw new HttpsError('invalid-argument', 'ゲーム開始地点を設定してください');
  const members = (await db.ref(membersPath(roomId)).get()).val();
  const { after } = await mutateGame(db, roomId, now, (state) => {
    requireHost(state, uid);
    if (state.phase !== engine.PHASE.LOBBY && state.phase !== engine.PHASE.SETUP) {
      throw new HttpsError('failed-precondition', 'ゲーム中は設定を変更できません');
    }
    const configured = applyGameConfig(syncPlayers(state, members, uid), data);
    return { state: engine.returnToLobby(configured) };
  }, deps);
  return { ok: true, phase: after.phase };
}

/** ゲーム開始（役割・秘密値・ミッションの予定はサーバーで作る） */
export async function startGame(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const members = (await db.ref(membersPath(roomId)).get()).val();
  const { after } = await mutateGame(db, roomId, now, (state) => {
    requireHost(state, uid);
    const synced = syncPlayers(state, members, uid);
    const needed = synced.settings.hunterCount + 1;
    if (synced.players.length < needed) {
      throw new HttpsError('failed-precondition', `鬼${synced.settings.hunterCount}人＋逃走者1人以上、あと${needed - synced.players.length}人必要です`);
    }
    // 開始時点の実位置はまだ無い（各端末の最初の位置が届いたときに、その人の可能性エリアを公開する）
    return engine.startGame(synced, { initialPositions: {} }, engineCtx(now, deps));
  }, deps);
  return { ok: true, gameId: after.gameId };
}

// ---- ゲーム中 ----

/** 古い位置を除いた実位置（確保の判定用） */
export function freshPositions(positions, now, maxAgeMs = POSITION_MAX_AGE_MS) {
  return Object.fromEntries(Object.entries(positions).filter(([, p]) => now - p.updatedAt <= maxAgeMs));
}

/** 鬼の「確保！」。対象はサーバーが実位置から選ぶ。返すのは { ok, capturedId } / { ok: false, reason } だけ */
export async function requestCapture(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now, deps);
  const { result } = await mutateGame(db, roomId, now, (state) => {
    requirePlayer(state, uid);
    const base = advanced(state, ctx);
    const fresh = { ...base, positions: freshPositions(base.positions, now) };
    const r = engine.requestCapture(fresh, { hunterId: uid }, ctx);
    if (r.state === fresh) return { state: base, result: r.result };
    // 判定には新しい位置だけを使ったが、状態には全員の位置を残す（終了した場合は finish が消している）
    const positions = r.state.phase === engine.PHASE.PLAYING ? base.positions : r.state.positions;
    return { state: { ...r.state, positions }, result: r.result };
  }, deps);
  return result;
}

/** 逃走者の「目的地に着いた」申告。サーバーにある実位置と秘密の目的地で判定する */
export async function claimArrival(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now, deps);
  const { result } = await mutateGame(db, roomId, now, (state) => {
    requirePlayer(state, uid);
    return engine.claimArrival(advanced(state, ctx), { runnerId: uid }, ctx);
  }, deps);
  return result;
}

/** 目的地の変更（1ゲーム1回。変更したことは誰にも知らせない） */
export async function changeDestination(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now, deps);
  const { result } = await mutateGame(db, roomId, now, (state) => {
    requirePlayer(state, uid);
    return engine.changeDestination(advanced(state, ctx), { runnerId: uid }, ctx);
  }, deps);
  return result;
}

/** ホストによる途中終了 */
export async function abortGame(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now, deps);
  await mutateGame(db, roomId, now, (state) => {
    requireHost(state, uid);
    return engine.abort(advanced(state, ctx), ctx);
  }, deps);
  return { ok: true };
}

/** 結果画面から「もう一度遊ぶ」（ホスト）。開始地点・除外エリアは configureGame で設定し直す */
export async function prepareRematch(db, auth, data, now, deps) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const members = (await db.ref(membersPath(roomId)).get()).val();
  await mutateGame(db, roomId, now, (state) => {
    requireHost(state, uid);
    const next = engine.prepareRematch(state); // 終了後だけ（それ以外はエラー）
    return { state: syncPlayers(next, members, uid) };
  }, deps);
  return { ok: true };
}

// ---- 位置 ----

/** 端末から届いた位置の形式チェック（ルールでも確認しているが、サーバーでも確認する） */
export function cleanLocation(value) {
  const p = cleanPoint(value);
  if (!p) return null;
  const acc = Number(value?.acc);
  return { ...p, accuracyM: Number.isFinite(acc) && acc >= 0 ? acc : null };
}

/**
 * /locations/{roomId}/{uid} に位置が書かれたとき。
 * 検証（ゲーム中・参加中・不自然な移動でない）してから状態の実位置を更新し、到達判定と未公開の人の公開を行う。
 * 鬼・仲間の位置のチャンネルは fanout が buildChannels の規則で作る（見てよい人がいる場所にだけ入る）。
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function handleLocationWrite(db, { roomId, uid }, value, now, deps) {
  const pos = cleanLocation(value);
  if (!pos) return { ok: false, reason: 'invalid' };
  const ctx = engineCtx(now, deps);
  const { result } = await mutateGame(db, roomId, now, (state) => {
    if (state.phase !== engine.PHASE.PLAYING) return { state, result: { ok: false, reason: 'not_playing' } };
    const player = state.players.find((p) => p.id === uid);
    if (!player || player.status !== STATUS.ACTIVE) return { state, result: { ok: false, reason: 'not_active' } };
    const prev = state.positions[uid];
    if (prev) {
      const seconds = Math.max(0.001, (now - prev.updatedAt) / 1000);
      if (distanceM(prev, pos) / seconds > MAX_SPEED_MPS) return { state, result: { ok: false, reason: 'too_fast' } };
    }
    const base = advanced(state, ctx);
    const next = engine.updatePosition(base, { playerId: uid, pos }, ctx).state;
    return { state: next, result: { ok: true } };
  }, deps);
  return result;
}

// ---- 時間で進む処理 ----

/** 予約された時刻に動く（Cloud Tasks）。古いゲームの予約なら何もしない */
export async function advanceGame(db, { roomId, gameId }, now, deps) {
  let outcome;
  try {
    outcome = await mutateGame(db, roomId, now, (state) => {
      if (state.gameId !== gameId || state.phase !== engine.PHASE.PLAYING) return { state };
      return engine.advance(state, engineCtx(now, deps));
    }, deps);
  } catch (err) {
    if (err instanceof HttpsError && err.code === 'not-found') return { ok: false, reason: 'no_room' };
    throw err;
  }
  // この予約は使い終わったので、次の予約を必ず入れる（状態が変わらなかった場合も）
  await db.ref(scheduledAtPath(roomId)).remove();
  await scheduleNext(db, roomId, outcome.after, deps, now);
  return { ok: true, phase: outcome.after.phase };
}

/**
 * 掃除係（Cloud Scheduler で数分おき）。
 * - 予約が止まっているゲームを進めて再予約する
 * - ゲーム中でない部屋の実位置を消す
 * - 放置された部屋（ゲーム中でなく、作成から ROOM_TTL_MS 以上）を消す
 */
export async function sweep(db, now, deps) {
  const games = (await db.ref(gamesPath()).get()).val() ?? {};
  const report = { advanced: [], deleted: [], cleaned: [] };
  for (const [roomId, entry] of Object.entries(games)) {
    const meta = (await db.ref(metaPath(roomId)).get()).val();
    const state = typeof entry?.state === 'string' ? JSON.parse(entry.state) : null;
    if (!meta || !state) {
      await deleteRoomData(db, roomId, meta?.joinCode);
      report.deleted.push(roomId);
      continue;
    }
    if (state.phase === engine.PHASE.PLAYING) {
      if (entry.scheduledAt == null || entry.scheduledAt < now - STALL_MS) {
        await advanceGame(db, { roomId, gameId: state.gameId }, now, deps);
        report.advanced.push(roomId);
      }
      continue;
    }
    if (now - (meta.createdAt ?? 0) > ROOM_TTL_MS) {
      await deleteRoomData(db, roomId, meta.joinCode);
      report.deleted.push(roomId);
    } else if ((await db.ref(roomLocationsPath(roomId)).get()).exists()) {
      await db.ref(roomLocationsPath(roomId)).remove();
      report.cleaned.push(roomId);
    }
  }
  return report;
}

export { loadGame };
