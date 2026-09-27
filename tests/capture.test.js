import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptCapture, findCaptureTargets, CAPTURE_FAILURE, CAPTURE_COOLDOWN_MS } from '../oni-game/js/game/capture.js';
import { ROLE, STATUS } from '../oni-game/js/game/player.js';
import { playingState } from './helpers.js';

const H = ROLE.HUNTER;
const R = ROLE.RUNNER;

test('確保距離より遠い逃走者は確保できない', () => {
  const s = playingState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 15 }], { captureRadiusM: 10 });
  assert.deepEqual(attemptCapture(s, 'h', 1000), { ok: false, reason: CAPTURE_FAILURE.NO_TARGET });
});

test('範囲内に複数いるときは最も近い1人だけを確保する', () => {
  const s = playingState(
    [{ id: 'h', role: H, at: 0 }, { id: 'far', role: R, at: 9 }, { id: 'near', role: R, at: 4 }, { id: 'out', role: R, at: 50 }],
    { captureRadiusM: 10 },
  );
  assert.deepEqual(findCaptureTargets(s, 'h').map((t) => t.player.id), ['near', 'far']);
  const res = attemptCapture(s, 'h', 1000);
  assert.equal(res.capturedId, 'near');
  const byId = Object.fromEntries(res.players.map((p) => [p.id, p]));
  assert.equal(byId.near.status, STATUS.CAUGHT);
  assert.equal(byId.near.caughtAt, 1000);
  assert.equal(byId.near.caughtBy, 'h');
  assert.equal(byId.far.status, STATUS.ACTIVE);
  assert.equal(byId.h.captures, 1);
});

test('増え鬼ONなら捕まった逃走者は鬼になる', () => {
  const s = playingState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 3 }], { zombieMode: true });
  const r = attemptCapture(s, 'h', 1000).players.find((p) => p.id === 'r');
  assert.equal(r.role, ROLE.HUNTER);
  assert.equal(r.status, STATUS.ACTIVE);
  assert.equal(r.originalRole, ROLE.RUNNER);
  assert.equal(r.caughtAt, 1000);
});

test('逃走者・脱落者・位置不明の鬼は確保できない', () => {
  const s = playingState([{ id: 'h', role: H }, { id: 'r', role: R, at: 3 }, { id: 'r2', role: R, at: 0 }]);
  assert.equal(attemptCapture(s, 'r2', 0).reason, CAPTURE_FAILURE.NOT_HUNTER);
  assert.equal(attemptCapture(s, 'h', 0).reason, CAPTURE_FAILURE.NO_POSITION);
  s.players[0] = { ...s.players[0], status: STATUS.CAUGHT };
  assert.equal(attemptCapture(s, 'h', 0).reason, CAPTURE_FAILURE.NOT_HUNTER);
});

test('すでに脱落した逃走者は対象外', () => {
  const s = playingState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 3 }]);
  s.players[1] = { ...s.players[1], status: STATUS.CAUGHT };
  assert.equal(attemptCapture(s, 'h', 0).reason, CAPTURE_FAILURE.NO_TARGET);
});

test('クールダウン中は確保できない', () => {
  const s = playingState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 3 }]);
  s.captureAttempts.h = 1000;
  assert.equal(attemptCapture(s, 'h', 1000 + CAPTURE_COOLDOWN_MS - 1).reason, CAPTURE_FAILURE.COOLDOWN);
  assert.equal(attemptCapture(s, 'h', 1000 + CAPTURE_COOLDOWN_MS).ok, true);
});

test('ゲーム中でなければ確保できない', () => {
  const s = { ...playingState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 3 }]), phase: 'finished' };
  assert.equal(attemptCapture(s, 'h', 0).reason, CAPTURE_FAILURE.NOT_PLAYING);
});
