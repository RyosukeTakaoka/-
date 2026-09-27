import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayerView, DISPLAY } from '../oni-game/js/game/visibility.js';
import { ROLE, STATUS } from '../oni-game/js/game/player.js';
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import { playingState, CENTER } from './helpers.js';

const setup = () =>
  playingState([
    { id: 'h', role: ROLE.HUNTER, at: 0 },
    { id: 'h2', role: ROLE.HUNTER, at: 50 },
    { id: 'r', role: ROLE.RUNNER, at: 120 },
    { id: 'r2', role: ROLE.RUNNER, at: 200 },
  ]);

const findOther = (view, id) => view.others.find((p) => p.id === id);

test('鬼のビューには逃走者の実座標がどこにも含まれない', () => {
  const s = setup();
  // 逃走者を鬼と別の方向に置く（経度が鬼と同じだと検査にならないため）
  s.positions.r = { ...destinationPoint(CENTER, 120, 60), accuracyM: 5, updatedAt: 0 };
  s.positions.r2 = { ...destinationPoint(CENTER, 200, 200), accuracyM: 5, updatedAt: 0 };
  const view = buildPlayerView(s, 'h', 0);
  const json = JSON.stringify(view);
  for (const id of ['r', 'r2']) {
    assert.equal(findOther(view, id).display.kind, DISPLAY.HIDDEN);
    assert.ok(!json.includes(String(s.positions[id].lat)), `${id} の緯度が漏れている`);
    assert.ok(!json.includes(String(s.positions[id].lng)), `${id} の経度が漏れている`);
  }
  // 鬼同士・自分は見える
  assert.equal(findOther(view, 'h2').display.kind, DISPLAY.EXACT);
  assert.ok(view.self.position);
});

test('逃走者には鬼と仲間の位置が見える', () => {
  const view = buildPlayerView(setup(), 'r', 0);
  assert.equal(findOther(view, 'h').display.kind, DISPLAY.EXACT);
  assert.equal(findOther(view, 'r2').display.kind, DISPLAY.EXACT);
});

test('脱落者には逃走者の位置が見えない（鬼に教えられないように）', () => {
  const s = setup();
  s.players = s.players.map((p) => (p.id === 'r' ? { ...p, status: STATUS.CAUGHT } : p));
  const view = buildPlayerView(s, 'r', 0);
  assert.equal(findOther(view, 'r2').display.kind, DISPLAY.HIDDEN);
  assert.ok(!JSON.stringify(view).includes(String(s.positions.r2.lat)));
});

test('ビューにミッション履歴や内部状態(positions)は含まれない', () => {
  const view = buildPlayerView(setup(), 'h', 0);
  assert.equal(view.positions, undefined);
  assert.equal(findOther(view, 'r').missionHistory, undefined);
  assert.equal(findOther(view, 'r').blurM, undefined);
});

test('エリア外判定は自分のビューに入る', () => {
  const s = setup();
  s.positions.r2 = { ...s.positions.r2, lat: s.positions.r2.lat + 0.01 }; // 約1.1km北
  assert.equal(buildPlayerView(s, 'r2', 0).self.outOfArea, true);
  assert.equal(buildPlayerView(s, 'r', 0).self.outOfArea, false);
});

test('ゲーム外では誰の位置も表示しない', () => {
  const view = buildPlayerView({ ...setup(), phase: 'finished' }, 'r', 0);
  assert.ok(view.others.every((p) => p.display.kind === DISPLAY.HIDDEN));
  assert.equal(view.self.position, null);
});
