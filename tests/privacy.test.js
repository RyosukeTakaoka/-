// STEP 3: 位置情報のプライバシー処理のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceM, destinationPoint, toLocalXY } from '../oni-game/js/utils/distance.js';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import {
  computePossibleArea, createPrivacySecret, cellCenterOf, MIN_OFFSET_RATIO,
} from '../oni-game/js/map/privacyArea.js';
import { publishIfDue, revealEpoch, nextRevealAt } from '../oni-game/js/game/locationPublisher.js';
import { buildPlayerView, DISPLAY } from '../oni-game/js/game/visibility.js';
import {
  gameStore, updatePosition, tickGame, requestCapture, getPlayerView, abortGame,
} from '../oni-game/js/game/gameState.js';
import { ROLE, STATUS } from '../oni-game/js/game/player.js';
import { BLUR_OPTIONS_M } from '../oni-game/js/game/settings.js';
import { CENTER, north, publishedState, startStoreGame } from './helpers.js';

const H = ROLE.HUNTER;
const R = ROLE.RUNNER;

/** ビューの中にある {lat, lng} をすべて集める */
function collectLatLngs(value, out = []) {
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.lat) && Number.isFinite(value.lng)) out.push(value);
    for (const v of Object.values(value)) collectLatLngs(v, out);
  }
  return out;
}

/** ビューから実位置（またはそれとほぼ同じ点）を取り出せないこと */
function assertNoRealPosition(view, realPositions, label) {
  const json = JSON.stringify(view);
  for (const [id, pos] of Object.entries(realPositions)) {
    assert.ok(!json.includes(String(pos.lat)), `${label}: ${id} の緯度がそのまま含まれている`);
    assert.ok(!json.includes(String(pos.lng)), `${label}: ${id} の経度がそのまま含まれている`);
    for (const p of collectLatLngs(view)) {
      assert.ok(distanceM(p, pos) > 1, `${label}: ${id} の実位置とほぼ同じ座標が含まれている`);
    }
  }
}

// ---- privacyArea.js ----

test('実位置は必ず可能性エリアの内側にあり、中心とは一致しない', () => {
  const rng = createSeededRng(123);
  for (let i = 0; i < 3000; i++) {
    const blurM = BLUR_OPTIONS_M[i % BLUR_OPTIONS_M.length];
    const position = destinationPoint(CENTER, rng() * 3000, rng() * 360);
    const secret = createPrivacySecret(rng);
    const { center, radiusM } = computePossibleArea({ position, blurM, secret, epoch: i % 50, origin: CENTER });
    const d = distanceM(position, center);
    assert.ok(d < radiusM, `実位置が円の外 (d=${d}, R=${radiusM})`);
    assert.ok(d >= MIN_OFFSET_RATIO * radiusM * 0.99, `中心が実位置に近すぎる (d=${d}, R=${radiusM})`);
  }
});

test('円の大きさは blurM で決まる（大きいほど大きく、小さいほど小さい）', () => {
  const secret = createPrivacySecret(createSeededRng(1));
  const radii = BLUR_OPTIONS_M.map(
    (blurM) => computePossibleArea({ position: north(100), blurM, secret, epoch: 0, origin: CENTER }).radiusM,
  );
  assert.deepEqual(radii, BLUR_OPTIONS_M);
  for (let i = 1; i < radii.length; i++) assert.ok(radii[i] > radii[i - 1]);
});

test('同じ入力なら同じ円（公開回数が変わると中心が変わる）', () => {
  const secret = createPrivacySecret(createSeededRng(2));
  const args = { position: north(50), blurM: 300, secret, origin: CENTER };
  const a = computePossibleArea({ ...args, epoch: 3 });
  const b = computePossibleArea({ ...args, epoch: 3 });
  const c = computePossibleArea({ ...args, epoch: 4 });
  assert.deepEqual(a.center, b.center);
  assert.ok(distanceM(a.center, c.center) > 0.01);
});

test('境界付近では前回のマスを使い続ける（行ったり来たりで円が切り替わらない）', () => {
  const secret = createPrivacySecret(createSeededRng(3));
  const R = 300;
  const first = computePossibleArea({ position: north(0), blurM: R, secret, epoch: 0, origin: CENTER });
  const q = cellCenterOf(first.cell, secret, CENTER);
  // マス中心から KEEP_CELL_RATIO×R 以内 → 同じマスを使い続ける
  const near = destinationPoint(q, 0.62 * R, 10);
  const kept = computePossibleArea({ position: near, blurM: R, secret, epoch: 1, origin: CENTER, previousCell: first.cell });
  assert.deepEqual(kept.cell, first.cell);
  assert.ok(distanceM(near, kept.center) < R);
  // それより遠く（マスの対角の半分 0.64R も超える）なら新しいマス
  const far = destinationPoint(q, 0.75 * R, 10);
  const moved = computePossibleArea({ position: far, blurM: R, secret, epoch: 2, origin: CENTER, previousCell: first.cell });
  assert.notDeepEqual(moved.cell, first.cell);
  assert.ok(distanceM(far, moved.center) < R);
});

// ---- 軌跡からの推測 ----

test('止まっている逃走者の円を何回分平均しても、平均位置が実位置付近に収束しない（平均攻撃の検証）', () => {
  const rng = createSeededRng(55);
  const R = 300;
  const EPOCHS = 200;
  let ourError = 0;
  let naiveError = 0;
  const TRIALS = 100;
  for (let t = 0; t < TRIALS; t++) {
    const position = destinationPoint(CENTER, rng() * 2000, rng() * 360);
    const secret = createPrivacySecret(rng);
    let cell = null;
    let sx = 0; let sy = 0; let nx = 0; let ny = 0;
    for (let e = 0; e < EPOCHS; e++) {
      const area = computePossibleArea({ position, blurM: R, secret, epoch: e, origin: CENTER, previousCell: cell });
      cell = area.cell;
      const c = toLocalXY(position, area.center);
      sx += c.x; sy += c.y;
      // 比較用: 毎回独立にランダムにずらすだけの単純な方式
      const d = R * 0.9 * Math.sqrt(rng()); const a = rng() * 2 * Math.PI;
      nx += d * Math.cos(a); ny += d * Math.sin(a);
    }
    ourError += Math.hypot(sx / EPOCHS, sy / EPOCHS);
    naiveError += Math.hypot(nx / EPOCHS, ny / EPOCHS);
  }
  ourError /= TRIALS;
  naiveError /= TRIALS;
  // 単純な方式だと平均がほぼ実位置に収束する（R の数%）が、この方式ではマスの大きさ程度の誤差が残る
  assert.ok(naiveError < 0.05 * R, `比較用の単純方式の誤差 ${naiveError.toFixed(1)}m`);
  assert.ok(ourError > 0.3 * R, `平均した中心の誤差が小さすぎる ${ourError.toFixed(1)}m（単純方式 ${naiveError.toFixed(1)}m）`);
});

test('少しずつ動いても、円の中心の動きは移動方向に追従しない', () => {
  const rng = createSeededRng(77);
  const R = 300;
  let cosSum = 0;
  let samples = 0;
  let centerMoves = 0;
  for (let t = 0; t < 300; t++) {
    const secret = createPrivacySecret(rng);
    const heading = rng() * 360;
    let position = destinationPoint(CENTER, rng() * 1000, rng() * 360);
    let prev = computePossibleArea({ position, blurM: R, secret, epoch: 0, origin: CENTER });
    for (let e = 1; e <= 5; e++) {
      const next = destinationPoint(position, 10, heading); // 1回の公開間隔で10m移動
      const area = computePossibleArea({ position: next, blurM: R, secret, epoch: e, origin: CENTER, previousCell: prev.cell });
      const move = toLocalXY(position, next);
      const shift = toLocalXY(prev.center, area.center);
      const len = Math.hypot(shift.x, shift.y);
      if (len > 0) {
        cosSum += (move.x * shift.x + move.y * shift.y) / (Math.hypot(move.x, move.y) * len);
        samples += 1;
        centerMoves += len;
      }
      position = next;
      prev = area;
    }
  }
  const meanCos = cosSum / samples;
  // 追従していれば平均コサインは 1 に近くなる。無関係なら 0 付近
  assert.ok(Math.abs(meanCos) < 0.15, `中心の動きが移動方向と相関している (平均cos=${meanCos.toFixed(3)})`);
  // 中心は 10m の移動よりずっと大きく動く（毎回大きく変わる）
  assert.ok(centerMoves / samples > 50, `中心の変化が小さい (${(centerMoves / samples).toFixed(1)}m)`);
});

// ---- 公開スケジュール ----

test('公開回数と次の公開時刻', () => {
  const settings = { revealIntervalSec: 30 };
  assert.equal(revealEpoch(0, 0, settings), 0);
  assert.equal(revealEpoch(29_999, 0, settings), 0);
  assert.equal(revealEpoch(30_000, 0, settings), 1);
  assert.equal(nextRevealAt(45_000, 0, settings), 60_000);
});

test('公開間隔中は GPS が更新されても可能性エリアは変わらず、次の公開タイミングで更新される', () => {
  const s0 = startStoreGame({ settings: { revealIntervalSec: 30 }, positions: { host: north(0), r1: north(100), r2: north(200) } });
  const hunter = s0.players.find((p) => p.role === H).id;
  const runner = s0.players.find((p) => p.role === R).id;
  const areaOf = (now) => getPlayerView(hunter, now).others.find((p) => p.id === runner).display;

  const first = areaOf(0);
  assert.equal(first.kind, DISPLAY.AREA);
  updatePosition(runner, north(180), 10_000);
  tickGame(10_000);
  updatePosition(runner, north(260), 29_000);
  tickGame(29_999);
  assert.deepEqual(areaOf(29_999), first, '公開間隔中に円が変わった');

  tickGame(30_000);
  const second = areaOf(30_000);
  assert.notDeepEqual(second.center, first.center, '公開タイミングで更新されていない');
  const real = gameStore.getState().positions[runner];
  assert.ok(distanceM(real, second.center) < second.radiusM, '新しい円に実位置が入っていない');
  assert.equal(gameStore.getState().log.at(-1).type, 'reveal');
});

test('blurM が変わると次の公開で円の大きさが変わる（STEP 5 の準備）', () => {
  const s = publishedState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 100 }], { initialBlurM: 300 });
  assert.equal(s.privacy.published.r.radiusM, 300);
  const changed = { ...s, players: s.players.map((p) => (p.id === 'r' ? { ...p, blurM: 500 } : p)) };
  assert.equal(publishIfDue(changed, 59_999).revealed, false);
  const { privacy } = publishIfDue(changed, 60_000);
  assert.equal(privacy.published.r.radiusM, 500);
});

// ---- 誰に何が渡るか ----

test('鬼のビューには可能性エリアだけが入り、実位置は取り出せない', () => {
  const s = publishedState([
    { id: 'h', role: H, at: 0 },
    { id: 'r', role: R, at: 120 },
    { id: 'r2', role: R, at: 260 },
  ]);
  const view = buildPlayerView(s, 'h', 0);
  for (const id of ['r', 'r2']) {
    const d = view.others.find((p) => p.id === id).display;
    assert.deepEqual(Object.keys(d).sort(), ['center', 'kind', 'playerId', 'publishedAt', 'radiusM', 'type']);
    assert.equal(d.type, 'possibleArea');
    assert.ok(distanceM(d.center, s.positions[id]) < d.radiusM);
  }
  assertNoRealPosition(view, { r: s.positions.r, r2: s.positions.r2 }, '鬼');
  for (const key of ['positions', 'privacy', 'secrets', 'cells']) assert.ok(!JSON.stringify(view).includes(`"${key}"`));
});

test('鬼が複数でも、全員が同じ可能性エリアだけを受け取る', () => {
  const s = publishedState([
    { id: 'h1', role: H, at: 0 },
    { id: 'h2', role: H, at: 40 },
    { id: 'h3', role: H, at: 80 },
    { id: 'r', role: R, at: 150 },
  ]);
  const views = ['h1', 'h2', 'h3'].map((id) => buildPlayerView(s, id, 0));
  const areas = views.map((v) => v.others.find((p) => p.id === 'r').display);
  assert.deepEqual(areas[1], areas[0]);
  assert.deepEqual(areas[2], areas[0]);
  for (const v of views) {
    assertNoRealPosition(v, { r: s.positions.r }, '鬼');
    assert.equal(v.others.filter((p) => p.role === H).every((p) => p.display.kind === DISPLAY.EXACT), true, '鬼同士は見える');
  }
});

test('脱落者には逃走者の実位置も可能性エリアも渡さない', () => {
  const s = publishedState([{ id: 'h', role: H, at: 0 }, { id: 'out', role: R, at: 50 }, { id: 'r', role: R, at: 150 }]);
  s.players = s.players.map((p) => (p.id === 'out' ? { ...p, status: STATUS.CAUGHT } : p));
  const view = buildPlayerView(s, 'out', 0);
  assert.equal(view.others.find((p) => p.id === 'r').display.kind, DISPLAY.HIDDEN);
  assertNoRealPosition(view, { r: s.positions.r }, '脱落者');
  assert.ok(!JSON.stringify(view).includes(String(s.privacy.published.r.center.lat)), '可能性エリアも渡さない');
});

test('逃走者には自分の実位置・仲間・鬼が見え、自分の可能性エリアも分かる', () => {
  const s = publishedState([{ id: 'h', role: H, at: 0 }, { id: 'r', role: R, at: 100 }, { id: 'r2', role: R, at: 200 }]);
  const view = buildPlayerView(s, 'r', 0);
  assert.ok(distanceM(view.self.position, s.positions.r) < 0.01);
  assert.equal(view.self.possibleArea.type, 'possibleArea');
  assert.equal(view.others.find((p) => p.id === 'h').display.kind, DISPLAY.EXACT);
  assert.equal(view.others.find((p) => p.id === 'r2').display.kind, DISPLAY.EXACT);
});

test('「鬼の位置を逃走者に見せる」がOFFなら逃走者・脱落者に鬼は見えない（鬼同士は見える）', () => {
  const s = publishedState(
    [{ id: 'h', role: H, at: 0 }, { id: 'h2', role: H, at: 30 }, { id: 'r', role: R, at: 100 }],
    { showHuntersToRunners: false },
  );
  assert.equal(buildPlayerView(s, 'r', 0).others.find((p) => p.id === 'h').display.kind, DISPLAY.HIDDEN);
  assert.equal(buildPlayerView(s, 'h2', 0).others.find((p) => p.id === 'h').display.kind, DISPLAY.EXACT);
});

test('確保された逃走者の可能性エリアは取り下げられる（増え鬼でも）', () => {
  const s = startStoreGame({ settings: { zombieMode: true, captureRadiusM: 10 }, positions: {} });
  const hunter = s.players.find((p) => p.role === H).id;
  const [r1, r2] = s.players.filter((p) => p.role === R).map((p) => p.id);
  updatePosition(hunter, north(0), 1);
  updatePosition(r1, north(3), 1);
  updatePosition(r2, north(250), 1);
  assert.ok(gameStore.getState().privacy.published[r1], '最初の位置が届いたら公開される');
  requestCapture(hunter, 1000);
  assert.equal(gameStore.getState().privacy.published[r1], undefined);
  const view = getPlayerView(hunter, 1000);
  assert.equal(view.others.find((p) => p.id === r1).display.kind, DISPLAY.EXACT, '鬼になったので鬼として見える');
});

test('ゲーム終了後は位置情報も可能性エリアも公開されず、内部の秘密の値も消える', () => {
  startStoreGame({ positions: { host: north(0), r1: north(100), r2: north(200) } });
  abortGame(5000);
  const s = gameStore.getState();
  assert.deepEqual(s.positions, {});
  assert.deepEqual(s.privacy.published, {});
  assert.deepEqual(s.privacy.secrets, {});
  for (const id of ['host', 'r1', 'r2']) {
    const view = getPlayerView(id, 6000);
    assert.equal(view.self.position, null);
    assert.equal(view.self.possibleArea, null);
    assert.ok(view.others.every((p) => p.display.kind === DISPLAY.HIDDEN));
    assert.equal(collectLatLngs(view.others).length, 0);
  }
  tickGame(100_000);
  assert.deepEqual(gameStore.getState().privacy.published, {}, '終了後に公開されない');
});
