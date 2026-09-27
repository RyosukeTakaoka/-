// 1ユーザーあたりの呼び出し回数の制限（4桁コードの総当たり・部屋の乱造を防ぐ）
import { HttpsError } from 'firebase-functions/v2/https';
import { rateLimitPath } from './paths.js';

export const LIMITS = Object.freeze({
  createRoom: { max: 10, windowMs: 10 * 60_000 },
  joinRoom: { max: 20, windowMs: 10 * 60_000 },
});

/** 制限内なら回数を1増やす。超えていたら HttpsError */
export async function consumeRateLimit(db, uid, action, now) {
  const { max, windowMs } = LIMITS[action];
  const result = await db.ref(rateLimitPath(uid, action)).transaction((cur) => {
    if (!cur || now - cur.windowStart >= windowMs) return { windowStart: now, count: 1 };
    if (cur.count >= max) return undefined; // 中止 = 制限超過
    return { windowStart: cur.windowStart, count: cur.count + 1 };
  });
  if (!result.committed) {
    throw new HttpsError('resource-exhausted', '操作が多すぎます。しばらく待ってからもう一度試してください');
  }
}
