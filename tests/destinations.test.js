import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { distanceM, destinationPoint } from '../oni-game/js/utils/distance.js';
import { createGameArea, isInsideArea } from '../oni-game/js/game/gameArea.js';
import {
  chooseDestination, reachableRange, isSafePlaceType, ARRIVAL_RADIUS_M, DESTINATION_KIND,
} from '../oni-game/js/game/destinations.js';
import { CENTER } from './helpers.js';

test('目的地は必ずゲームエリアの内側（境界から余白あり）で、届く距離にある', () => {
  const rng = createSeededRng(4);
  for (const radiusM of [100, 300, 1000, 5000]) {
    const area = createGameArea(CENTER, radiusM);
    for (let i = 0; i < 400; i++) {
      const from = destinationPoint(CENTER, radiusM * Math.sqrt(rng()), rng() * 360);
      const limitMs = [45_000, 60_000, 180_000, 300_000][i % 4];
      const d = chooseDestination({ from, area, limitMs, rng });
      if (!d) continue; // 小さなエリアの端などで条件に合う場所が無い場合は null（そのミッションは無効）
      assert.ok(isInsideArea(area, d, ARRIVAL_RADIUS_M + 10 - 0.01), 'エリアの外・境界ぎりぎり');
      const { minDistanceM, maxDistanceM } = reachableRange(limitMs);
      const dist = distanceM(from, d);
      assert.ok(dist >= minDistanceM - 0.01 && dist <= maxDistanceM + 0.01, `距離 ${dist}`);
      assert.equal(d.kind, DESTINATION_KIND.VIRTUAL);
    }
  }
});

test('学校くらいの小さなエリア（半径100m）でも、APIなしで目的地を作れる', () => {
  const rng = createSeededRng(5);
  const area = createGameArea(CENTER, 100);
  let found = 0;
  for (let i = 0; i < 100; i++) {
    const from = destinationPoint(CENTER, 50 * Math.sqrt(rng()), rng() * 360);
    if (chooseDestination({ from, area, limitMs: 60_000, rng })) found += 1;
  }
  assert.ok(found >= 95, `見つかった回数 ${found}/100`);
});

test('除外エリア（道路・水辺・立入禁止など）には目的地を作らない', () => {
  const rng = createSeededRng(6);
  const area = createGameArea(CENTER, 300);
  const exclusionZones = [
    { center: destinationPoint(CENTER, 60, 0), radiusM: 30 },
    { center: destinationPoint(CENTER, 60, 120), radiusM: 30 },
    { center: destinationPoint(CENTER, 60, 240), radiusM: 30 },
  ];
  for (let i = 0; i < 500; i++) {
    const d = chooseDestination({ from: CENTER, area, exclusionZones, limitMs: 180_000, rng });
    assert.ok(d, '目的地が作れない');
    for (const z of exclusionZones) {
      assert.ok(distanceM(d, z.center) > z.radiusM + ARRIVAL_RADIUS_M, '除外エリアに近すぎる');
    }
  }
});

test('施設候補は安全な種類だけ使い、危険・私有・水域などは使わない', () => {
  assert.equal(isSafePlaceType(['park']), true);
  assert.equal(isSafePlaceType(['train_station', 'transit_station']), true);
  assert.equal(isSafePlaceType(['natural_feature']), false);
  assert.equal(isSafePlaceType(['park', 'marina']), false, '安全な種類を含んでいても危険な種類があれば除外');
  assert.equal(isSafePlaceType(['route']), false);
  assert.equal(isSafePlaceType(['premise']), false);
  assert.equal(isSafePlaceType([]), false);

  const area = createGameArea(CENTER, 1000);
  const from = CENTER;
  const placeCandidates = [
    { ...destinationPoint(CENTER, 100, 0), label: '池', types: ['natural_feature'] },
    { ...destinationPoint(CENTER, 120, 90), label: '道路', types: ['route'] },
    { ...destinationPoint(CENTER, 2000, 0), label: 'エリア外の公園', types: ['park'] },
    { ...destinationPoint(CENTER, 150, 200), label: '〇〇公園', types: ['park'] },
  ];
  for (let i = 0; i < 20; i++) {
    const d = chooseDestination({ from, area, limitMs: 300_000, placeCandidates, rng: createSeededRng(i) });
    assert.equal(d.label, '〇〇公園');
    assert.equal(d.kind, DESTINATION_KIND.PLACE);
  }
});

test('条件に合う場所がなければ null（無理な場所にしない）', () => {
  const area = createGameArea(CENTER, 100);
  const exclusionZones = [{ center: CENTER, radiusM: 100 }]; // エリア全体が除外
  assert.equal(chooseDestination({ from: CENTER, area, exclusionZones, limitMs: 60_000, rng: createSeededRng(1) }), null);
});
