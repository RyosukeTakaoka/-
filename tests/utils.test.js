import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceM, destinationPoint, formatDistance } from '../oni-game/js/utils/distance.js';
import { createSeededRng, shuffle, randomRoomCode, randomInt } from '../oni-game/js/utils/random.js';

const TOKYO = { lat: 35.681236, lng: 139.767125 };

test('destinationPoint で進んだ距離を distanceM で測ると一致する', () => {
  for (const [d, b] of [[100, 0], [300, 90], [1000, 225], [5000, 333]]) {
    const p = destinationPoint(TOKYO, d, b);
    assert.ok(Math.abs(distanceM(TOKYO, p) - d) < 0.5, `${d}m`);
  }
});

test('formatDistance', () => {
  assert.equal(formatDistance(300), '300m');
  assert.equal(formatDistance(1000), '1km');
  assert.equal(formatDistance(1500), '1.5km');
});

test('シード付き乱数は再現できる', () => {
  const a = createSeededRng(42);
  const b = createSeededRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('shuffle は要素を保ち、元の配列を変えない', () => {
  const src = [1, 2, 3, 4, 5];
  const out = shuffle(src, createSeededRng(1));
  assert.deepEqual([...out].sort(), src);
  assert.deepEqual(src, [1, 2, 3, 4, 5]);
});

test('randomInt は範囲内', () => {
  const rng = createSeededRng(7);
  for (let i = 0; i < 100; i++) {
    const n = randomInt(3, 5, rng);
    assert.ok(n >= 3 && n <= 5);
  }
});

test('ルームコードは6文字で紛らわしい文字を含まない', () => {
  const code = randomRoomCode(createSeededRng(3));
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
});
