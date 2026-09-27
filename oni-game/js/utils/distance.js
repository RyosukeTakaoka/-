// 緯度経度の距離・座標計算
// 座標は { lat, lng }（度）、距離はメートルで扱う。

const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** 2地点間の距離（メートル、ハバーサイン公式） */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** origin から方位 bearingDeg（北=0, 東=90）へ distance メートル進んだ地点 */
export function destinationPoint(origin, distance, bearingDeg) {
  const δ = distance / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

export function isValidLatLng(p) {
  return (
    p != null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/** 表示用に距離を「850m」「1.2km」のような文字列にする */
export function formatDistance(meters) {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)}km`;
  }
  return `${Math.round(meters)}m`;
}

/** a から b への方位（度、北=0 時計回り） */
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ---- 平面近似（ゲームエリア程度の範囲で使う） ----
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;

/** origin を原点とした平面座標（東 = x, 北 = y、メートル） */
export function toLocalXY(origin, p) {
  const cosLat = Math.cos(toRad(origin.lat));
  return {
    x: (p.lng - origin.lng) * cosLat * M_PER_DEG_LNG_AT_EQUATOR,
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** toLocalXY の逆変換 */
export function fromLocalXY(origin, { x, y }) {
  const cosLat = Math.cos(toRad(origin.lat));
  return {
    lat: origin.lat + y / M_PER_DEG_LAT,
    lng: origin.lng + x / (cosLat * M_PER_DEG_LNG_AT_EQUATOR),
  };
}
