// STEP 7-A2: 公開範囲ごとのチャンネル（viewChannels.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { distanceM, destinationPoint } from '../oni-game/js/utils/distance.js';
import { buildPlayerView } from '../oni-game/js/game/visibility.js';
import { buildChannels, readableChannels, assembleView } from '../oni-game/js/game/viewChannels.js';
import {
  gameStore, updatePosition, tickGame, requestCapture, abortGame, setMissionRandom, enterLobby, resetGame,
  updateSettings, setStartPoint,
} from '../oni-game/js/game/gameState.js';
import { createPlayer, ROLE } from '../oni-game/js/game/player.js';
import { CENTER, startStoreGame } from './helpers.js';

setMissionRandom(createSeededRng(51));
const at = (m, bearing) => destinationPoint(CENTER, m, bearing);

/** その時点の状態で、全員分「チャンネルから組み立てたビュー = 基準のビュー」を確認する */
function assertEquivalent(label, now) {
  const s = gameStore.getState();
  const channels = buildChannels(s);
  for (const p of s.players) {
    const parts = readableChannels(channels, p.id);
    const assembled = assembleView(parts, p.id, { now, ownPosition: s.positions[p.id] ?? null });
    assert.deepStrictEqual(assembled, buildPlayerView(s, p.id, now), `${label}: ${p.id} のビューが一致しない`);
  }
  return { s, channels };
}

/** 5人（鬼2・逃走者3）のゲーム */
function setup(settings = {}) {
  const s = startStoreGame({
    ids: ['host', 'p1', 'p2', 'p3', 'p4'],
    settings: { durationMin: 10, hunterCount: 2, captureRadiusM: 10, revealIntervalSec: 30, ...settings },
  });
  const hunters = s.players.filter((p) => p.role === ROLE.HUNTER).map((p) => p.id);
  const runners = s.players.filter((p) => p.role === ROLE.RUNNER).map((p) => p.id);
  hunters.forEach((id, i) => updatePosition(id, at(150 + i * 20, 200 + i * 30), 1));
  runners.forEach((id, i) => updatePosition(id, at(40 + i * 50, 20 + i * 70), 1));
  return { hunters, runners };
}

function capture(hunter, runner, now) {
  updatePosition(hunter, gameStore.getState().positions[runner], now - 1);
  return requestCapture(hunter, now);
}

test('ロビー中: 全員のビューが一致する', () => {
  resetGame();
  setStartPoint(CENTER);
  enterLobby({
    room: { code: 'ABCDEF', hostId: 'a' },
    selfId: 'a',
    players: ['a', 'b', 'c'].map((id, i) => createPlayer({ id, name: id, isHost: i === 0 })),
  });
  assertEquivalent('ロビー', 0);
});

test('ゲームの流れ全体で、全員のビューが一致する（公開・ミッション・確保・脱落・終了）', () => {
  const { hunters, runners } = setup();
  assertEquivalent('開始直後', 1);
  const { schedule } = gameStore.getState().missions;
  tickGame(schedule[0].startsAt);
  assertEquivalent('ミッション中', schedule[0].startsAt);
  updatePosition(runners[0], gameStore.getState().missions.active.participants[runners[0]].destination, schedule[0].startsAt + 500);
  assertEquivalent('到達後', schedule[0].startsAt + 500);
  capture(hunters[0], runners[1], schedule[0].startsAt + 1000);
  assertEquivalent('脱落者あり', schedule[0].startsAt + 1000);
  tickGame(schedule[0].startsAt + schedule[0].limitMs);
  assertEquivalent('ミッション終了後', schedule[0].startsAt + schedule[0].limitMs);
  tickGame(schedule[0].startsAt + schedule[0].limitMs + 30_000);
  assertEquivalent('次の公開後', schedule[0].startsAt + schedule[0].limitMs + 30_000);
  abortGame(schedule[1].startsAt);
  assertEquivalent('終了後', schedule[1].startsAt);
});

test('増え鬼・鬼の位置を見せない設定でも一致する', () => {
  const { hunters, runners } = setup({ zombieMode: true, showHuntersToRunners: false });
  capture(hunters[0], runners[0], 5000);
  assertEquivalent('鬼になった直後', 5000);
  tickGame(30_000);
  assertEquivalent('公開後', 30_000);
});

test('鬼・脱落者が読めるチャンネルに、逃走者の実位置は入っていない', () => {
  const { hunters, runners } = setup();
  tickGame(30_000);
  capture(hunters[0], runners[0], 31_000); // runners[0] は脱落
  const s = gameStore.getState();
  const channels = buildChannels(s);
  const secretPositions = runners.slice(1).map((id) => s.positions[id]);

  for (const viewer of [hunters[0], hunters[1], runners[0]]) {
    const parts = readableChannels(channels, viewer);
    assert.equal(parts.runnerPositions, null, `${viewer} が逃走者の位置チャンネルを読めてしまう`);
    const json = JSON.stringify(parts);
    for (const pos of secretPositions) {
      assert.ok(!json.includes(String(pos.lat)) && !json.includes(String(pos.lng)), `${viewer} に逃走者の実位置が渡る`);
    }
  }
  // 脱落者は可能性エリアも読めない
  assert.equal(readableChannels(channels, runners[0]).possibleAreas, null);
  // 逃走者は可能性エリアを読めない（自分の円は自分の view にだけある）
  assert.equal(readableChannels(channels, runners[1]).possibleAreas, null);
  assert.ok(readableChannels(channels, runners[1]).view.possibleArea);
});

test('どのチャンネルにも秘密値・ミッション予定・他人の目的地・位置の精度や時刻が入らない', () => {
  const { runners } = setup();
  const { schedule } = gameStore.getState().missions;
  tickGame(schedule[0].startsAt);
  const s = gameStore.getState();
  const channels = buildChannels(s);
  const json = JSON.stringify(channels.public) + JSON.stringify(channels.hunterPositions)
    + JSON.stringify(channels.runnerPositions) + JSON.stringify(channels.possibleAreas);
  for (const key of ['secrets', 'seed', 'gridAngle', 'cells', 'schedule', 'destination', 'accuracyM', 'updatedAt', 'positions', 'privacy']) {
    assert.ok(!json.includes(`"${key}"`), `共有チャンネルに ${key} がある`);
  }
  // まだ発生していないミッションの予定時刻（発生済みのミッションの開始時刻は公開情報）
  const future = s.missions.schedule.slice(s.missions.nextIndex);
  assert.equal(future.length, 3);
  for (const m of future) assert.ok(!json.includes(String(m.startsAt)), 'ミッション予定時刻が漏れる');
  // 目的地は本人の view にだけある
  const [a, b] = runners;
  const destA = s.missions.active.participants[a].destination;
  assert.ok(distanceM(channels.views[a].mission.destination, destA) < 0.01);
  assert.ok(!JSON.stringify(channels.views[b]).includes(String(destA.lat)));
  // 鬼・仲間の位置は緯度経度だけ
  for (const pos of Object.values(channels.runnerPositions)) assert.deepEqual(Object.keys(pos).sort(), ['lat', 'lng']);
});

test('部屋のメンバーでなければ何も読めない', () => {
  setup();
  assert.equal(readableChannels(buildChannels(gameStore.getState()), 'outsider'), null);
});

test('設定変更はロビーの public にだけ反映される（位置の情報は無い）', () => {
  resetGame();
  updateSettings({ durationMin: 20 });
  setStartPoint(CENTER);
  const channels = buildChannels(gameStore.getState());
  assert.equal(channels.public.settings.durationMin, 20);
  assert.deepEqual(channels.hunterPositions, {});
  assert.deepEqual(channels.runnerPositions, {});
  assert.deepEqual(channels.possibleAreas, {});
});
