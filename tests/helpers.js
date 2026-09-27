// テスト用の共通処理
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import { createPlayer } from '../oni-game/js/game/player.js';
import { createGameArea } from '../oni-game/js/game/gameArea.js';
import { DEFAULT_SETTINGS } from '../oni-game/js/game/settings.js';
import { initPrivacy, publishIfDue } from '../oni-game/js/game/locationPublisher.js';
import { createSeededRng } from '../oni-game/js/utils/random.js';
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
    blurM: role === 'runner' ? (settings.initialBlurM ?? DEFAULT_SETTINGS.initialBlurM) : null,
  }));
  // at = 中心からの距離(m)。方位は人ごとに変える（経度・緯度が他の点と偶然一致しないように）
  const positions = Object.fromEntries(
    spec
      .map((p, i) => ({ ...p, bearing: (i * 67 + 23) % 360 }))
      .filter((p) => p.at != null)
      .map((p) => [p.id, { ...destinationPoint(CENTER, p.at, p.bearing), accuracyM: 5, updatedAt: 0 }]),
  );
  return {
    phase: 'playing',
    settings: { ...DEFAULT_SETTINGS, ...settings },
    area: createGameArea(CENTER, 300),
    players,
    positions,
    privacy: initPrivacy(players, createSeededRng(99)),
    captureAttempts: {},
    startedAt: 0,
    endsAt: 600_000,
    result: null,
    log: [],
  };
}

/** playingState に最初の可能性エリアを公開した状態 */
export function publishedState(spec, settings = {}) {
  const s = playingState(spec, settings);
  return { ...s, privacy: publishIfDue(s, 0).privacy };
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
  startGame({ now: 0, rng, privacyRng: createSeededRng(7), initialPositions: positions });
  return gameStore.getState();
}
