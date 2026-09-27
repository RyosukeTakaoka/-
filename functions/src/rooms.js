// ルームの作成・参加・退出（STEP 7-B）
//
// ホストの判定は常に rooms/{roomId}/meta/hostUid === 認証済みの uid（クライアントの申告は使わない）。
// ゲームの役割（鬼・逃走者）は 7-C 以降。ここでは扱わない。

import { randomInt } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { sanitizeName } from '../shared/game/player.js';
import { sanitizeSettings } from '../shared/game/settings.js';
import { randomId } from '../shared/utils/random.js';
import { consumeRateLimit } from './rateLimit.js';
import { joinCodePath, roomPath, metaPath, membersPath, memberPath, presencePath } from './paths.js';

export const MAX_MEMBERS = 20;
const JOIN_CODE_ATTEMPTS = 30;
const JOIN_CODE_PATTERN = /^\d{4}$/;
const ROOM_ID_PATTERN = /^[a-z0-9]{20}$/;

function requireUid(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'ログインしてください');
  return auth.uid;
}

function requireName(input) {
  const name = sanitizeName(input);
  if (!name) throw new HttpsError('invalid-argument', '名前を入力してください');
  return name;
}

function requireRoomId(input) {
  if (typeof input !== 'string' || !ROOM_ID_PATTERN.test(input)) throw new HttpsError('invalid-argument', '部屋IDが正しくありません');
  return input;
}

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

export async function createRoom(db, auth, data, now) {
  const uid = requireUid(auth);
  const name = requireName(data?.name);
  await consumeRateLimit(db, uid, 'createRoom', now);
  const roomId = randomId(20);
  const joinCode = await allocateJoinCode(db, roomId, now);
  await db.ref(roomPath(roomId)).set({
    meta: { hostUid: uid, joinCode, phase: 'lobby', createdAt: now },
    members: { [uid]: { name, joinedAt: now } },
    public: { settings: sanitizeSettings(data?.settings) },
  });
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
  if (meta.phase !== 'lobby') throw new HttpsError('failed-precondition', 'ゲームはすでに始まっています');

  // 人数の上限と、すでに参加済みかどうかを1回のトランザクションで確認する
  const result = await db.ref(membersPath(roomId)).transaction((members) => {
    const current = members ?? {};
    if (current[uid]) return { ...current, [uid]: { ...current[uid], name } };
    if (Object.keys(current).length >= MAX_MEMBERS) return undefined;
    return { ...current, [uid]: { name, joinedAt: now } };
  });
  if (!result.committed) throw new HttpsError('resource-exhausted', '部屋が満員です');
  return { roomId, joinCode: meta.joinCode, hostUid: meta.hostUid };
}

export async function leaveRoom(db, auth, data) {
  const uid = requireUid(auth);
  const roomId = requireRoomId(data?.roomId);
  const meta = (await db.ref(metaPath(roomId)).get()).val();
  if (!meta) return { ok: true };
  if (meta.hostUid === uid) {
    // ホストが退出したら部屋を解散する（参加コードも解放）
    await db.ref().update({ [roomPath(roomId)]: null, [joinCodePath(meta.joinCode)]: null });
    return { ok: true, closed: true };
  }
  await db.ref().update({ [memberPath(roomId, uid)]: null, [presencePath(roomId, uid)]: null });
  return { ok: true, closed: false };
}
