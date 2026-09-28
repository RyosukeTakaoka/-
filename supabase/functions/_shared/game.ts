// ゲーム進行（functions/src/game.js の Postgres 版）
//
// クライアントは「要求」だけを送り、判定はすべてここ（サーバー時刻・サーバーにある実位置）で行う。
// どの要求も、最初に advance(state, now) で遅れている処理（時間切れ・ミッション・位置の公開）を片付けてから判定する。

import * as engine from './game/gameEngine.js';
import { distanceM } from './utils/distance.js';
import { HttpError, mutateGame, sql, loadGame } from './db.ts';
import { applyGameConfig, syncPlayers } from './rooms.ts';
import { requireRoomId, cleanPoint, engineCtx } from './common.ts';

export const POSITION_MAX_AGE_MS = 15_000; // 確保の判定に使える位置の新しさ
export const MAX_SPEED_MPS = 12; // これより速い移動は無視する（秒速12m ≒ 時速43km）
export const STALL_MS = 60_000; // 予約が止まったとみなすまでの時間
export const ROOM_TTL_MS = 24 * 60 * 60_000; // 放置された部屋を消すまでの時間

const requirePlayer = (state: any, uid: string) => {
  const p = state.players.find((x: any) => x.id === uid);
  if (!p) throw new HttpError(403, 'permission-denied', 'この部屋のメンバーではありません');
  return p;
};
const requireHost = (state: any, uid: string) => {
  if (state.room?.hostId !== uid) throw new HttpError(403, 'permission-denied', 'ホストだけが操作できます');
};
const advanced = (state: any, ctx: any) => engine.advance(state, ctx).state;

async function currentMembers(roomId: string) {
  const rows = await sql`select uid, name from members where room_id = ${roomId} order by joined_at`;
  return rows.map((r: any) => ({ uid: r.uid, name: r.name }));
}

// ---- ロビー（ホスト） ----

export async function configureGame(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  if (!cleanPoint(data?.startPoint)) throw new HttpError(400, 'invalid-argument', 'ゲーム開始地点を設定してください');
  const [room] = await sql`select host_uid from rooms where id = ${roomId}`;
  if (!room) throw new HttpError(404, 'not-found', '部屋が見つかりません');
  const members = await currentMembers(roomId);
  const { after } = await mutateGame(roomId, now, (state) => {
    requireHost(state, uid);
    if (state.phase !== engine.PHASE.LOBBY && state.phase !== engine.PHASE.SETUP) {
      throw new HttpError(409, 'failed-precondition', 'ゲーム中は設定を変更できません');
    }
    const configured = applyGameConfig(syncPlayers(state, members, room.host_uid), data);
    return { state: engine.returnToLobby(configured) };
  });
  return { ok: true, phase: after.phase };
}

export async function startGame(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const [room] = await sql`select host_uid from rooms where id = ${roomId}`;
  if (!room) throw new HttpError(404, 'not-found', '部屋が見つかりません');
  const members = await currentMembers(roomId);
  const { after } = await mutateGame(roomId, now, (state) => {
    requireHost(state, uid);
    const synced = syncPlayers(state, members, room.host_uid);
    const needed = synced.settings.hunterCount + 1;
    if (synced.players.length < needed) {
      throw new HttpError(409, 'failed-precondition', `鬼${synced.settings.hunterCount}人＋逃走者1人以上、あと${needed - synced.players.length}人必要です`);
    }
    return engine.startGame(synced, { initialPositions: {} }, engineCtx(now));
  });
  return { ok: true, gameId: after.gameId };
}

// ---- ゲーム中 ----

export function freshPositions(positions: Record<string, any>, now: number, maxAgeMs = POSITION_MAX_AGE_MS) {
  return Object.fromEntries(Object.entries(positions).filter(([, p]: [string, any]) => now - p.updatedAt <= maxAgeMs));
}

export async function requestCapture(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now);
  const { result } = await mutateGame(roomId, now, (state) => {
    requirePlayer(state, uid);
    const base = advanced(state, ctx);
    const fresh = { ...base, positions: freshPositions(base.positions, now) };
    const r: any = engine.requestCapture(fresh, { hunterId: uid }, ctx);
    if (r.state === fresh) return { state: base, result: r.result };
    const positions = r.state.phase === engine.PHASE.PLAYING ? base.positions : r.state.positions;
    return { state: { ...r.state, positions }, result: r.result };
  });
  return result;
}

export async function claimArrival(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now);
  const { result } = await mutateGame(roomId, now, (state) => {
    requirePlayer(state, uid);
    return engine.claimArrival(advanced(state, ctx), { runnerId: uid }, ctx);
  });
  return result;
}

export async function changeDestination(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now);
  const { result } = await mutateGame(roomId, now, (state) => {
    requirePlayer(state, uid);
    return engine.changeDestination(advanced(state, ctx), { runnerId: uid }, ctx);
  });
  return result;
}

export async function abortGame(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const ctx = engineCtx(now);
  await mutateGame(roomId, now, (state) => {
    requireHost(state, uid);
    return engine.abort(advanced(state, ctx), ctx);
  });
  return { ok: true };
}

export async function prepareRematch(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const [room] = await sql`select host_uid from rooms where id = ${roomId}`;
  if (!room) throw new HttpError(404, 'not-found', '部屋が見つかりません');
  const members = await currentMembers(roomId);
  await mutateGame(roomId, now, (state) => {
    requireHost(state, uid);
    return { state: syncPlayers(engine.prepareRematch(state), members, room.host_uid) };
  });
  return { ok: true };
}

// ---- 位置 ----

export function cleanLocation(value: any) {
  const p = cleanPoint(value);
  if (!p) return null;
  const acc = Number(value?.acc);
  return { ...p, accuracyM: Number.isFinite(acc) && acc >= 0 ? acc : null };
}

/**
 * 自分の位置を送る（Firebase 版の /locations への書き込み＋onLocationWritten トリガーに相当）。
 * Postgres 版では「呼び出し型」にまとめ、検証（ゲーム中・参加中・不自然な移動でない）をここで行う。
 */
export async function reportLocation(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const pos = cleanLocation(data?.position);
  if (!pos) return { ok: false, reason: 'invalid' };
  const ctx = engineCtx(now);
  const { result } = await mutateGame<{ ok: boolean; reason?: string }>(roomId, now, (state) => {
    if (state.phase !== engine.PHASE.PLAYING) return { state, result: { ok: false, reason: 'not_playing' } };
    const player = state.players.find((p: any) => p.id === uid);
    if (!player || player.status !== 'active') return { state, result: { ok: false, reason: 'not_active' } };
    const prev = state.positions[uid];
    if (prev) {
      const seconds = Math.max(0.001, (now - prev.updatedAt) / 1000);
      if (distanceM(prev, pos) / seconds > MAX_SPEED_MPS) return { state, result: { ok: false, reason: 'too_fast' } };
    }
    const base = advanced(state, ctx);
    const next = engine.updatePosition(base, { playerId: uid, pos }, ctx).state;
    return { state: next, result: { ok: true } };
  });
  await sql`insert into locations (room_id, uid, lat, lng, acc, updated_at) values
    (${roomId}, ${uid}, ${pos.lat}, ${pos.lng}, ${pos.accuracyM}, ${new Date(now).toISOString()})
    on conflict (room_id, uid) do update set lat = excluded.lat, lng = excluded.lng, acc = excluded.acc, updated_at = excluded.updated_at`;
  return result;
}

// ---- 時間で進む処理 ----

/** 予約された時刻に動く。古いゲームの予約なら何もしない */
export async function advanceGame(roomId: string, gameId: string, now: number) {
  const { after } = await mutateGame(roomId, now, (state) => {
    if (state.gameId !== gameId || state.phase !== engine.PHASE.PLAYING) return { state };
    return engine.advance(state, engineCtx(now));
  });
  return { ok: true, phase: after.phase };
}

/**
 * 掃除係（pg_cron で1分ごとに呼ぶ）。Cloud Tasks の代わりに game_state.scheduled_at を見て、
 * 期限が来たゲームを進める。ゲーム中でない部屋の実位置の削除・放置された部屋の削除も行う。
 */
export async function sweep(now: number) {
  const due = await sql`select room_id, state ->> 'gameId' as game_id from game_state
    where scheduled_at is not null and scheduled_at <= ${new Date(now).toISOString()}`;
  const advancedRooms: string[] = [];
  for (const row of due) {
    await advanceGame(row.room_id, row.game_id, now);
    advancedRooms.push(row.room_id);
  }

  const staleCutoff = new Date(now - ROOM_TTL_MS).toISOString();
  const deleted = await sql`delete from rooms where phase != 'playing' and created_at < ${staleCutoff} returning id`;

  const cleaned = await sql`delete from locations using rooms
    where locations.room_id = rooms.id and rooms.phase != 'playing' returning locations.room_id`;

  return {
    advanced: advancedRooms,
    deleted: deleted.map((r: any) => r.id),
    cleaned: [...new Set(cleaned.map((r: any) => r.room_id))],
  };
}

export { loadGame };
