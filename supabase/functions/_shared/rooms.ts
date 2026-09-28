// ルームの作成・参加・退出（functions/src/rooms.js の Postgres 版）
//
// ホストの判定は常に rooms.host_uid === 認証済みの uid（クライアントの申告は使わない）。
// 部屋を作った時点から、ゲームの状態（game_state）をサーバーが持つ。

import * as engine from './game/gameEngine.js';
import { createPlayer } from './game/player.js';
import { randomInt } from './utils/random.js';
import { HttpError, mutateGame, fanout, sql } from './db.ts';
import { requireName, requireRoomId, cleanPoint, cleanZoneCenters, consumeRateLimit } from './common.ts';

export const MAX_MEMBERS = 20;
const JOIN_CODE_ATTEMPTS = 30;
const JOIN_CODE_PATTERN = /^\d{4}$/;
const JOINABLE_PHASES = new Set([engine.PHASE.LOBBY, engine.PHASE.SETUP]);

/** 4桁の参加コードを確保する。unique 制約に任せ、衝突したら別の番号で再試行する */
async function allocateJoinCode(roomId: string): Promise<string> {
  for (let i = 0; i < JOIN_CODE_ATTEMPTS; i++) {
    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    try {
      await sql`update rooms set join_code = ${code} where id = ${roomId}`;
      return code;
    } catch (err: any) {
      if (err?.code !== '23505') throw err; // unique_violation 以外は投げ直す
    }
  }
  throw new HttpError(429, 'resource-exhausted', '参加コードを作れませんでした。時間をおいて試してください');
}

/** 設定・開始地点・除外エリアを状態に反映する（作成時・もう一度遊ぶとき共通） */
export function applyGameConfig(state: any, data: any) {
  let next = engine.updateSettings(state, data?.settings ?? {});
  const point = cleanPoint(data?.startPoint);
  if (point) next = engine.setStartPoint(next, point);
  next = engine.clearExclusionZones(next);
  for (const center of cleanZoneCenters(data?.exclusionZones)) next = engine.addExclusionZone(next, center);
  return next;
}

/** メンバー一覧をゲームの players に反映する（ゲーム中は変更しない） */
export function syncPlayers(state: any, members: { uid: string; name: string }[], hostUid: string) {
  if (!JOINABLE_PHASES.has(state.phase)) return state;
  const list = members.map((m) => {
    const existing = state.players.find((p: any) => p.id === m.uid);
    return existing
      ? { ...existing, name: m.name, isHost: m.uid === hostUid }
      : createPlayer({ id: m.uid, name: m.name, isHost: m.uid === hostUid });
  });
  return JSON.stringify(list) === JSON.stringify(state.players) ? state : engine.setPlayers(state, list);
}

async function currentMembers(roomId: string) {
  const rows = await sql`select uid, name from members where room_id = ${roomId} order by joined_at`;
  return rows.map((r: any) => ({ uid: r.uid, name: r.name }));
}

export async function createRoom(now: number, uid: string, data: any) {
  const name = requireName(data?.name);
  await consumeRateLimit(uid, 'createRoom', now);

  let state = applyGameConfig(engine.initialState(), data ?? {});
  state = engine.enterLobby(state, { room: { code: '', hostId: uid }, selfId: null, players: [createPlayer({ id: uid, name, isHost: true })] });

  const [room] = await sql`insert into rooms (host_uid, join_code, phase) values (${uid}, '0000', ${state.phase}) returning id`;
  const roomId = room.id;
  const joinCode = await allocateJoinCode(roomId);
  state.room.code = joinCode;

  await sql.begin(async (tx) => {
    await tx`insert into members (room_id, uid, name) values (${roomId}, ${uid}, ${name})`;
    await tx`insert into game_state (room_id, state) values (${roomId}, ${sql.json(state)})`;
    // before=null で呼ぶと、buildChannels の全項目（public_doc・access・views など）が
    // 「前と比べるまでもなく全部書く」扱いになる（db.ts の fanout の changed() 判定を参照）
    await fanout(tx, roomId, null, state);
  });
  return { roomId, joinCode, hostUid: uid };
}

export async function joinRoom(now: number, uid: string, data: any) {
  const name = requireName(data?.name);
  await consumeRateLimit(uid, 'joinRoom', now); // 失敗した試行も数える（総当たり対策）
  const code = String(data?.code ?? '').trim();
  if (!JOIN_CODE_PATTERN.test(code)) throw new HttpError(400, 'invalid-argument', '4桁の参加コードを入力してください');

  const [room] = await sql`select id, host_uid, join_code, phase from rooms where join_code = ${code}`;
  if (!room) throw new HttpError(404, 'not-found', '部屋が見つかりません');
  if (!JOINABLE_PHASES.has(room.phase)) throw new HttpError(409, 'failed-precondition', 'ゲームはすでに始まっています');

  await sql.begin(async (tx) => {
    // rooms 行をロックしてから数える（count(*) には FOR UPDATE を直接付けられないため）。
    // 同じ部屋への同時参加はこのロックで順番に処理され、満員チェックがすり抜けない
    await tx`select 1 from rooms where id = ${room.id} for update`;
    const [{ count }] = await tx`select count(*)::int as count from members where room_id = ${room.id}`;
    const [existing] = await tx`select 1 from members where room_id = ${room.id} and uid = ${uid}`;
    if (!existing && count >= MAX_MEMBERS) throw new HttpError(409, 'resource-exhausted', '部屋が満員です');
    await tx`insert into members (room_id, uid, name) values (${room.id}, ${uid}, ${name})
      on conflict (room_id, uid) do update set name = excluded.name`;
  });

  const members = await currentMembers(room.id);
  await mutateGame(room.id, now, (state) => {
    if (!JOINABLE_PHASES.has(state.phase)) throw new HttpError(409, 'failed-precondition', 'ゲームはすでに始まっています');
    return { state: syncPlayers(state, members, room.host_uid) };
  }).catch(async (err) => {
    await sql`delete from members where room_id = ${room.id} and uid = ${uid}`;
    throw err;
  });
  return { roomId: room.id, joinCode: room.join_code, hostUid: room.host_uid };
}

export async function leaveRoom(now: number, uid: string, data: any) {
  const roomId = requireRoomId(data?.roomId);
  const [room] = await sql`select host_uid, join_code from rooms where id = ${roomId}`;
  if (!room) return { ok: true };

  if (room.host_uid === uid) {
    await sql`delete from rooms where id = ${roomId}`; // ON DELETE CASCADE で全部消える
    return { ok: true, closed: true };
  }
  await sql`delete from members where room_id = ${roomId} and uid = ${uid}`;
  await sql`delete from presence where room_id = ${roomId} and uid = ${uid}`;
  const members = await currentMembers(roomId);
  try {
    await mutateGame(roomId, now, (state) => ({ state: syncPlayers(state, members, room.host_uid) }));
  } catch {
    /* 状態が無い場合は、メンバーから外すだけでよい */
  }
  return { ok: true, closed: false };
}
