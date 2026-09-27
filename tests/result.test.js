// STEP 6: ゲーム終了・結果
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import {
  buildResultSummary, resultViewFor, MISSION_SUMMARY_STATUS, PERSONAL_RESULT,
} from '../oni-game/js/game/resultSummary.js';
import {
  gameStore, updatePosition, tickGame, requestCapture, abortGame, setMissionRandom, prepareRematch,
  setStartPoint, returnToLobby, startGame, PHASE,
} from '../oni-game/js/game/gameState.js';
import { ROLE } from '../oni-game/js/game/player.js';
import { WINNER, FINISH_REASON } from '../oni-game/js/game/outcome.js';
import { CENTER, startStoreGame } from './helpers.js';

setMissionRandom(createSeededRng(41));

const at = (m, bearing) => destinationPoint(CENTER, m, bearing);

/** 鬼1人・逃走者2人でゲームを始める */
function setup(settings = {}) {
  const s = startStoreGame({
    ids: ['host', 'r1', 'r2'],
    settings: { durationMin: 10, captureRadiusM: 10, revealIntervalSec: 30, ...settings },
  });
  const hunter = s.players.find((p) => p.role === ROLE.HUNTER).id;
  const [a, b] = s.players.filter((p) => p.role === ROLE.RUNNER).map((p) => p.id);
  updatePosition(hunter, at(200, 200), 1);
  updatePosition(a, at(40, 30), 1);
  updatePosition(b, at(90, 120), 1);
  return { hunter, a, b, s: gameStore.getState() };
}

function capture(hunter, runner, now) {
  updatePosition(hunter, gameStore.getState().positions[runner], now - 1);
  return requestCapture(hunter, now);
}

const summary = () => gameStore.getState().resultSummary;
const row = (id) => summary().players.find((p) => p.id === id);

/** オブジェクトの中のキーをすべて集める */
function allKeys(value, out = new Set()) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

// ---- 勝敗 ----

test('時間切れ: 逃走者が残っていれば逃走者の勝利', () => {
  const { a } = setup();
  const end = gameStore.getState().endsAt;
  tickGame(end + 240); // タイマーが少し遅れて動いても
  assert.equal(summary().winner, WINNER.RUNNERS);
  assert.equal(summary().reason, FINISH_REASON.TIME_UP);
  assert.equal(summary().headline, '時間切れ！逃走者の勝利');
  assert.equal(row(a).survived, true);
  assert.equal(summary().playedMs, 10 * 60_000);
});

test('全員確保: 鬼の勝利・確保人数', () => {
  const { hunter, a, b } = setup();
  capture(hunter, a, 60_000);
  capture(hunter, b, 120_000);
  assert.equal(gameStore.getState().phase, PHASE.FINISHED);
  assert.equal(summary().winner, WINNER.HUNTERS);
  assert.equal(summary().reason, FINISH_REASON.ALL_CAUGHT);
  assert.equal(summary().headline, '全員確保！鬼の勝利');
  assert.equal(row(hunter).captures, 2);
  assert.equal(row(a).caught, true);
  assert.equal(row(a).caughtAfterMin, 1, '確保時刻は「開始から何分台か」だけ');
  assert.equal(row(b).caughtAfterMin, 2);
  assert.equal(row(a).survived, false);
});

test('同時: 制限時間ちょうどに最後の1人を確保したら鬼の勝利（現在のルールを維持）', () => {
  const { hunter, a, b } = setup();
  capture(hunter, a, 60_000);
  const end = gameStore.getState().endsAt;
  capture(hunter, b, end);
  assert.equal(summary().winner, WINNER.HUNTERS);
  assert.equal(summary().reason, FINISH_REASON.ALL_CAUGHT);
});

test('ホストの途中終了は勝敗なし', () => {
  setup();
  abortGame(30_000);
  assert.equal(summary().winner, null);
  assert.equal(summary().reason, FINISH_REASON.ABORTED);
});

// ---- プレイヤー ----

test('開始時の役割・最終的な役割（増え鬼で「逃走者 → 鬼」）', () => {
  const { hunter, a, b } = setup({ zombieMode: true });
  capture(hunter, a, 60_000);
  capture(a, b, 90_000); // 鬼になった a が b を確保 → 全員確保
  assert.equal(summary().winner, WINNER.HUNTERS);
  assert.deepEqual(
    { start: row(hunter).startRole, final: row(hunter).finalRole, changed: row(hunter).roleChanged },
    { start: ROLE.HUNTER, final: ROLE.HUNTER, changed: false },
  );
  assert.deepEqual(
    { start: row(a).startRole, final: row(a).finalRole, changed: row(a).roleChanged, captures: row(a).captures },
    { start: ROLE.RUNNER, final: ROLE.HUNTER, changed: true, captures: 1 },
  );
  assert.equal(row(b).roleChanged, true);
  assert.equal(row(a).caught, true);
  assert.equal(summary().zombieMode, true);
});

// ---- ミッション ----

test('4回分のミッションを集計し、本人の結果は本人にだけ見せる', () => {
  const { a, b } = setup();
  const { schedule } = gameStore.getState().missions;
  for (const m of schedule) {
    tickGame(m.startsAt);
    updatePosition(a, gameStore.getState().missions.active.participants[a].destination, m.startsAt + 1000);
    tickGame(m.startsAt + m.limitMs);
  }
  tickGame(gameStore.getState().endsAt);
  const s = summary();
  assert.equal(s.missions.length, 4);
  for (const m of s.missions) {
    assert.deepEqual(m, { index: m.index, status: MISSION_SUMMARY_STATUS.COMPLETED, success: 1, failure: 1, cancelled: 0 });
  }
  const viewA = resultViewFor(s, a);
  assert.deepEqual(viewA.self.missions.map((m) => m.result), Array(4).fill(PERSONAL_RESULT.SUCCESS));
  assert.deepEqual(resultViewFor(s, b).self.missions.map((m) => m.result), Array(4).fill(PERSONAL_RESULT.FAILURE));
  // 他人の個人結果は含まれない
  assert.equal(viewA.personal, undefined);
  assert.ok(!JSON.stringify(viewA).includes(`"${b}":{"missions"`));
});

test('ゲーム終了で打ち切られたミッションは無効、発生前のミッションは「未実施」', () => {
  const { hunter, a } = setup();
  const { schedule } = gameStore.getState().missions;
  tickGame(schedule[0].startsAt);
  tickGame(schedule[0].startsAt + schedule[0].limitMs);
  tickGame(schedule[1].startsAt);
  capture(hunter, a, schedule[1].startsAt + 1000); // ミッション中に確保 → a は無効
  abortGame(schedule[1].startsAt + 2000);
  const s = summary();
  assert.deepEqual(s.missions.map((m) => m.status), [
    MISSION_SUMMARY_STATUS.COMPLETED,
    MISSION_SUMMARY_STATUS.ENDED_BY_GAME_OVER,
    MISSION_SUMMARY_STATUS.NOT_HELD,
    MISSION_SUMMARY_STATUS.NOT_HELD,
  ]);
  assert.deepEqual(s.missions[0], { index: 1, status: MISSION_SUMMARY_STATUS.COMPLETED, success: 0, failure: 2, cancelled: 0 });
  assert.deepEqual(s.missions[1], { index: 2, status: MISSION_SUMMARY_STATUS.ENDED_BY_GAME_OVER, success: 0, failure: 0, cancelled: 2 });
  assert.deepEqual(resultViewFor(s, a).self.missions.map((m) => m.result), [
    PERSONAL_RESULT.FAILURE, PERSONAL_RESULT.CANCELLED, PERSONAL_RESULT.NOT_PARTICIPATED, PERSONAL_RESULT.NOT_PARTICIPATED,
  ]);
  assert.deepEqual(resultViewFor(s, hunter).self.missions.map((m) => m.result), Array(4).fill(PERSONAL_RESULT.NOT_PARTICIPATED));
});

// ---- 位置情報を含まない ----

test('結果データに GPS 座標・可能性エリア・秘密値・目的地が含まれない', () => {
  const { a, hunter } = setup();
  const { schedule } = gameStore.getState().missions;
  tickGame(schedule[0].startsAt);
  tickGame(30_000 * Math.ceil((schedule[0].startsAt + 1) / 30_000)); // 可能性エリアの公開も進める
  const before = gameStore.getState();
  const secrets = before.privacy.secrets;
  const destination = before.missions.active.participants[a].destination;
  const realA = before.positions[a];
  const published = before.privacy.published[a];
  capture(hunter, a, schedule[0].startsAt + 20_000);
  abortGame(schedule[0].startsAt + 25_000);

  const s = summary();
  const keys = allKeys(s);
  for (const forbidden of ['lat', 'lng', 'center', 'radiusM', 'blurM', 'position', 'positions', 'destination',
    'privacy', 'published', 'secrets', 'seed', 'gridAngle', 'gridU', 'gridV', 'cells', 'caughtAt', 'caughtBy',
    'resolvedAt', 'accuracyM']) {
    assert.ok(!keys.has(forbidden), `結果データに ${forbidden} がある`);
  }
  const json = JSON.stringify(s);
  for (const v of [realA.lat, realA.lng, destination.lat, destination.lng, published.center.lat, secrets[a].seed]) {
    assert.ok(!json.includes(String(v)), `結果データに位置・秘密の値 ${v} が含まれる`);
  }
  // 終了時に破棄されている
  const after = gameStore.getState();
  assert.deepEqual(after.positions, {});
  assert.deepEqual(after.privacy.secrets, {});
  assert.deepEqual(after.privacy.published, {});
  assert.equal(after.missions.active, null);
  assert.deepEqual(after.missions.schedule, []);
});

test('結果は位置情報なしの状態からでも作れる（positions・privacy を持たない入力）', () => {
  setup();
  abortGame(10_000);
  const { gameId, players, missions, settings, startedAt, result } = gameStore.getState();
  const summaryFromMinimal = buildResultSummary({ gameId, players, missions: { history: missions.history }, settings, startedAt, result });
  assert.deepEqual(summaryFromMinimal, summary());
});

test('結果画面のコードは位置情報を読まない', () => {
  const source = readFileSync(new URL('../oni-game/js/screens/result.js', import.meta.url), 'utf8');
  for (const word of ['positions', 'privacy', 'getPlayerView', 'possibleArea', 'destination', 'createBoard', 'gameStore']) {
    assert.ok(!source.includes(word), `result.js が ${word} を参照している`);
  }
  assert.ok(source.includes('gameService.getResultView('), '結果は gameService.getResultView（resultViewFor）から受け取る');
});

// ---- もう一度遊ぶ ----

test('もう一度遊ぶ: メンバーと設定だけを引き継ぎ、位置情報・秘密値・ミッションは新しく作る', () => {
  const { hunter, a, s: first } = setup({ durationMin: 20, initialBlurM: 500, zombieMode: true });
  gameStore.setState({ exclusionZones: [{ center: at(50, 0), radiusM: 30 }] });
  tickGame(first.missions.schedule[0].startsAt);
  capture(hunter, a, first.missions.schedule[0].startsAt + 1000);
  abortGame(first.missions.schedule[0].startsAt + 2000);
  const old = gameStore.getState();

  prepareRematch();
  const r = gameStore.getState();
  assert.equal(r.phase, PHASE.SETUP);
  assert.deepEqual(r.settings, old.settings, '設定は引き継ぐ');
  assert.equal(r.room, old.room);
  assert.deepEqual(r.players.map((p) => p.id), old.players.map((p) => p.id), '同じメンバー');
  for (const p of r.players) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'isDummy', 'isHost', 'name'], '前のゲームの役割・状態・ぼかしを残さない');
  }
  assert.equal(r.startPoint, null, '開始地点は設定し直す');
  assert.equal(r.area, null);
  assert.deepEqual(r.exclusionZones, [], '除外エリア（場所の情報）も引き継がない');
  assert.deepEqual(r.positions, {});
  assert.deepEqual(r.privacy.secrets, {});
  assert.deepEqual(r.privacy.published, {});
  assert.deepEqual(r.missions.schedule, []);
  assert.deepEqual(r.missions.history, []);
  assert.equal(r.resultSummary, null);
  assert.equal(r.gameId, null);

  // 新しい開始地点でロビーへ → 開始
  setStartPoint(at(500, 90));
  returnToLobby();
  startGame({ now: 1_000_000 });
  const next = gameStore.getState();
  assert.equal(next.phase, PHASE.PLAYING);
  assert.notEqual(next.gameId, old.gameId, '新しいゲームID');
  assert.ok(next.gameId);
  assert.notDeepEqual(next.area.center, old.area.center, '新しい開始地点');
  assert.deepEqual(next.positions, {}, '前のゲームの実位置を使わない');
  for (const id of Object.keys(next.privacy.secrets)) {
    assert.notEqual(next.privacy.secrets[id].seed, first.privacy.secrets[id].seed, '秘密値を作り直す');
  }
  assert.deepEqual(next.privacy.published, {}, '前の可能性エリアを使わない');
  const offsets = (st) => st.missions.schedule.map((m) => m.startsAt - st.startedAt);
  assert.equal(next.missions.schedule.length, 4);
  assert.notDeepEqual(offsets(next), offsets(first), '新しいミッションスケジュール');
  assert.ok(next.players.every((p) => p.missionHistory.length === 0 && p.captures === 0 && p.status === 'active'));
  assert.ok(next.players.filter((p) => p.role === ROLE.RUNNER).every((p) => p.blurM === 500), 'ぼかしは設定の初期値から');
});

test('ゲーム中・終了前は「もう一度遊ぶ」できない', () => {
  setup();
  assert.throws(() => prepareRematch());
});
