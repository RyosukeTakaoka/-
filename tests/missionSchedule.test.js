import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { generateMissionSchedule, missionTiming, MISSION_COUNT, MIN_LIMIT_MS } from '../oni-game/js/game/missionSchedule.js';
import { DURATION_OPTIONS_MIN } from '../oni-game/js/game/settings.js';

const MIN = 60_000;

function checkSchedule(durationMs, schedule) {
  const { bufferMs, gapMs } = missionTiming(durationMs);
  assert.equal(schedule.length, MISSION_COUNT, '必ず4回');
  assert.deepEqual(schedule.map((m) => m.index), [1, 2, 3, 4]);
  assert.ok(schedule[0].offsetMs >= bufferMs - 1, '開始直後に発生しない');
  const last = schedule.at(-1);
  assert.ok(last.offsetMs + last.limitMs <= durationMs - bufferMs + 1, '終了直前までに終わる');
  for (let i = 1; i < schedule.length; i++) {
    const prevEnd = schedule[i - 1].offsetMs + schedule[i - 1].limitMs;
    assert.ok(schedule[i].offsetMs - prevEnd >= gapMs - 1, `ミッション${i}と${i + 1}の間隔が短い`);
  }
  for (const m of schedule) assert.ok(m.limitMs >= MIN_LIMIT_MS);
}

test('どのゲーム時間でも必ず4回・最低間隔あり・ゲーム時間内（乱数を変えて500回）', () => {
  for (const minutes of DURATION_OPTIONS_MIN) {
    const rng = createSeededRng(minutes);
    for (let i = 0; i < 500; i++) checkSchedule(minutes * MIN, generateMissionSchedule(minutes * MIN, rng));
  }
});

test('短いゲーム（5分）でも4回成立する', () => {
  const t = missionTiming(5 * MIN);
  assert.ok(t.limitMs >= MIN_LIMIT_MS);
  assert.ok(t.slackMs >= 0);
  checkSchedule(5 * MIN, generateMissionSchedule(5 * MIN, createSeededRng(1)));
  // 選択肢にない中途半端な長さでも成立する
  for (const ms of [3 * MIN, 4 * MIN, 7 * MIN, 13 * MIN]) checkSchedule(ms, generateMissionSchedule(ms, createSeededRng(2)));
});

test('4回入らないほど短いゲームはエラーにする（黙って4回未満にしない）', () => {
  assert.throws(() => generateMissionSchedule(2 * MIN), /4回/);
});

test('制限時間の例', () => {
  assert.equal(missionTiming(10 * MIN).limitMs, 60_000);
  assert.equal(missionTiming(30 * MIN).limitMs, 180_000);
  assert.equal(missionTiming(60 * MIN).limitMs, 300_000);
});

test('ゲーム全体に分散し、毎回同じ時刻にはならない', () => {
  const D = 20 * MIN;
  const rng = createSeededRng(9);
  const sums = [0, 0, 0, 0];
  const firsts = new Set();
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const s = generateMissionSchedule(D, rng);
    s.forEach((m, k) => { sums[k] += m.offsetMs / D; });
    firsts.add(Math.round(s[0].offsetMs / 1000));
    // 1回目から4回目までがゲームの半分以上に広がる
    assert.ok((s[3].offsetMs - s[0].offsetMs) / D > 0.5);
  }
  const means = sums.map((x) => x / N);
  // 平均するとおおよそ均等（1回目 ≈ 前半、4回目 ≈ 後半）
  assert.ok(means[0] > 0.08 && means[0] < 0.3, `1回目の平均 ${means[0]}`);
  assert.ok(means[3] > 0.6 && means[3] < 0.9, `4回目の平均 ${means[3]}`);
  assert.ok(firsts.size > 50, '発生時刻がばらつく');
});
