// ルームの作成・参加・退出
//
// ホストの判定は常に rooms/{roomId}/meta/hostUid === 認証済みの uid（クライアントの申告は使わない）。
// 部屋を作った時点から、ゲームの状態（/private/games/{roomId}）をサーバーが持つ。
// メンバーの出入りはその状態の players にも反映し、公開用データ（public/doc・access）を書き出す。

import { randomInt } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import * as engine from '../shared/game/gameEngine.js';
import { createPlayer } from '../shared/game/player.js';
import { randomId } from '../shared/utils/random.js';
import { consumeRateLimit } from './rateLimit.js';
import { mutateGame, fanout } from './store.js';
import {
  requireUid, requireName, requireRoomId, cleanPoint, cleanZoneCenters, deleteRoomData,
} from './common.js';
import { joinCodePath, metaPath, membersPath, memberPath, presencePath, gameStatePath } from './paths.js';

export const MAX_MEMBERS = 20;
const JOIN_CODE_ATTEMPTS = 30;
const JOIN_CODE_PATTERN = /^\d{4}$/;
/** 参加を受け付けるフェーズ（ゲーム中・終了後は参加できない） */
const JOINABLE_PHASES = new Set([engine.PHASE.LOBBY, engine.PHASE.SETUP]);

/**
 * 4桁の参加コードを確保する。
 * joinCodes/{code} へのトランザクションで「空いていたら自分のものにする」ので、同時に同じコードを作ろうとしても
 * 片方だけが成功し、もう片方は別のコードで再試行する。
 */
export async function allocateJoinCode(db, roomId, now, pick = () => String(randomInt(0, 10_000)).padStart(4, '0')) {
  for (let i = 0; i < JOIN_CODE_ATTEMPTS; i++) {
    const code = pick();
    const result = await db.ref(joinCodePath(code)).transaction((cur) => (cur === null ? { roomId, createdAt: now } : undefined));
    if (result.committed) return code;
  }
  throw new HttpsError('resource-exhausted', '参加コードを作れませんでした。時間をおいて試してください');
}

/**
 * ゲームの設定・開始地点・除外エリアを状態に反映する（作成時・もう一度遊ぶとき共通）。
 * 設定は sanitizeSettings、地点は緯度経度の範囲、除外エリアは件数と半径をサーバー側で決める。
 */
export function applyGameConfig(state, { settings, startPoint, exclusionZones }) {
  let next = engine.updateSettings(state, settings ?? {});
  const point = cleanPoint(startPoint);
  if (point) next = engine.setStartPoint(next, point);
  next = engine.clearExclusionZones(next);
  for (const center of cleanZoneCenters(exclusionZones)) next = engine.addExclusionZone(next, center);
  return next;
}

/** メンバー一覧をゲームの players に反映する（ゲーム中は役割などを保つため変更しない） */
export function syncPlayers(state, members, hostUid) {
  if (!JOINABLE_PHASES.has(state.phase)) return state;
  const list = Object.entries(members ?? {})
    .sort(([, a], [, b]) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
    .map(([id, m]) => {
      const existing = state.players.find((p) => p.id === id);
      return existing ? { ...existing, name: m.name, isHost: id === hostUid } : createPlayer({ id, name: m.name, isHost: id === hostUid });
    });
  const same = JSON.stringify(list) === JSON.stringify(state.players);
  return same ? state : engine.setPlayers(state, list);
}

export async function createRoom(db, auth, data, now) {
  const uid = requireUid(auth);
  const name = requireName(data?.name);
  await consumeRateLimit(db, uid, 'createRoom', now);
  const roomId = randomId(20);
  const joinCode = await allocateJoinCode(db, roomId, now);

  let state = applyGameConfig(engine.initialState(), data ?? {});
  state = engine.enterLobby(state, {
    room: { code: joinCode, hostId: uid },
    selfId: null, // サーバーの状態には「この端末」が無い
    players: [createPlayer({ id: uid, name, isHost: true })],
  });

  await db.ref().update({
    [metaPath(roomId)]: { hostUid: uid, joinCode, phase: state.phase, createdAt: now },
    [membersPath(roomId)]: { [uid]: { name, joinedAt: now } },
    [gameStatePath(roomId)]: JSON.stringify(state),
  });
  await fanout(db, roomId, null, state);
  return { roomId, joinCode, hostUid: uid };
}

export async function joinRoom(db, auth, data, now) {
  const uid = requireUid(auth);
  const name = requireName(data?.name);
  await consumeRateLimit(db, uid, 'joinRoom', now); // 失敗した試行も数える（総当たり対策）
  const code = String(data?.code ?? '').trim();
  if (!JOIN_CODE_PATTERN.test(code)) throw new HttpsError('invalid-argument', '4桁の参加コードを入力してください');

  const entry = (await db.ref(joinCodePath(code)).get()).val();
  if (!entry?.roomId) throw new HttpsError('not-found', '部屋が見つかりません');
  const { roomId } = entry;
  const meta = (await db.ref(metaPath(roomId)).get()).val();
  if (!meta) throw new HttpsError('not-found', '部屋が見つかりません');
  if (!JOINABLE_PHASES.has(meta.phase)) throw new HttpsError('failed-precondition', 'ゲームはすでに始まっています');

  // 人数の上限と、すでに参加済みかどうかを1回のトランザクションで確認する
  const result = await db.ref(membersPath(roomId)).transaction((members) => {
    const current = members ?? {};
    if (current[uid]) return { ...current, [uid]: { ...current[uid], name } };
    if (Object.keys(current).length >= MAX_MEMBERS) return undefined;
    return { ...current, [uid]: { name, joinedAt: now } };
  });
  if (!result.committed) throw new HttpsError('resource-exhausted', '部屋が満員です');

  await mutateGame(db, roomId, now, (state) => {
    if (!JOINABLE_PHASES.has(state.phase)) throw new HttpsError('failed-precondition', 'ゲームはすでに始まっています');
    return { state: syncPlayers(state, result.snapshot.val(), meta.hostUid) };
  }).catch(async (err) => {
    // メンバーに入れた後でゲームが始まっていた場合は、メンバーからも外す
    await db.ref(memberPath(roomId, uid)).remove();
    throw err;
  });
  return { roomId, joinCode: meta.joinCode, hostUid: meta.hostUid };
}

export async function leaveRoom(db, auth, data, now = Date.now()) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const meta = (await db.ref(metaPath(roomId)).get()).val();
  if (!meta) return { ok: true };
  if (meta.hostUid === uid) {
    // ホストが退出したら部屋を解散する（参加コード・ゲームの状態・実位置もすべて消す）
    await deleteRoomData(db, roomId, meta.joinCode);
    return { ok: true, closed: true };
  }
  await db.ref().update({ [memberPath(roomId, uid)]: null, [presencePath(roomId, uid)]: null });
  const members = (await db.ref(membersPath(roomId)).get()).val() ?? {};
  try {
    // ロビー中なら参加者から外す。ゲーム中・終了後は結果のために残す（端末からの位置は届かなくなる）
    await mutateGame(db, roomId, now, (state) => ({ state: syncPlayers(state, members, meta.hostUid) }));
  } catch {
    /* 状態が無い（古い部屋）場合は、メンバーから外すだけでよい */
  }
  return { ok: true, closed: false };
}
