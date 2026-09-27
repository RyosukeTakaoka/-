// 乱数ユーティリティ
// rng は「0以上1未満の数を返す関数」。テストや再現用にシード付き乱数も作れる。

/** シード付き乱数（mulberry32）。同じシードなら同じ乱数列になる */
export function createSeededRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** min 以上 max 以下の整数 */
export function randomInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** min 以上 max 未満の実数 */
export function randomFloat(min, max, rng = Math.random) {
  return rng() * (max - min) + min;
}

export function randomChoice(items, rng = Math.random) {
  return items[Math.floor(rng() * items.length)];
}

/** 元の配列を変更せずにシャッフルした配列を返す（Fisher–Yates） */
export function shuffle(items, rng = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 推測されにくいID（英数字） */
export function randomId(length = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** 4桁の数字の参加コード（表示・入力用。内部の部屋IDとは別） */
export function randomJoinCode(rng = Math.random) {
  return String(Math.floor(rng() * 10_000)).padStart(4, '0');
}

/** ルームコード（紛らわしい文字 0/O/1/I を除いた6文字） */
export function randomRoomCode(rng = Math.random) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(rng() * chars.length)];
  return code;
}

/** 暗号学的に安全な 32bit 整数（秘密の値の生成用） */
export function secureUint32() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0];
}

/** 暗号学的に安全な 0以上1未満の数（rng と同じ形で使える） */
export function secureRandom() {
  return secureUint32() / 4294967296;
}

/** 複数の値から 32bit のシードを作る（FNV-1a）。同じ入力なら同じ値 */
export function hashToSeed(...parts) {
  let h = 0x811c9dc5;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
