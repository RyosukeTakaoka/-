// ゲームエリア（開始地点を中心とした円）

import { distanceM, destinationPoint, isValidLatLng } from '../utils/distance.js';

/** @returns {{center: {lat:number,lng:number}, radiusM: number}} */
export function createGameArea(center, radiusM) {
  if (!isValidLatLng(center)) throw new Error('ゲーム開始地点が正しくありません');
  if (!(radiusM > 0)) throw new Error('ゲーム半径が正しくありません');
  return { center: { lat: center.lat, lng: center.lng }, radiusM };
}

export function distanceFromCenter(area, point) {
  return distanceM(area.center, point);
}

/** 点がエリア内か。marginM > 0 なら境界から内側に余裕を取る */
export function isInsideArea(area, point, marginM = 0) {
  return distanceFromCenter(area, point) <= area.radiusM - marginM;
}

/**
 * エリア内の一様ランダムな点。
 * marginM で境界付近を避ける（ミッション目的地やダミー配置用）。
 */
export function randomPointInArea(area, rng = Math.random, { marginM = 0 } = {}) {
  const maxR = Math.max(0, area.radiusM - marginM);
  const r = maxR * Math.sqrt(rng()); // sqrt で面積あたり一様になる
  const bearing = rng() * 360;
  return destinationPoint(area.center, r, bearing);
}
