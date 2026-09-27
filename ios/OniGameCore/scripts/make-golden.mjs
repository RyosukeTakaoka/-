// JS 版（oni-game/js/game）でゲームを最後まで進め、各ステップの状態を記録する（Swift 版との一致テスト用）。
//
//   node ios/OniGameCore/scripts/make-golden.mjs
//
// 出力: ios/OniGameCore/Tests/OniGameCoreTests/Fixtures/golden.json
// Swift のテスト（GoldenTests.swift）は、同じ設定・同じシードの乱数・同じ操作を Swift 版のエンジンで行い、
// 各ステップの状態・ログ・操作の結果・チャンネル・ビューが JS 版と一致することを確かめる。
// 操作（移動先の座標など）はここで決めて記録するので、Swift 側は記録どおりに操作するだけでよい。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as engine from '../../../oni-game/js/game/gameEngine.js';
import { createPlayer } from '../../../oni-game/js/game/player.js';
import { buildChannels, readableChannels, assembleView } from '../../../oni-game/js/game/viewChannels.js';
import { createSeededRng } from '../../../oni-game/js/utils/random.js';
import { destinationPoint, bearingDeg, distanceM } from '../../../oni-game/js/utils/distance.js';

const START = { lat: 35.6586, lng: 139.7454 };
const T0 = 1_800_000_000_000;

const SCENARIOS = [
  {
    name: 'basic',
    seed: 11,
    players: ['p1', 'p2', 'p3', 'p4'],
    settings: { durationMin: 5, radiusM: 300, initialBlurM: 300, hunterCount: 1, captureRadiusM: 10, zombieMode: false, revealIntervalSec: 30, showHuntersToRunners: true },
    exclusion: [{ distance: 120, bearing: 45 }],
    tickMs: 10_000,
    abortAtMs: null,
    hunterSpeed: 4.5,
  },
  {
    name: 'zombie',
    seed: 29,
    players: ['p1', 'p2', 'p3', 'p4', 'p5'],
    settings: { durationMin: 10, radiusM: 500, initialBlurM: 100, hunterCount: 1, captureRadiusM: 20, zombieMode: true, revealIntervalSec: 60, showHuntersToRunners: false },
    exclusion: [],
    tickMs: 15_000,
    abortAtMs: null,
    hunterSpeed: 2.2,
  },
  {
    name: 'aborted',
    seed: 5,
    players: ['p1', 'p2', 'p3'],
    settings: { durationMin: 20, radiusM: 1000, initialBlurM: 500, hunterCount: 2, captureRadiusM: 5, zombieMode: false, revealIntervalSec: 120, showHuntersToRunners: true },
    exclusion: [{ distance: 300, bearing: 180 }, { distance: 50, bearing: 270 }],
    tickMs: 20_000,
    abortAtMs: 9 * 60_000,
    hunterSpeed: 2.2,
  },
];

function run(sc) {
  const rng = {
    roles: createSeededRng(sc.seed),
    privacy: createSeededRng(sc.seed + 1),
    schedule: createSeededRng(sc.seed + 2),
    destinations: createSeededRng(sc.seed + 3),
  };
  const move = createSeededRng(sc.seed + 100); // 操作を決めるための乱数（記録するので Swift 側では使わない）
  const ctx = (now) => ({ now, rng, newId: () => `game-${sc.name}` });

  let state = engine.initialState();
  state = engine.updateSettings(state, sc.settings);
  state = engine.setStartPoint(state, START);
  for (const z of sc.exclusion) state = engine.addExclusionZone(state, destinationPoint(START, z.distance, z.bearing));
  state = engine.enterLobby(state, {
    room: { code: '1234', hostId: sc.players[0] },
    selfId: sc.players[0],
    players: sc.players.map((id, i) => createPlayer({ id, name: `プレイヤー${i + 1}`, isHost: i === 0 })),
  });
  const lobby = state;

  const initialPositions = Object.fromEntries(sc.players.map((id, i) => [id, destinationPoint(START, 40 + 30 * i, i * 83)]));
  const steps = [];
  const record = (action, out) => {
    const before = state;
    state = out.state;
    // チャンネルとビューは大きいので、状態が大きく変わるステップ（役割・ミッション・公開・終了）と一定間隔でだけ記録する
    const important = out.events.length > 0 || out.result?.capturedId || before.phase !== state.phase
      || steps.length % 15 === 0;
    if (!important) {
      // ログは大きいので、重要でないステップでは省く（Swift 側はログ以外を比べる）
      const { log: _log, ...rest } = state;
      steps.push({ action, state: rest, events: out.events, result: out.result ?? null, nextDueAt: engine.nextDueAt(state) });
      return;
    }
    const channels = buildChannels(state);
    const views = {};
    for (const p of state.players) {
      const own = state.phase === 'playing' ? state.positions[p.id] ?? null : null;
      views[p.id] = assembleView(readableChannels(channels, p.id), p.id, { now: action.now, ownPosition: own });
    }
    steps.push({ action, state, events: out.events, result: out.result ?? null, channels, views, nextDueAt: engine.nextDueAt(state) });
  };

  record({ type: 'start', now: T0, initialPositions }, engine.startGame(state, { initialPositions }, ctx(T0)));

  for (let now = T0 + sc.tickMs; state.phase === 'playing'; now += sc.tickMs) {
    if (sc.abortAtMs != null && now - T0 >= sc.abortAtMs) {
      record({ type: 'abort', now }, engine.abort(state, ctx(now)));
      break;
    }
    record({ type: 'advance', now }, engine.advance(state, ctx(now)));
    if (state.phase !== 'playing') break;

    for (const p of state.players) {
      if (p.status !== 'active' || !state.positions[p.id]) continue;
      const pos = state.positions[p.id];
      let heading;
      let speed;
      if (p.role === 'hunter') {
        // 鬼は（記録用に）一番近い逃走者の実位置へ向かう
        const targets = state.players.filter((r) => r.role === 'runner' && r.status === 'active' && state.positions[r.id]);
        targets.sort((a, b) => distanceM(pos, state.positions[a.id]) - distanceM(pos, state.positions[b.id]));
        heading = targets[0] ? bearingDeg(pos, state.positions[targets[0].id]) : move() * 360;
        speed = sc.hunterSpeed;
      } else {
        const dest = state.missions.active?.participants[p.id]?.destination;
        const pending = state.missions.active?.participants[p.id]?.result === 'pending';
        heading = dest && pending && move() < 0.8 ? bearingDeg(pos, dest) : move() * 360;
        speed = 2.5;
        if (dest && pending && move() < 0.15) {
          record({ type: 'changeDestination', runnerId: p.id, now: now + 1 }, engine.changeDestination(state, { runnerId: p.id }, ctx(now + 1)));
        }
      }
      if (distanceM(START, pos) > state.area.radiusM * 0.9) heading = bearingDeg(pos, START);
      const next = destinationPoint(pos, (speed * sc.tickMs) / 1000, heading);
      const accuracyM = Math.round(move() * 20);
      record({ type: 'updatePosition', playerId: p.id, pos: { ...next, accuracyM }, now: now + 2 },
        engine.updatePosition(state, { playerId: p.id, pos: { ...next, accuracyM } }, ctx(now + 2)));
      if (state.phase !== 'playing') break;
    }
    for (const p of state.players) {
      if (state.phase !== 'playing') break;
      if (p.role === 'hunter' && p.status === 'active') {
        record({ type: 'requestCapture', hunterId: p.id, now: now + 3 }, engine.requestCapture(state, { hunterId: p.id }, ctx(now + 3)));
      }
      if (p.role === 'runner' && p.status === 'active' && state.missions.active) {
        record({ type: 'claimArrival', runnerId: p.id, now: now + 4 }, engine.claimArrival(state, { runnerId: p.id }, ctx(now + 4)));
      }
    }
  }
  return { name: sc.name, seed: sc.seed, start: START, t0: T0, settings: sc.settings, players: sc.players,
    exclusion: sc.exclusion.map((z) => destinationPoint(START, z.distance, z.bearing)), lobby, steps };
}

const scenarios = SCENARIOS.map(run);
const out = fileURLToPath(new URL('../Tests/OniGameCoreTests/Fixtures/golden.json', import.meta.url));
writeFileSync(out, JSON.stringify({ generatedBy: 'ios/OniGameCore/scripts/make-golden.mjs', scenarios }));
for (const s of scenarios) {
  const last = s.steps.at(-1).state;
  const captures = s.steps.filter((x) => x.result?.capturedId).length;
  const missions = last.missions.history.length;
  console.log(`${s.name}: ${s.steps.length} steps / ${last.result?.reason} / 確保 ${captures} / ミッション ${missions}`);
}
