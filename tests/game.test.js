import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { createGameArea, isInsideArea, randomPointInArea } from '../oni-game/js/game/gameArea.js';
import { sanitizeSettings, DEFAULT_SETTINGS, settingsWarnings } from '../oni-game/js/game/settings.js';
import { createPlayer, assignRoles, hunters, runners, ROLE } from '../oni-game/js/game/player.js';
import { formatClock, remainingMs } from '../oni-game/js/game/gameTimer.js';
import {
  gameStore, resetGame, updateSettings, setStartPoint, enterLobby, startGame, PHASE,
} from '../oni-game/js/game/gameState.js';

const CENTER = { lat: 35.681236, lng: 139.767125 };

test('randomPointInArea はエリア内（余白付き）に収まる', () => {
  const area = createGameArea(CENTER, 300);
  const rng = createSeededRng(9);
  for (let i = 0; i < 500; i++) {
    assert.ok(isInsideArea(area, randomPointInArea(area, rng, { marginM: 30 }), 29.9));
  }
});

test('不正な開始地点・半径はエラー', () => {
  assert.throws(() => createGameArea({ lat: 999, lng: 0 }, 100));
  assert.throws(() => createGameArea(CENTER, 0));
});

test('設定は選択肢以外の値を受け付けない', () => {
  const s = sanitizeSettings({ durationMin: 7, radiusM: 1000, initialBlurM: 50, hunterCount: 99 });
  assert.equal(s.durationMin, DEFAULT_SETTINGS.durationMin);
  assert.equal(s.radiusM, 1000);
  assert.equal(s.initialBlurM, 50);
  assert.equal(s.hunterCount, 10);
});

test('ぼかしがエリアより大きいと警告', () => {
  assert.equal(settingsWarnings({ ...DEFAULT_SETTINGS, radiusM: 100, initialBlurM: 500 }).length, 1);
  assert.equal(settingsWarnings(DEFAULT_SETTINGS).length, 0);
});

test('名前は空だとエラー、長すぎると切り詰め', () => {
  assert.throws(() => createPlayer({ id: 'a', name: '   ' }));
  assert.equal(createPlayer({ id: 'a', name: 'あ'.repeat(30) }).name.length, 12);
});

test('assignRoles: 指定人数の鬼、逃走者は最低1人', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => createPlayer({ id, name: id }));
  const two = assignRoles(players, 2, createSeededRng(1));
  assert.equal(hunters(two).length, 2);
  assert.equal(runners(two).length, 2);
  const tooMany = assignRoles(players, 10, createSeededRng(1));
  assert.equal(runners(tooMany).length, 1);
  assert.throws(() => assignRoles(players.slice(0, 1), 1));
});

test('タイマー表示', () => {
  assert.equal(formatClock(600_000), '10:00');
  assert.equal(formatClock(59_001), '01:00');
  assert.equal(formatClock(0), '00:00');
  assert.equal(remainingMs(1000, 5000), 0);
});

test('gameState: 設定→開始地点→ロビー→開始', () => {
  resetGame();
  updateSettings({ radiusM: 500, durationMin: 20, hunterCount: 1 });
  assert.equal(gameStore.getState().area, null);
  setStartPoint(CENTER);
  assert.equal(gameStore.getState().area.radiusM, 500);
  updateSettings({ radiusM: 1000 });
  assert.equal(gameStore.getState().area.radiusM, 1000, '半径変更がエリアに反映される');

  const players = ['h', 'x'].map((id) => createPlayer({ id, name: id }));
  enterLobby({ room: { code: 'ABCDEF', hostId: 'h' }, selfId: 'h', players });
  assert.equal(gameStore.getState().phase, PHASE.LOBBY);

  startGame(1_000, createSeededRng(2));
  const s = gameStore.getState();
  assert.equal(s.phase, PHASE.PLAYING);
  assert.equal(s.endsAt, 1_000 + 20 * 60_000);
  assert.equal(s.players.filter((p) => p.role === ROLE.HUNTER).length, 1);
});
