import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import {
  gameStore, updatePosition, requestCapture, tickGame, abortGame, getPlayerView, PHASE,
} from '../oni-game/js/game/gameState.js';
import { ROLE, STATUS } from '../oni-game/js/game/player.js';
import { WINNER, FINISH_REASON } from '../oni-game/js/game/outcome.js';
import { CAPTURE_FAILURE } from '../oni-game/js/game/capture.js';
import { startStoreGame, north } from './helpers.js';

const hunterOf = (s) => s.players.find((p) => p.role === ROLE.HUNTER).id;
const runnerIds = (s) => s.players.filter((p) => p.role === ROLE.RUNNER).map((p) => p.id);

test('開始: playing・開始時刻・終了時刻・役割・初期ぼかし', () => {
  const s = startStoreGame({ settings: { durationMin: 5, hunterCount: 1, initialBlurM: 500 }, rng: createSeededRng(1) });
  assert.equal(s.phase, PHASE.PLAYING);
  assert.equal(s.startedAt, 0);
  assert.equal(s.endsAt, 5 * 60_000);
  assert.equal(s.players.filter((p) => p.role === ROLE.HUNTER).length, 1);
  for (const p of s.players) {
    assert.equal(p.status, STATUS.ACTIVE);
    assert.deepEqual(p.missionHistory, []);
    assert.equal(p.blurM, p.role === ROLE.RUNNER ? 500 : null);
    assert.equal(p.position, undefined, 'Player に実位置を持たせない');
  }
});

test('複数鬼', () => {
  const s = startStoreGame({ ids: ['a', 'b', 'c', 'd', 'e'], settings: { hunterCount: 2 } });
  assert.equal(s.players.filter((p) => p.role === ROLE.HUNTER).length, 2);
});

test('時間切れで逃走者の勝ち・位置情報は消去される', () => {
  startStoreGame({ settings: { durationMin: 5 }, positions: { host: north(0) } });
  tickGame(5 * 60_000 - 1);
  assert.equal(gameStore.getState().phase, PHASE.PLAYING);
  tickGame(5 * 60_000);
  const s = gameStore.getState();
  assert.equal(s.phase, PHASE.FINISHED);
  assert.deepEqual(s.result, { winner: WINNER.RUNNERS, reason: FINISH_REASON.TIME_UP, finishedAt: 5 * 60_000 });
  assert.deepEqual(s.positions, {});
  updatePosition('host', north(10), 5 * 60_000 + 1);
  assert.deepEqual(gameStore.getState().positions, {}, '終了後は位置を受け付けない');
});

test('全員確保で鬼の勝ち（増え鬼OFF）', () => {
  let s = startStoreGame({ settings: { captureRadiusM: 10 } });
  const h = hunterOf(s);
  const [r1, r2] = runnerIds(s);
  updatePosition(h, north(0), 1);
  updatePosition(r1, north(3), 1);
  updatePosition(r2, north(6), 1);
  assert.equal(requestCapture(h, 1000).capturedId, r1);
  assert.equal(requestCapture(h, 2000).reason, CAPTURE_FAILURE.COOLDOWN);
  assert.equal(requestCapture(h, 5000).capturedId, r2);
  s = gameStore.getState();
  assert.equal(s.phase, PHASE.FINISHED);
  assert.equal(s.result.winner, WINNER.HUNTERS);
  assert.ok(s.players.filter((p) => p.originalRole === ROLE.RUNNER).every((p) => p.status === STATUS.CAUGHT));
});

test('増え鬼ONで捕まった人が鬼として確保できる', () => {
  const s = startStoreGame({ settings: { zombieMode: true, captureRadiusM: 10 } });
  const h = hunterOf(s);
  const [r1, r2] = runnerIds(s);
  updatePosition(h, north(0), 1);
  updatePosition(r1, north(3), 1);
  updatePosition(r2, north(200), 1);
  requestCapture(h, 1000);
  updatePosition(r2, north(8), 2);
  assert.equal(requestCapture(r1, 2000).capturedId, r2, '鬼になった元逃走者が確保');
  assert.equal(gameStore.getState().result.winner, WINNER.HUNTERS);
});

test('ホストの途中終了', () => {
  startStoreGame();
  abortGame(1000);
  assert.equal(gameStore.getState().result.reason, FINISH_REASON.ABORTED);
});

test('確保の結果・ログに座標は含まれない', () => {
  const s = startStoreGame({ settings: { captureRadiusM: 10 } });
  const h = hunterOf(s);
  const [r1] = runnerIds(s);
  updatePosition(h, north(0), 1);
  updatePosition(r1, north(3), 1);
  const result = requestCapture(h, 1000);
  assert.deepEqual(Object.keys(result).sort(), ['capturedId', 'ok']);
  const view = JSON.stringify(getPlayerView(h, 1000));
  assert.ok(!view.includes(String(north(3).lat)));
});
