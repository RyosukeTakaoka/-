// 呼び出し型関数に共通の検証（functions/src/common.js の Postgres 版）

import { HttpError, sql } from './db.ts';
import { sanitizeName } from './game/player.js';
import { isValidLatLng } from './utils/distance.js';
import { secureRandom, randomId } from './utils/random.js';

export const MAX_EXCLUSION_ZONES = 50;

export const RATE_LIMITS = {
  createRoom: { max: 10, windowMs: 10 * 60_000 },
  joinRoom: { max: 20, windowMs: 10 * 60_000 },
} as const;

export function requireName(input: unknown): string {
  const name = sanitizeName(input);
  if (!name) throw new HttpError(400, 'invalid-argument', '名前を入力してください');
  return name;
}

const ROOM_ID_PATTERN = /^[0-9a-f-]{36}$/;
export function requireRoomId(input: unknown): string {
  if (typeof input !== 'string' || !ROOM_ID_PATTERN.test(input)) {
    throw new HttpError(400, 'invalid-argument', '部屋IDが正しくありません');
  }
  return input;
}

export function cleanPoint(input: any): { lat: number; lng: number } | null {
  const p = { lat: Number(input?.lat), lng: Number(input?.lng) };
  return isValidLatLng(p) ? p : null;
}

export function cleanZoneCenters(input: unknown): { lat: number; lng: number }[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((z: any) => cleanPoint(z?.center ?? z))
    .filter((p): p is { lat: number; lng: number } => Boolean(p))
    .slice(0, MAX_EXCLUSION_ZONES);
}

/** gameEngine に渡す ctx。サーバーではすべて暗号学的乱数 */
export function engineCtx(now: number) {
  return {
    now,
    rng: { roles: secureRandom, privacy: secureRandom, schedule: secureRandom, destinations: secureRandom },
    newId: () => randomId(16),
  };
}

export async function consumeRateLimit(uid: string, action: keyof typeof RATE_LIMITS, now: number) {
  const { max, windowMs } = RATE_LIMITS[action];
  const [row] = await sql`select consume_rate_limit(${uid}, ${action}, ${max}, ${windowMs}, ${new Date(now).toISOString()}) as ok`;
  if (!row.ok) throw new HttpError(429, 'resource-exhausted', '操作が多すぎます。しばらく待ってからもう一度試してください');
}
