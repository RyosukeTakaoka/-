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
