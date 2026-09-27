// ゲーム全体の状態と、状態を変える操作（アクション）
// 画面(screens)はここの関数を呼ぶだけにして、ルールは game/ にまとめる。

import { createStore } from '../core/store.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings.js';
import { createGameArea } from './gameArea.js';
import { assignRoles } from './player.js';

export const PHASE = Object.freeze({
  SETUP: 'setup', // ゲーム作成・設定中
  LOBBY: 'lobby', // ルームで友達を待っている
  PLAYING: 'playing', // ゲーム中
  ENDED: 'ended', // 結果
});

export function initialState() {
  return {
    phase: PHASE.SETUP,
    settings: { ...DEFAULT_SETTINGS },
    startPoint: null, // ゲーム開始地点 { lat, lng }
    area: null, // { center, radiusM }
    room: null, // { code, hostId }
    selfId: null, // この端末のプレイヤーID
    players: [],
    startedAt: null,
    endsAt: null,
  };
}

export const gameStore = createStore(initialState());

export function resetGame() {
  gameStore.setState(initialState());
}

export function updateSettings(input) {
  gameStore.setState((s) => {
    const settings = sanitizeSettings(input, s.settings);
    return {
      settings,
      area: s.startPoint ? createGameArea(s.startPoint, settings.radiusM) : null,
    };
  });
}

export function setStartPoint(point) {
  gameStore.setState((s) => ({
    startPoint: { lat: point.lat, lng: point.lng },
    area: createGameArea(point, s.settings.radiusM),
  }));
}

export function enterLobby({ room, selfId, players }) {
  gameStore.setState({ phase: PHASE.LOBBY, room, selfId, players });
}

export function setPlayers(players) {
  gameStore.setState({ players });
}

export function startGame(now = Date.now(), rng = Math.random) {
  const s = gameStore.getState();
  if (!s.area) throw new Error('ゲーム開始地点が設定されていません');
  const players = assignRoles(s.players, s.settings.hunterCount, rng);
  gameStore.setState({
    phase: PHASE.PLAYING,
    players,
    startedAt: now,
    endsAt: now + s.settings.durationMin * 60 * 1000,
  });
}

export function endGame(now = Date.now()) {
  gameStore.setState({ phase: PHASE.ENDED, endsAt: now });
}

export function selfPlayer(state = gameStore.getState()) {
  return state.players.find((p) => p.id === state.selfId) ?? null;
}
