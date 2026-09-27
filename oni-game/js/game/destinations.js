// ミッション目的地の生成
//
// 目的地は逃走者ごとに作る（本人の現在地から、直線距離で minDistanceM〜maxDistanceM の範囲）。
// 実位置を使うので、実行するのは実位置を持つ側だけ（今は端末内、Firebase 導入後はサーバー側）。
// 目的地の座標は本人のビューにだけ入り、鬼には渡さない。
//
// ■ 目的地にしてはいけない場所と、このコードで判定できる範囲
//  | 禁止する場所                     | 仮想目的地（地図データなし）での扱い                 |
//  | ゲームエリアの外・境界ぎりぎり     | 自動で除外（境界から EDGE_MARGIN_M 以上内側）        |
//  | 直線距離で遠すぎる場所             | 自動で除外（直線距離の上限）                          |
//  | 車道                             | 自動判定できない → ホストの除外エリアで除外           |
//  | 川・池・海などの水域               | 自動判定できない → ホストの除外エリアで除外           |
//  | 私有地・立入禁止区域               | 自動判定できない → ホストの除外エリアで除外           |
//  | 危険な場所                         | 自動判定できない → ホストの除外エリアで除外           |
//  | 建物の中（GPSの判定が不安定）       | 自動判定できない → ホストの除外エリアで除外           |
//  | 塀・線路の向こうなど、実際には行けない場所 | 自動判定できない → 除外エリア、または逃走者の目的地変更 |
//  Places などの施設候補を使う場合は、種類による絞り込み（isSafePlaceType）も加わるが、
//  それでも個々の場所の安全は保証できない。
//
// ■ 保証の範囲
//  - 保証するのは「ゲームエリア内」「除外エリアから離れている」「現在地から直線距離で範囲内」の3点だけ
//  - 「道を通って歩いて行けること」「安全な場所であること」は保証しない（道路ネットワークや地図データを使っていないため）
//  - 安全性は、ホストが安全な場所をゲームエリアに選ぶことと、除外エリアの設定に依存する
//  - 行けない・危ない目的地だった場合、逃走者は1ゲームに1回だけ目的地を変更できる（mission.js）

import { distanceM, destinationPoint } from '../utils/distance.js';
import { isInsideArea } from './gameArea.js';

export const ARRIVAL_RADIUS_M = 20; // 目的地からこの距離以内で到達
const EDGE_MARGIN_M = ARRIVAL_RADIUS_M + 10; // エリアの境界からの余白
const EXCLUSION_BUFFER_M = ARRIVAL_RADIUS_M + 10; // 除外エリアからの余白
const WALK_SPEED_MPS = 1.2;
const REACH_FACTOR = 0.5; // 直線距離の上限 = 制限時間 × 歩く速さ × この割合（道のりが直線より長くなる分の余裕）
const MIN_DISTANCE_M = 35;
const MAX_DISTANCE_CAP_M = 800;
const MAX_TRIES = 300;

export const DESTINATION_KIND = Object.freeze({
  VIRTUAL: 'virtual', // エリア内に生成した仮想の地点
  PLACE: 'place', // Places などの施設（将来）
});

// Places などの施設の種類による絞り込み。
// 種類名は Google Places API の種類名に合わせる想定（Places を導入するときに公式の一覧で確認・調整する）。

/** 目的地にしてよい種類 */
export const SAFE_PLACE_TYPES = Object.freeze([
  'park', 'playground', 'train_station', 'subway_station', 'bus_station', 'library', 'city_hall',
  'community_center', 'tourist_attraction', 'convenience_store', 'shopping_mall',
]);

/** 目的地にしてはいけない種類（安全な種類を含んでいても除外する） */
export const UNSAFE_PLACE_TYPES = Object.freeze([
  'route', 'street_address', 'natural_feature', 'marina', 'beach', 'lodging', 'parking',
  'gas_station', 'airport', 'premise',
]);

/** 制限時間から、目的地までの直線距離の範囲を決める（道のりの長さは考慮できない） */
export function reachableRange(limitMs) {
  const maxDistanceM = Math.min(
    MAX_DISTANCE_CAP_M,
    Math.max(MIN_DISTANCE_M + 10, (limitMs / 1000) * WALK_SPEED_MPS * REACH_FACTOR),
  );
  return { minDistanceM: MIN_DISTANCE_M, maxDistanceM };
}

/** 除外エリアに近すぎないか */
export function isExcluded(point, exclusionZones = []) {
  return exclusionZones.some((z) => distanceM(point, z.center) <= z.radiusM + EXCLUSION_BUFFER_M);
}

/** 施設の種類が目的地の候補として許可できるか（種類だけの判定で、その場所の安全は保証しない） */
export function isSafePlaceType(types = []) {
  if (types.some((t) => UNSAFE_PLACE_TYPES.includes(t))) return false;
  return types.some((t) => SAFE_PLACE_TYPES.includes(t));
}

/** どの候補にも共通の安全チェック */
export function isAcceptableDestination(point, { area, exclusionZones, from, minDistanceM, maxDistanceM }) {
  if (!isInsideArea(area, point, EDGE_MARGIN_M)) return false;
  if (isExcluded(point, exclusionZones)) return false;
  if (from) {
    const d = distanceM(from, point);
    if (d < minDistanceM || d > maxDistanceM) return false;
  }
  return true;
}

/** 仮想目的地の候補を作る（APIキー不要） */
function virtualCandidate(from, { minDistanceM, maxDistanceM }, rng) {
  // 距離は面積あたり一様になるよう sqrt を使う
  const d = Math.sqrt(minDistanceM ** 2 + rng() * (maxDistanceM ** 2 - minDistanceM ** 2));
  return { ...destinationPoint(from, d, rng() * 360), kind: DESTINATION_KIND.VIRTUAL, label: 'チェックポイント' };
}

/**
 * 目的地を1つ選ぶ。見つからなければ null。
 * @param {object} p
 * @param {{lat,lng}} p.from 逃走者の実位置
 * @param {{center,radiusM}} p.area ゲームエリア
 * @param {Array<{center,radiusM}>} p.exclusionZones 除外エリア
 * @param {number} p.limitMs ミッションの制限時間
 * @param {Array<{lat,lng,label,types}>} [p.placeCandidates] Places などの候補（将来用・無ければ仮想目的地）
 * @param {() => number} p.rng
 */
export function chooseDestination({ from, area, exclusionZones = [], limitMs, placeCandidates = [], rng = Math.random }) {
  const range = reachableRange(limitMs);
  const rules = { area, exclusionZones, from, ...range };

  // 施設候補があれば、安全な種類で条件に合うものを優先する
  const places = placeCandidates.filter((c) => isSafePlaceType(c.types) && isAcceptableDestination(c, rules));
  if (places.length > 0) {
    const c = places[Math.floor(rng() * places.length)];
    return { lat: c.lat, lng: c.lng, kind: DESTINATION_KIND.PLACE, label: c.label ?? '目的地' };
  }

  for (let i = 0; i < MAX_TRIES; i++) {
    const c = virtualCandidate(from, range, rng);
    if (isAcceptableDestination(c, rules)) return c;
  }
  return null;
}
