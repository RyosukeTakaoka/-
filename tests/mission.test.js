import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { distanceM, destinationPoint } from '../oni-game/js/utils/distance.js';
import {
  gameStore, updatePosition, tickGame, requestCapture, abortGame, getPlayerView, requestNewDestination,
  setMissionRandom, PHASE,
} from '../oni-game/js/game/gameState.js';
import { MISSION_STATUS } from '../oni-game/js/game/mission.js';
import { ROLE } from '../oni-game/js/game/player.js';
import { CENTER, startStoreGame } from './helpers.js';

setMissionRandom(createSeededRng(21));

const at = (m, bearing) => destinationPoint(CENTER, m, bearing);

/** 鬼1人・逃走者2人でゲームを始め、1回目のミッション直前まで進める */
function setup({ settings = {}, ids = ['host', 'r1', 'r2'] } = {}) {
  const s = startStoreGame({ ids, settings: { durationMin: 10, captureRadiusM: 10, ...settings } });
  const hunter = s.players.find((p) => p.role === ROLE.HUNTER).id;
  const runners = s.players.filter((p) => p.role === ROLE.RUNNER).map((p) => p.id);
  updatePosition(hunter, at(150, 200), 1);
  runners.forEach((id, i) => updatePosition(id, at(40 + i * 60, i * 90 + 30), 1));
  const first = gameStore.getState().missions.schedule[0];
  return { hunter, runners, first };
}

/** ビューの中の {lat,lng} をすべて集める */
function latLngs(value, out = []) {
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.lat) && Number.isFinite(value.lng)) out.push(value);
    for (const v of Object.values(value)) latLngs(v, out);
  }
  return out;
}

const participant = (id) => gameStore.getState().missions.active.participants[id];

test('ゲーム開始時に4回分のスケジュールが作られ、発生前は誰にも知らされない', () => {
  const { hunter, runners, first } = setup();
  const s = gameStore.getState();
  assert.equal(s.missions.schedule.length, 4);
  tickGame(first.startsAt - 1);
  assert.equal(gameStore.getState().missions.active, null);
  for (const id of [hunter, ...runners]) {
    const view = getPlayerView(id, first.startsAt - 1);
    const json = JSON.stringify(view);
    assert.equal(view.mission, null);
    assert.equal(view.self.mission, null);
    for (const planned of s.missions.schedule) assert.ok(!json.includes(String(planned.startsAt)), '発生予定時刻が漏れている');
    assert.ok(!json.includes('"schedule"') && !json.includes('"missions"'));
  }
});

test('発生すると、本人にだけ目的地が公開され、鬼には目的地も実位置も渡らない', () => {
  const { hunter, runners, first } = setup();
  tickGame(first.startsAt);
  const active = gameStore.getState().missions.active;
  assert.equal(active.index, 1);
  assert.equal(active.endsAt - active.startedAt, first.limitMs);

  const secret = [
    ...runners.map((id) => participant(id).destination),
    ...runners.map((id) => gameStore.getState().positions[id]),
  ];
  const hunterView = getPlayerView(hunter, first.startsAt);
  assert.deepEqual(Object.keys(hunterView.mission).sort(), ['endsAt', 'index', 'startedAt', 'total']);
  assert.equal(hunterView.self.mission, null);
  for (const p of latLngs(hunterView)) {
    for (const sp of secret) assert.ok(distanceM(p, sp) > 1, '鬼のビューに目的地か実位置が含まれている');
  }

  // 逃走者は自分の目的地だけを受け取る
  const [a, b] = runners;
  const viewA = getPlayerView(a, first.startsAt);
  assert.ok(distanceM(viewA.self.mission.destination, participant(a).destination) < 0.01);
  for (const p of latLngs(viewA)) assert.ok(distanceM(p, participant(b).destination) > 1, '他人の目的地が見えている');
});

test('到達前は成功にならず、目的地の20m以内に入ると成功（複数人は独立に判定）', () => {
  const { runners, first } = setup();
  tickGame(first.startsAt);
  const [a, b] = runners;
  const dest = participant(a).destination;

  updatePosition(a, destinationPoint(dest, 25, 0), first.startsAt + 1000);
  tickGame(first.startsAt + 1000);
  assert.equal(participant(a).result, MISSION_STATUS.PENDING, '25m では成功にならない');

  updatePosition(a, destinationPoint(dest, 15, 0), first.startsAt + 2000);
  assert.equal(participant(a).result, MISSION_STATUS.SUCCESS);
  assert.equal(participant(b).result, MISSION_STATUS.PENDING, '他の逃走者には影響しない');
  assert.equal(getPlayerView(a, first.startsAt + 2000).self.mission.result, 'success');

  // 鬼や他の人には、終了まで個別の結果を出さない
  const others = getPlayerView(b, first.startsAt + 2000);
  assert.equal(JSON.stringify(others).includes('success'), false);

  // 時間切れ: 到達していない人は失敗
  tickGame(first.startsAt + first.limitMs);
  const s = gameStore.getState();
  assert.equal(s.missions.active, null);
  const last = s.missions.history.at(-1);
  assert.equal(last.results[a], MISSION_STATUS.SUCCESS);
  assert.equal(last.results[b], MISSION_STATUS.FAILURE);
  assert.ok(!JSON.stringify(last).includes('"lat"'), '履歴に座標を残さない');
  // プレイヤーの履歴に記録（STEP 5 で blurM 変更に使う）
  const pa = s.players.find((p) => p.id === a);
  const pb = s.players.find((p) => p.id === b);
  assert.deepEqual(pa.missionHistory.map((h) => h.result), ['success']);
  assert.deepEqual(pb.missionHistory.map((h) => h.result), ['failure']);
  // 終了後は全員に人数だけ
  const summary = getPlayerView(b, first.startsAt + first.limitMs).lastMission;
  assert.deepEqual(summary, { index: 1, success: 1, failure: 1, cancelled: 0 });
  assert.ok(s.log.some((e) => e.type === 'mission_end' && e.text.includes('成功 1人・失敗 1人')));
});

test('時間切れの瞬間より後に到達しても成功にならない', () => {
  const { runners, first } = setup();
  tickGame(first.startsAt);
  const [a] = runners;
  const dest = participant(a).destination;
  tickGame(first.startsAt + first.limitMs);
  updatePosition(a, dest, first.startsAt + first.limitMs + 1);
  assert.equal(gameStore.getState().missions.history.at(-1).results[a], MISSION_STATUS.FAILURE);
});

test('4回すべて発生して終わる', () => {
  const { first } = setup();
  const { schedule } = gameStore.getState().missions;
  for (const m of schedule) {
    tickGame(m.startsAt);
    assert.equal(gameStore.getState().missions.active.index, m.index);
    tickGame(m.startsAt + m.limitMs);
    assert.equal(gameStore.getState().missions.active, null);
  }
  assert.equal(gameStore.getState().missions.history.length, 4);
  assert.ok(first);
});

test('ミッション中に確保された逃走者は無効（成功にも失敗にもしない）', () => {
  const { hunter, runners, first } = setup();
  tickGame(first.startsAt);
  const [a] = runners;
  updatePosition(hunter, gameStore.getState().positions[a], first.startsAt + 100);
  requestCapture(hunter, first.startsAt + 200);
  assert.equal(participant(a).result, MISSION_STATUS.CANCELLED);
  tickGame(first.startsAt + first.limitMs);
  assert.deepEqual(gameStore.getState().players.find((p) => p.id === a).missionHistory, []);
});

test('ゲームが終わると進行中のミッションも終了し、以降のミッションは発生しない', () => {
  const { runners, first } = setup();
  tickGame(first.startsAt);
  abortGame(first.startsAt + 1000);
  const s = gameStore.getState();
  assert.equal(s.phase, PHASE.FINISHED);
  assert.equal(s.missions.active, null);
  assert.equal(s.missions.schedule.length, 0);
  assert.deepEqual(Object.values(s.missions.history.at(-1).results), runners.map(() => MISSION_STATUS.CANCELLED));
  tickGame(first.startsAt + 10 * 60_000);
  assert.equal(gameStore.getState().missions.history.length, 1);
  assert.equal(getPlayerView(runners[0]).self.mission, null);
});

test('時間切れでゲームが終わるときもミッションは発生済み分で終わる', () => {
  setup();
  const s = gameStore.getState();
  tickGame(s.endsAt);
  assert.equal(gameStore.getState().phase, PHASE.FINISHED);
  assert.equal(gameStore.getState().missions.active, null);
});

test('行けない目的地は1回だけ変更できる', () => {
  const { runners, hunter, first } = setup();
  tickGame(first.startsAt);
  const [a] = runners;
  const before = participant(a).destination;
  assert.equal(requestNewDestination(a, first.startsAt + 1000).ok, true);
  assert.ok(distanceM(before, participant(a).destination) > 0.01);
  assert.equal(requestNewDestination(a, first.startsAt + 2000).reason, 'already_rerolled');
  assert.equal(requestNewDestination(hunter, first.startsAt + 2000).ok, false, '鬼は変更できない');
});
