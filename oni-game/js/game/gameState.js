// 端末内モードのゲーム状態（ストア）
//
// 状態遷移のルールはすべて game/gameEngine.js にあり、ここは
// 「ストアに入っている状態を gameEngine に渡し、返ってきた状態を保存する」だけの薄い層。
// 端末の時刻（Date.now()）と乱数はここで決めて gameEngine に渡す。
// Firebase 版ではこのファイルは使わず、サーバー（Cloud Functions）が同じ gameEngine を呼ぶ。
//
// 状態の中の「実位置」は positions にだけ持つ（Player には持たせない）。
// 画面は positions を直接読まず、ビュー（getPlayerView）と services/gameService.js の session だけを使う。

import { createStore } from '../core/store.js';
import * as engine from './gameEngine.js';
import { buildPlayerView } from './visibility.js';

export { PHASE, EXCLUSION_RADIUS_M, initialState } from './gameEngine.js';

export const gameStore = createStore(engine.initialState());

const current = () => gameStore.getState();
const save = (state) => gameStore.setState(state);
/** ゲーム進行の結果 { state, result } を保存して result を返す */
const commit = ({ state, result }) => {
  if (state !== current()) save(state);
  return result;
};

// ---- 作成・ロビー ----

export const resetGame = () => save(engine.initialState());
export const updateSettings = (input) => save(engine.updateSettings(current(), input));
export const setStartPoint = (point) => save(engine.setStartPoint(current(), point));
export const addExclusionZone = (point, radiusM) => save(engine.addExclusionZone(current(), point, radiusM));
export const clearExclusionZones = () => save(engine.clearExclusionZones(current()));
export const enterLobby = (lobby) => save(engine.enterLobby(current(), lobby));
export const setPlayers = (players) => save(engine.setPlayers(current(), players));
export const prepareRematch = () => save(engine.prepareRematch(current()));
export const returnToLobby = () => save(engine.returnToLobby(current()));

// ---- ゲーム進行 ----

/**
 * ゲーム開始。
 * rng: 役割の決定 / privacyRng: 秘密値 / missionRng: ミッションのスケジュール（テストで固定するため）
 */
export function startGame({ now = Date.now(), rng, privacyRng, missionRng, initialPositions = {} } = {}) {
  commit(engine.startGame(current(), { initialPositions }, {
    now,
    rng: { roles: rng, privacy: privacyRng, schedule: missionRng },
  }));
}

export const updatePosition = (playerId, pos, now = Date.now()) =>
  commit(engine.updatePosition(current(), { playerId, pos }, { now }));

/** @returns {{ ok: boolean, reason?: string, capturedId?: string }} 座標や距離は返さない */
export const requestCapture = (hunterId, now = Date.now()) =>
  commit(engine.requestCapture(current(), { hunterId }, { now }));

let missionRandom = Math.random;
/** テスト用: 目的地生成に使う乱数を差し替える（端末内モードの設定。gameEngine は共有状態を持たない） */
export function setMissionRandom(rng) {
  missionRandom = rng;
}

/** 定期的に呼ぶ（時間切れの判定・ミッション・可能性エリアの公開） */
export const tickGame = (now = Date.now()) =>
  commit(engine.advance(current(), { now, rng: { destinations: missionRandom } }));

/** 目的地が行けない場所だったとき、1ゲームに1回だけ変更する */
export const requestNewDestination = (runnerId, now = Date.now()) =>
  commit(engine.changeDestination(current(), { runnerId }, { now, rng: { destinations: missionRandom } }));

/** ホストによる途中終了 */
export const abortGame = (now = Date.now()) => commit(engine.abort(current(), { now }));

// ---- 読み取り ----

/** 画面用: viewerId の人に見せてよい情報だけ */
export function getPlayerView(viewerId, now = Date.now()) {
  return buildPlayerView(current(), viewerId, now);
}
