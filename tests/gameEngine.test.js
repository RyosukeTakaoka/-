// STEP 7-A2: gameEngine の性質（純粋・時刻と乱数の注入・依存関係）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import * as engine from '../oni-game/js/game/gameEngine.js';
import { createPlayer, ROLE } from '../oni-game/js/game/player.js';
import { buildResultSummary } from '../oni-game/js/game/resultSummary.js';
import { computePossibleArea, createPrivacySecret } from '../oni-game/js/game/privacyArea.js';
import { CENTER } from './helpers.js';

const at = (m, bearing) => destinationPoint(CENTER, m, bearing);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function lobbyState() {
  let s = engine.initialState();
  s = engine.updateSettings(s, { durationMin: 10, captureRadiusM: 10, revealIntervalSec: 30 });
  s = engine.setStartPoint(s, CENTER);
  return engine.enterLobby(s, {
    room: { code: 'ABCDEF', hostId: 'h' },
    selfId: 'h',
    players: ['h', 'a', 'b'].map((id, i) => createPlayer({ id, name: id, isHost: i === 0 })),
  });
}

const ctxAt = (now, seed = 1) => ({
  now,
  rng: {
    roles: createSeededRng(seed),
    privacy: createSeededRng(seed + 1),
    schedule: createSeededRng(seed + 2),
    destinations: createSeededRng(seed + 3),
  },
  newId: () => `game-${seed}`,
});

/** 一通り進めるシナリオ。各段階の state を返す */
function scenario(seed) {
  const states = [];
  let s = deepFreeze(lobbyState());
  const push = (r) => { s = deepFreeze(r.state ?? r); states.push(s); return r; };
  push(engine.startGame(s, {}, ctxAt(0, seed)));
  const hunter = s.players.find((p) => p.role === ROLE.HUNTER).id;
  const [a, b] = s.players.filter((p) => p.role === ROLE.RUNNER).map((p) => p.id);
  push(engine.updatePosition(s, { playerId: hunter, pos: at(200, 200) }, ctxAt(1, seed)));
  push(engine.updatePosition(s, { playerId: a, pos: at(40, 30) }, ctxAt(1, seed)));
  push(engine.updatePosition(s, { playerId: b, pos: at(90, 120) }, ctxAt(1, seed)));
  const first = s.missions.schedule[0];
  push(engine.advance(s, ctxAt(first.startsAt, seed)));
  push(engine.updatePosition(s, { playerId: a, pos: s.missions.active.participants[a].destination }, ctxAt(first.startsAt + 1000, seed)));
  push(engine.advance(s, ctxAt(first.startsAt + first.limitMs, seed)));
  push(engine.updatePosition(s, { playerId: hunter, pos: s.positions[b] }, ctxAt(first.startsAt + first.limitMs + 1, seed)));
  push(engine.requestCapture(s, { hunterId: hunter }, ctxAt(first.startsAt + first.limitMs + 2, seed)));
  push(engine.advance(s, ctxAt(s.endsAt, seed)));
  return { states, hunter, a, b };
}

test('入力の state を書き換えない（凍結した state で最後まで動く）', () => {
  const { states } = scenario(1); // deepFreeze した state を渡しても例外にならない
  assert.equal(states.at(-1).phase, engine.PHASE.FINISHED);
});

test('同じ入力・同じ時刻・同じ乱数なら同じ結果（共有状態に依存しない）', () => {
  const x = scenario(7);
  const y = scenario(7);
  assert.deepStrictEqual(x.states, y.states);
  const z = scenario(8);
  assert.notDeepStrictEqual(z.states.at(-1).resultSummary, undefined);
});

test('時刻は外から渡す（ctx.now が無ければエラー）', () => {
  const s = lobbyState();
  assert.throws(() => engine.startGame(s, {}, {}), /ctx.now/);
  assert.throws(() => engine.advance(s, {}), /ctx.now/);
  assert.throws(() => engine.requestCapture(s, { hunterId: 'h' }, undefined), /ctx.now/);
});

test('乱数・ゲームIDは外から渡せる（秘密値・スケジュールが rng で決まる）', () => {
  const s = lobbyState();
  const r1 = engine.startGame(s, {}, ctxAt(0, 3)).state;
  const r2 = engine.startGame(s, {}, ctxAt(0, 3)).state;
  const r3 = engine.startGame(s, {}, ctxAt(0, 4)).state;
  assert.equal(r1.gameId, 'game-3');
  assert.deepStrictEqual(r1.privacy.secrets, r2.privacy.secrets);
  assert.deepStrictEqual(r1.missions.schedule, r2.missions.schedule);
  assert.notDeepStrictEqual(r1.privacy.secrets, r3.privacy.secrets);
  assert.notDeepStrictEqual(r1.missions.schedule, r3.missions.schedule);
});

test('events はその操作で起きたことだけ', () => {
  const s = lobbyState();
  const started = engine.startGame(s, {}, ctxAt(0));
  assert.deepEqual(started.events.map((e) => e.type), ['start']);
  const idle = engine.advance(started.state, ctxAt(1000));
  assert.deepEqual(idle.events, []);
  assert.equal(idle.state, started.state, '何も起きなければ同じ state を返す');
  const reveal = engine.advance(started.state, ctxAt(30_000));
  assert.deepEqual(reveal.events.map((e) => e.type), ['reveal']);
});

test('nextDueAt: 次の公開・ミッション・終了のうち一番早い時刻', () => {
  const s = engine.startGame(lobbyState(), {}, ctxAt(0)).state;
  const first = s.missions.schedule[0];
  assert.equal(engine.nextDueAt(s), Math.min(30_000, first.startsAt));
  const inMission = engine.advance(s, ctxAt(first.startsAt)).state;
  const expected = Math.min(first.startsAt + first.limitMs, 30_000 * (inMission.privacy.epoch + 1));
  assert.equal(engine.nextDueAt(inMission), expected);
  // nextDueAt ちょうどで advance すると何かが起きる
  const due = engine.nextDueAt(inMission);
  assert.ok(engine.advance(inMission, ctxAt(due)).events.length > 0);
  assert.equal(engine.nextDueAt(lobbyState()), null);
});

test('claimArrival: サーバーの実位置と秘密の目的地で判定する', () => {
  let s = engine.startGame(lobbyState(), {}, ctxAt(0)).state;
  const runner = s.players.find((p) => p.role === ROLE.RUNNER).id;
  s = engine.updatePosition(s, { playerId: runner, pos: at(40, 30) }, ctxAt(1)).state;
  s = engine.advance(s, ctxAt(s.missions.schedule[0].startsAt)).state;
  const dest = s.missions.active.participants[runner].destination;
  // 実位置が遠いまま申告しても成功しない
  assert.deepEqual(engine.claimArrival(s, { runnerId: runner }, ctxAt(s.missions.active.startedAt + 1)).result, { ok: false, reason: 'not_arrived' });
  // 実位置を直接書き込んで（自動判定を通さずに）申告する
  const near = { ...s, positions: { ...s.positions, [runner]: { ...destinationPoint(dest, 10, 0), accuracyM: 5, updatedAt: 2 } } };
  const r = engine.claimArrival(near, { runnerId: runner }, ctxAt(s.missions.active.startedAt + 2));
  assert.deepEqual(r.result, { ok: true });
  assert.equal(r.state.missions.active.participants[runner].result, 'success');
  // 鬼は申告できない
  const hunter = s.players.find((p) => p.role === ROLE.HUNTER).id;
  assert.equal(engine.claimArrival(s, { runnerId: hunter }, ctxAt(3)).result.ok, false);
});

test('resultSummary は位置情報なしの状態で動く', () => {
  const { states } = scenario(2);
  const finished = states.at(-1);
  const { positions, privacy, missions, ...rest } = finished;
  const summary = buildResultSummary({ ...rest, missions: { history: missions.history } });
  assert.deepStrictEqual(summary, finished.resultSummary);
});

test('privacyArea は Node.js でそのまま動く', () => {
  const area = computePossibleArea({
    position: at(100, 45), blurM: 300, secret: createPrivacySecret(createSeededRng(1)), epoch: 0, origin: CENTER,
  });
  assert.equal(area.radiusM, 300);
});

// ---- 依存関係（ソースコードを読んで確認） ----

const gameDir = new URL('../oni-game/js/game/', import.meta.url);
const read = (name) => readFileSync(new URL(name, gameDir), 'utf8');
const importsOf = (src) => [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
const BROWSER = /\b(window|document|navigator|localStorage|sessionStorage|location\.)/;

test('game/ のルール（gameState.js 以外）はブラウザ API・Firebase・画面・地図に依存しない', () => {
  for (const file of readdirSync(gameDir).filter((f) => f.endsWith('.js') && f !== 'gameState.js')) {
    const src = read(file).replace(/\/\/.*$/gm, ''); // コメントを除く
    assert.ok(!BROWSER.test(src), `${file} がブラウザ API を使っている`);
    for (const dep of importsOf(src)) {
      assert.ok(!/firebase/i.test(dep), `${file} が Firebase を読み込んでいる`);
      assert.ok(dep.startsWith('./') || dep.startsWith('../utils/'), `${file} が game/ と utils/ 以外（${dep}）に依存している`);
    }
  }
});

test('gameEngine はモジュール内の共有状態（let / var）と Date.now() を持たない', () => {
  const src = read('gameEngine.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/^(let|var) /m.test(src), 'モジュール直下に変更可能な変数がある');
  assert.ok(!src.includes('Date.now'), 'Date.now を呼んでいる');
});

test('gameState.js は Firebase を直接持たず、ストア・gameEngine・visibility だけに依存する', () => {
  const deps = importsOf(read('gameState.js'));
  assert.deepEqual(deps.sort(), ['../core/store.js', './gameEngine.js', './gameEngine.js', './visibility.js'].sort());
});

test('画面（screens/）はゲームの状態を直接読まず、gameService だけを使う', () => {
  const dir = new URL('../oni-game/js/screens/', import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    assert.ok(!src.includes('gameState.js'), `${file} が gameState.js を読み込んでいる`);
    assert.ok(!src.includes('gameStore'), `${file} が gameStore を使っている`);
    assert.ok(!/firebase/i.test(src.replace(/\/\/.*$/gm, '')), `${file} が Firebase を使っている`);
    assert.ok(!src.includes('roomService'), `${file} が roomService を直接使っている`);
  }
});
