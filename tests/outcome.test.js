import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeOutcome, WINNER, FINISH_REASON } from '../oni-game/js/game/outcome.js';
import { ROLE, STATUS } from '../oni-game/js/game/player.js';
import { playingState } from './helpers.js';

const base = () => playingState([{ id: 'h', role: ROLE.HUNTER }, { id: 'a', role: ROLE.RUNNER }, { id: 'b', role: ROLE.RUNNER }]);

test('時間内で逃走者が残っていれば決着しない', () => {
  assert.equal(judgeOutcome(base(), 599_999), null);
});

test('時間切れで逃走者が1人でも残っていれば逃走者の勝ち', () => {
  const s = base();
  s.players[1] = { ...s.players[1], status: STATUS.CAUGHT };
  assert.deepEqual(judgeOutcome(s, 600_000), { winner: WINNER.RUNNERS, reason: FINISH_REASON.TIME_UP });
});

test('全員確保で鬼の勝ち（時間切れと同時でも鬼）', () => {
  const s = base();
  s.players = s.players.map((p) => (p.role === ROLE.RUNNER ? { ...p, status: STATUS.CAUGHT } : p));
  assert.deepEqual(judgeOutcome(s, 600_000), { winner: WINNER.HUNTERS, reason: FINISH_REASON.ALL_CAUGHT });
});

test('増え鬼で全員が鬼になったら鬼の勝ち', () => {
  const s = base();
  s.players = s.players.map((p) => ({ ...p, role: ROLE.HUNTER }));
  assert.equal(judgeOutcome(s, 1000).winner, WINNER.HUNTERS);
});
