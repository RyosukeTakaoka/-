// 呼び出し型関数に共通の検証と、サーバー側の既定の乱数

import { HttpsError } from 'firebase-functions/v2/https';
import { sanitizeName } from '../shared/game/player.js';
import { isValidLatLng } from '../shared/utils/distance.js';
import { secureRandom, randomId } from '../shared/utils/random.js';
import { roomPath, joinCodePath, gamePath, roomLocationsPath } from './paths.js';

const ROOM_ID_PATTERN = /^[a-z0-9]{20}$/;
export const MAX_EXCLUSION_ZONES = 50;

export function requireUid(auth) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'ログインしてください');
  return auth.uid;
}

export function requireName(input) {
  const name = sanitizeName(input);
  if (!name) throw new HttpsError('invalid-argument', '名前を入力してください');
  return name;
}

export function requireRoomId(input) {
  if (typeof input !== 'string' || !ROOM_ID_PATTERN.test(input)) throw new HttpsError('invalid-argument', '部屋IDが正しくありません');
  return input;
}

/** クライアントから届いた地点 { lat, lng }（不正なら null） */
export function cleanPoint(input) {
  const p = { lat: Number(input?.lat), lng: Number(input?.lng) };
  return isValidLatLng(p) ? p : null;
}

/** 除外エリアの中心の一覧（半径はサーバーの既定値を使うので、クライアントの値は使わない） */
export function cleanZoneCenters(input) {
  if (!Array.isArray(input)) return [];
  return input.map((z) => cleanPoint(z?.center ?? z)).filter(Boolean).slice(0, MAX_EXCLUSION_ZONES);
}

/**
 * gameEngine に渡す ctx。サーバーでは乱数はすべて暗号学的乱数（テストでは deps.rng で固定できる）
 */
export function engineCtx(now, deps = {}) {
  return {
    now,
    rng: {
      roles: secureRandom,
      privacy: secureRandom,
      schedule: secureRandom,
      destinations: secureRandom,
      ...(deps.rng ?? {}),
    },
    newId: deps.newId ?? (() => randomId(16)),
  };
}

/** 部屋に関するデータをすべて消す（ホストの退出・放置された部屋の掃除） */
export async function deleteRoomData(db, roomId, joinCode) {
  const updates = {
    [roomPath(roomId)]: null,
    [gamePath(roomId)]: null,
    [roomLocationsPath(roomId)]: null,
  };
  if (joinCode) {
    // 参加コードは、その部屋のものであるときだけ解放する（別の部屋が再利用していたら消さない）
    const entry = (await db.ref(joinCodePath(joinCode)).get()).val();
    if (entry?.roomId === roomId) updates[joinCodePath(joinCode)] = null;
  }
  await db.ref().update(updates);
}
