// プレイヤーのデータと役割
//
// Player には実際の位置を持たせない。実位置は gameState の positions に分けて保持し、
// 画面には game/visibility.js が作る「見せてよい情報」だけを渡す。

import { shuffle } from '../utils/random.js';

export const ROLE = Object.freeze({
  HUNTER: 'hunter', // 鬼
  RUNNER: 'runner', // 逃走者
});

export const ROLE_LABEL = Object.freeze({
  [ROLE.HUNTER]: '鬼',
  [ROLE.RUNNER]: '逃走者',
});

export const STATUS = Object.freeze({
  ACTIVE: 'active', // ゲームに参加中
  CAUGHT: 'caught', // 確保されて脱落（増え鬼OFFのとき）
});

export const MISSION_RESULT = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
});

export const MAX_NAME_LENGTH = 12;

export function sanitizeName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function createPlayer({ id, name, isHost = false, isDummy = false }) {
  const cleanName = sanitizeName(name);
  if (!id) throw new Error('プレイヤーIDがありません');
  if (!cleanName) throw new Error('名前を入力してください');
  return { id, name: cleanName, isHost, isDummy, ...freshGameFields() };
}

/** 1ゲームごとにリセットする項目 */
function freshGameFields() {
  return {
    role: null,
    originalRole: null, // 開始時の役割（増え鬼で鬼になっても残る）
    status: STATUS.ACTIVE,
    caughtAt: null, // 確保された時刻（ms）
    caughtBy: null, // 確保した鬼のID
    captures: 0, // 鬼として確保した人数
    blurM: null, // 逃走者の現在の位置ぼかし精度（STEP 3・5 で使用）
    missionHistory: [], // [{ missionId, result: 'success'|'failure', at }]
  };
}

/** 参加者の中からランダムに鬼を hunterCount 人選ぶ（逃走者は最低1人残す） */
export function assignRoles(players, hunterCount, rng = Math.random) {
  if (players.length < 2) throw new Error('2人以上必要です');
  const count = Math.min(Math.max(1, hunterCount), players.length - 1);
  const hunterIds = new Set(shuffle(players.map((p) => p.id), rng).slice(0, count));
  return players.map((p) => ({ ...p, role: hunterIds.has(p.id) ? ROLE.HUNTER : ROLE.RUNNER }));
}

/** ゲーム開始時の準備: 前回の状態を消し、役割と初期ぼかしを設定する */
export function preparePlayersForGame(players, { hunterCount, initialBlurM }, rng = Math.random) {
  const fresh = players.map((p) => ({ ...p, ...freshGameFields() }));
  return assignRoles(fresh, hunterCount, rng).map((p) => ({
    ...p,
    originalRole: p.role,
    blurM: p.role === ROLE.RUNNER ? initialBlurM : null,
  }));
}

/** ミッション結果を履歴に追加した新しいプレイヤーを返す（STEP 5 で使用） */
export function withMissionResult(player, { missionId, result, at }) {
  if (!Object.values(MISSION_RESULT).includes(result)) throw new Error('不正なミッション結果です');
  return { ...player, missionHistory: [...player.missionHistory, { missionId, result, at }] };
}

export const hunters = (players) => players.filter((p) => p.role === ROLE.HUNTER);
export const runners = (players) => players.filter((p) => p.role === ROLE.RUNNER);
export const activeRunners = (players) => runners(players).filter((p) => p.status === STATUS.ACTIVE);
export const activeHunters = (players) => hunters(players).filter((p) => p.status === STATUS.ACTIVE);
/** 開始時に逃走者だった人数（増え鬼で鬼になった人も含む） */
export const originalRunners = (players) => players.filter((p) => p.originalRole === ROLE.RUNNER);
