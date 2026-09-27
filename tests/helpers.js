// テスト用の共通処理
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import { createPlayer } from '../oni-game/js/game/player.js';
import { createGameArea } from '../oni-game/js/game/gameArea.js';
import { DEFAULT_SETTINGS } from '../oni-game/js/game/settings.js';
import {
  resetGame, updateSettings, setStartPoint, enterLobby, startGame, gameStore,
} from '../oni-game/js/game/gameState.js';

export const CENTER = { lat: 35.681236, lng: 139.767125 };
/** 中心から北へ m メートルの地点 */
export const north = (m) => destinationPoint(CENTER, m, 0);

/**
 * 役割を固定したゲーム中の状態を直接作る（純粋関数のテスト用）
 * spec: [{ id, role, at: 北へのm }]
 */
export function playingState(spec, settings = {}) {
  const players = spec.map(({ id, role }) => ({
    ...createPlayer({ id, name: id }),
    role,
    originalRole: role,
  }));
  const positions = Object.fromEntries(spec.filter((p) => p.at != null).map((p) => [p.id, { ...north(p.at), accuracyM: 5, updatedAt: 0 }]));
  return {
    phase: 'playing',
    settings: { ...DEFAULT_SETTINGS, ...settings },
    area: createGameArea(CENTER, 300),
    players,
    positions,
    captureAttempts: {},
    startedAt: 0,
    endsAt: 600_000,
    result: null,
    log: [],
  };
}

/** gameStore をロビー経由でゲーム開始まで進める。host が鬼になるよう rng を固定 */
export function startStoreGame({ ids = ['host', 'r1', 'r2'], settings = {}, positions = {}, rng } = {}) {
  resetGame();
  updateSettings(settings);
  setStartPoint(CENTER);
  enterLobby({
    room: { code: 'ABCDEF', hostId: ids[0] },
    selfId: ids[0],
    players: ids.map((id, i) => createPlayer({ id, name: id, isHost: i === 0 })),
  });
  startGame({ now: 0, rng, initialPositions: positions });
  return gameStore.getState();
}
