// プレイヤーのデータと役割

import { shuffle } from '../utils/random.js';

export const ROLE = Object.freeze({
  HUNTER: 'hunter', // 鬼
  RUNNER: 'runner', // 逃走者
});

export const ROLE_LABEL = Object.freeze({
  [ROLE.HUNTER]: '鬼',
  [ROLE.RUNNER]: '逃走者',
});

export const MAX_NAME_LENGTH = 12;

export function sanitizeName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * プレイヤーを作る。
 * position は端末の実際の位置。鬼側に渡すときは必ずプライバシー処理（STEP 3）を通すこと。
 */
export function createPlayer({ id, name, isHost = false, isDummy = false, position = null }) {
  const cleanName = sanitizeName(name);
  if (!id) throw new Error('プレイヤーIDがありません');
  if (!cleanName) throw new Error('名前を入力してください');
  return { id, name: cleanName, isHost, isDummy, role: null, position };
}

/** 参加者の中からランダムに鬼を hunterCount 人選ぶ（逃走者は最低1人残す） */
export function assignRoles(players, hunterCount, rng = Math.random) {
  if (players.length < 2) throw new Error('2人以上必要です');
  const count = Math.min(Math.max(1, hunterCount), players.length - 1);
  const hunterIds = new Set(shuffle(players.map((p) => p.id), rng).slice(0, count));
  return players.map((p) => ({ ...p, role: hunterIds.has(p.id) ? ROLE.HUNTER : ROLE.RUNNER }));
}

export const hunters = (players) => players.filter((p) => p.role === ROLE.HUNTER);
export const runners = (players) => players.filter((p) => p.role === ROLE.RUNNER);
