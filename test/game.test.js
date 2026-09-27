'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError, distanceM, sanitizeSettings } = require('../src/game');

const BASE = { lat: 35.681, lng: 139.767 };
// 緯度方向に約 m メートル離れた地点
const north = (m) => ({ lat: BASE.lat + m / 111320, lng: BASE.lng });

function setup(n = 3, settings = {}) {
  const game = new Game('1234', 'p0');
  for (let i = 0; i < n; i++) game.addPlayer(`p${i}`, `player${i}`);
  game.updateSettings('p0', settings);
  for (let i = 0; i < n; i++) game.updatePosition(`p${i}`, { ...north(i * 100), acc: 0 }, 0);
  // rng=0.99 だとシャッフル後の先頭が p0 になる → p0 が鬼
  game.start('p0', 0, () => 0.99);
  return game;
}

test('distanceM はおおよそ正しい距離を返す', () => {
  assert.ok(Math.abs(distanceM(BASE, north(100)) - 100) < 1);
});

test('設定値は範囲内に丸められる', () => {
  const s = sanitizeSettings({ durationMin: 9999, catchRadiusM: -5, mode: 'bad' });
  assert.equal(s.durationMin, 180);
  assert.equal(s.catchRadiusM, 3);
  assert.equal(s.mode, 'classic');
});

test('開始時に役割が割り当てられ、中心はホストの位置になる', () => {
  const game = setup(3);
  assert.equal(game.phase, 'playing');
  assert.equal(game.players.get('p0').role, 'hunter');
  assert.equal(game.runners().length, 2);
  assert.deepEqual(game.center, { lat: north(0).lat, lng: north(0).lng });
});

test('1人では開始できない・ホスト以外は開始できない', () => {
  const game = new Game('1', 'a');
  game.addPlayer('a', 'A');
  assert.throws(() => game.start('a'), GameError);
  game.addPlayer('b', 'B');
  assert.throws(() => game.start('b'), GameError);
});

test('ゲーム中は新規参加できないが再接続はできる', () => {
  const game = setup(2);
  assert.throws(() => game.addPlayer('new', 'X'), GameError);
  game.setConnected('p1', false);
  game.addPlayer('p1', 'player1');
  assert.equal(game.players.get('p1').connected, true);
});

test('遠すぎると確保できず、近ければ確保できる', () => {
  const game = setup(3, { catchRadiusM: 15 });
  assert.throws(() => game.tryCatch('p0', 'p1', 1000), /遠すぎます/);
  game.updatePosition('p0', { ...north(95), acc: 0 }, 1000);
  game.tryCatch('p0', 'p1', 1000);
  assert.equal(game.players.get('p1').status, 'caught');
  assert.equal(game.players.get('p0').catches, 1);
  assert.equal(game.phase, 'playing');
});

test('catchNearest は範囲内の一番近い逃走者を確保する', () => {
  const game = setup(3, { catchRadiusM: 15 });
  assert.throws(() => game.catchNearest('p0', 1000), /近くに逃走者がいません/);
  game.updatePosition('p0', { ...north(195), acc: 0 }, 1000);
  const caught = game.catchNearest('p0', 1000);
  assert.equal(caught.id, 'p2');
});

test('逃走者は鬼を捕まえられない', () => {
  const game = setup(3);
  assert.throws(() => game.tryCatch('p1', 'p0'), GameError);
});

test('全員確保で鬼の勝ち', () => {
  const game = setup(3);
  game.surrender('p1', 1000);
  game.surrender('p2', 2000);
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 'hunters');
});

test('時間切れで逃走者の勝ち', () => {
  const game = setup(3, { durationMin: 1 });
  assert.deepEqual(game.tick(59_000), []);
  assert.deepEqual(game.tick(60_000), ['ended']);
  assert.equal(game.winner, 'runners');
});

test('増え鬼モードでは捕まった人が鬼になる', () => {
  const game = setup(3, { mode: 'zombie' });
  game.surrender('p1', 1000);
  const p1 = game.players.get('p1');
  assert.equal(p1.role, 'hunter');
  assert.equal(p1.status, 'alive');
  assert.equal(game.aliveRunners().length, 1);
});

test('位置公開は間隔ごとに行われ、鬼にだけ見える', () => {
  const game = setup(3, { revealIntervalSec: 30 });
  game.updatePosition('p1', { ...north(500), acc: 0 }, 10_000);
  assert.deepEqual(game.tick(10_000), []);
  // 公開前は開始時の位置
  assert.equal(game.viewFor('p0', 10_000).revealed.find((r) => r.id === 'p1').lat, north(100).lat);
  assert.deepEqual(game.tick(30_000), ['reveal']);
  assert.equal(game.viewFor('p0', 30_000).revealed.find((r) => r.id === 'p1').lat, north(500).lat);
  // 逃走者には公開情報は渡らない
  assert.deepEqual(game.viewFor('p1', 30_000).revealed, []);
});

test('鬼には逃走者のリアルタイム位置が見えない', () => {
  const game = setup(3);
  const view = game.viewFor('p0', 1000);
  assert.equal(view.players.find((p) => p.id === 'p1').pos, null);
  // 逃走者同士は見える、鬼の位置も（設定がONなら）見える
  const runnerView = game.viewFor('p1', 1000);
  assert.ok(runnerView.players.find((p) => p.id === 'p2').pos);
  assert.ok(runnerView.players.find((p) => p.id === 'p0').pos);
});

test('showHuntersToRunners=false なら逃走者に鬼の位置は見えない', () => {
  const game = setup(3, { showHuntersToRunners: false });
  assert.equal(game.viewFor('p1', 1000).players.find((p) => p.id === 'p0').pos, null);
});

test('エリア外判定', () => {
  const game = setup(3, { areaRadiusM: 150 });
  const view = game.viewFor('p0', 0);
  assert.equal(view.players.find((p) => p.id === 'p1').outOfArea, false);
  assert.equal(view.players.find((p) => p.id === 'p2').outOfArea, true);
});

test('ロビーに戻ると役割がリセットされる', () => {
  const game = setup(3);
  game.backToLobby('p0');
  assert.equal(game.phase, 'lobby');
  for (const p of game.players.values()) assert.equal(p.role, null);
});
