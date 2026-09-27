// STEP 5: ミッション結果による blurM の変更
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import {
  BLUR_LEVELS_M, MIN_BLUR_M, MAX_BLUR_M, blurAfterMission, shiftBlurLevel,
} from '../oni-game/js/game/blurPolicy.js';
import { BLUR_OPTIONS_M } from '../oni-game/js/game/settings.js';
import { applyMissionOutcome } from '../oni-game/js/game/mission.js';
import { revealEpoch, nextRevealAt } from '../oni-game/js/game/locationPublisher.js';
import {
  gameStore, updatePosition, tickGame, requestCapture, abortGame, getPlayerView, setMissionRandom, PHASE,
} from '../oni-game/js/game/gameState.js';
import { createPlayer, ROLE, STATUS } from '../oni-game/js/game/player.js';
import { CENTER, startStoreGame } from './helpers.js';

setMissionRandom(createSeededRng(31));

const at = (m, bearing) => destinationPoint(CENTER, m, bearing);
const player = (id) => gameStore.getState().players.find((p) => p.id === id);
const areaFor = (viewerId, targetId, now) => getPlayerView(viewerId, now).others.find((p) => p.id === targetId).display;

/**
 * 鬼1人・逃走者2人（初期ぼかし300m・公開間隔30秒）で1回目のミッションを発生させる。
 * a は目的地に到達、b は到達しない。
 */
function playFirstMission({ settings = {}, arrive = true } = {}) {
  const s = startStoreGame({
    ids: ['host', 'r1', 'r2'],
    settings: { durationMin: 10, initialBlurM: 300, revealIntervalSec: 30, captureRadiusM: 10, ...settings },
  });
  const hunter = s.players.find((p) => p.role === ROLE.HUNTER).id;
  const [a, b] = s.players.filter((p) => p.role === ROLE.RUNNER).map((p) => p.id);
  updatePosition(hunter, at(200, 200), 1);
  updatePosition(a, at(40, 30), 1);
  updatePosition(b, at(90, 120), 1);
  const first = gameStore.getState().missions.schedule[0];
  tickGame(first.startsAt);
  if (arrive) {
    const dest = gameStore.getState().missions.active.participants[a].destination;
    updatePosition(a, dest, first.startsAt + 1000);
  }
  return { hunter, a, b, first, endAt: first.startsAt + first.limitMs };
}

// ---- blurPolicy.js ----

test('段階は小さい順・上限と下限・初期ぼかしの選択肢はすべて段階に含まれる', () => {
  assert.deepEqual([...BLUR_LEVELS_M].sort((x, y) => x - y), [...BLUR_LEVELS_M]);
  assert.equal(MIN_BLUR_M, 50);
  assert.equal(MAX_BLUR_M, 1000);
  for (const v of BLUR_OPTIONS_M) assert.ok(BLUR_LEVELS_M.includes(v), `${v}m が段階にない`);
});

test('成功で1段階上がり、失敗で1段階下がる', () => {
  assert.equal(blurAfterMission(300, 'success'), 400);
  assert.equal(blurAfterMission(300, 'failure'), 200);
  assert.equal(blurAfterMission(50, 'success'), 100);
  assert.equal(blurAfterMission(750, 'failure'), 500);
});

test('上限・下限を超えない', () => {
  assert.equal(blurAfterMission(MAX_BLUR_M, 'success'), MAX_BLUR_M);
  assert.equal(blurAfterMission(MIN_BLUR_M, 'failure'), MIN_BLUR_M);
  assert.equal(shiftBlurLevel(300, 100), MAX_BLUR_M);
  assert.equal(shiftBlurLevel(300, -100), MIN_BLUR_M);
  // 4回連続でも範囲内
  let up = 300; let down = 300;
  for (let i = 0; i < 4; i++) { up = blurAfterMission(up, 'success'); down = blurAfterMission(down, 'failure'); }
  assert.equal(up, 1000, '300m は9段階の真ん中なので、4回成功で上限');
  assert.equal(down, 50, '4回失敗で下限');
});

test('無効・不明な結果では変わらない', () => {
  assert.equal(blurAfterMission(300, 'cancelled'), 300);
  assert.equal(blurAfterMission(300, 'pending'), 300);
});

test('applyMissionOutcome: 参加中の逃走者だけが変わり、脱落者・鬼は変わらない', () => {
  const runner = { ...createPlayer({ id: 'r', name: 'r' }), role: ROLE.RUNNER, blurM: 300 };
  const outcome = { missionId: 'mission-1', result: 'success', at: 1 };
  assert.equal(applyMissionOutcome(runner, outcome).blurM, 400);
  const caught = { ...runner, status: STATUS.CAUGHT };
  assert.equal(applyMissionOutcome(caught, outcome).blurM, 300);
  const zombie = { ...runner, role: ROLE.HUNTER, originalRole: ROLE.RUNNER, blurM: null };
  assert.equal(applyMissionOutcome(zombie, outcome).blurM, null);
});

// ---- ゲームの流れの中で ----

test('ミッション終了時に、成功した人は上がり失敗した人は下がる（逃走者ごとに独立）', () => {
  const { a, b, endAt } = playFirstMission();
  assert.equal(player(a).blurM, 300, '到達した瞬間にはまだ変えない（ミッション終了時に反映）');
  tickGame(endAt);
  assert.equal(player(a).blurM, 400);
  assert.equal(player(b).blurM, 200);
});

test('結果が出ても今の円は次の公開まで維持され、次の公開で新しい大きさになる', () => {
  const { hunter, a, b, endAt } = playFirstMission();
  tickGame(endAt - 1);
  const beforeA = areaFor(hunter, a, endAt - 1);
  const beforeB = areaFor(hunter, b, endAt - 1);
  assert.equal(beforeA.radiusM, 300);
  const settings = gameStore.getState().settings;
  const start = gameStore.getState().startedAt;
  assert.equal(revealEpoch(endAt, start, settings), revealEpoch(endAt - 1, start, settings), 'テストの前提: 終了時刻が公開の境目ではない');

  tickGame(endAt);
  assert.deepEqual(areaFor(hunter, a, endAt), beforeA, 'ミッション終了の瞬間に円が変わった');
  assert.deepEqual(areaFor(hunter, b, endAt), beforeB);
  const next = nextRevealAt(endAt, start, settings);
  tickGame(next - 1);
  assert.equal(areaFor(hunter, a, next - 1).radiusM, 300, '次の公開までは同じ');

  tickGame(next);
  assert.equal(areaFor(hunter, a, next).radiusM, 400);
  assert.equal(areaFor(hunter, b, next).radiusM, 200);
  // 本人の画面でも、自分の円は次の公開から変わる
  assert.equal(getPlayerView(a, next).self.possibleArea.radiusM, 400);
});

test('鬼には blurM そのものや、ぼかしが変わったという通知は渡らない', () => {
  const { hunter, a, endAt } = playFirstMission();
  tickGame(endAt);
  const json = JSON.stringify(getPlayerView(hunter, endAt));
  assert.ok(!/"blurM":\d/.test(json), '鬼のビューに blurM の値がある');
  assert.ok(!json.includes('missionHistory":[{'), '鬼のビューに他人のミッション履歴がある');
  const logs = gameStore.getState().log.map((e) => e.text).join('\n');
  assert.ok(!/ぼかし|精度|blur/.test(logs), 'ログにぼかしの変化が書かれている');
  // 本人には自分の blurM が見える
  assert.equal(getPlayerView(a, endAt).self.blurM, 400);
  // 他の逃走者にも他人の blurM は見えない
  const other = getPlayerView(gameStore.getState().players.find((p) => p.role === ROLE.RUNNER && p.id !== a).id, endAt);
  assert.ok(!/"blurM":\d/.test(JSON.stringify(other.others)));
});

test('成功した後でもミッション終了前に確保されたら変わらない（増え鬼OFF）', () => {
  const { hunter, a, endAt } = playFirstMission();
  updatePosition(hunter, gameStore.getState().positions[a], endAt - 5000);
  assert.equal(requestCapture(hunter, endAt - 4000).capturedId, a);
  tickGame(endAt);
  assert.equal(player(a).status, STATUS.CAUGHT);
  assert.equal(player(a).blurM, 300);
});

test('増え鬼: 鬼になった人は可能性エリアが消え、以後のミッションでも blurM は変わらない', () => {
  const { hunter, a, endAt } = playFirstMission({ settings: { zombieMode: true } });
  updatePosition(hunter, gameStore.getState().positions[a], endAt - 5000);
  requestCapture(hunter, endAt - 4000);
  assert.equal(player(a).role, ROLE.HUNTER);
  assert.equal(player(a).blurM, null);
  assert.equal(gameStore.getState().privacy.published[a], undefined, '逃走者用の可能性エリアが残っている');
  assert.equal(areaFor(hunter, a, endAt - 4000).kind, 'exact', '鬼として表示される');
  tickGame(endAt);
  assert.equal(player(a).blurM, null);

  // 次のミッションには参加しない
  const second = gameStore.getState().missions.schedule[1];
  tickGame(second.startsAt);
  assert.equal(gameStore.getState().missions.active.participants[a], undefined);
  tickGame(second.startsAt + second.limitMs);
  assert.equal(player(a).blurM, null);
  assert.equal(gameStore.getState().privacy.published[a], undefined);
});

test('無効になったミッション（ゲーム終了で打ち切り）では変わらず、終了後も変わらない', () => {
  const { a, b, endAt } = playFirstMission();
  abortGame(endAt - 10_000);
  const s = gameStore.getState();
  assert.equal(s.phase, PHASE.FINISHED);
  assert.equal(player(a).blurM, 300, '到達済みでも無効ミッションでは変わらない');
  assert.equal(player(b).blurM, 300);
  tickGame(endAt);
  tickGame(endAt + 10 * 60_000);
  assert.equal(player(a).blurM, 300);
  assert.equal(player(b).blurM, 300);
  // 終了時に実位置・秘密の値・公開済みエリアは破棄されたまま
  const after = gameStore.getState();
  assert.deepEqual(after.positions, {});
  assert.deepEqual(after.privacy.secrets, {});
  assert.deepEqual(after.privacy.published, {});
});

test('上限・下限: 初期ぼかし1000mで成功しても1000m、50mで失敗しても50m', () => {
  let game = playFirstMission({ settings: { initialBlurM: 1000 } });
  tickGame(game.endAt);
  assert.equal(player(game.a).blurM, 1000);
  assert.equal(player(game.b).blurM, 750);

  game = playFirstMission({ settings: { initialBlurM: 50 } });
  tickGame(game.endAt);
  assert.equal(player(game.a).blurM, 100);
  assert.equal(player(game.b).blurM, 50);
});

test('4回のミッションを通して、逃走者ごとに独立して変わる', () => {
  const { a, b, endAt } = playFirstMission();
  tickGame(endAt);
  const { schedule } = gameStore.getState().missions;
  for (const m of schedule.slice(1)) {
    tickGame(m.startsAt);
    // a は毎回到達、b は毎回到達しない
    updatePosition(a, gameStore.getState().missions.active.participants[a].destination, m.startsAt + 1000);
    tickGame(m.startsAt + m.limitMs);
  }
  assert.equal(player(a).blurM, 1000, '300 → 400 → 500 → 750 → 1000');
  assert.equal(player(b).blurM, 50, '300 → 200 → 150 → 100 → 50');
  assert.deepEqual(player(a).missionHistory.map((h) => h.result), ['success', 'success', 'success', 'success']);
});
