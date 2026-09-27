// 端末の位置情報の取得
// 実際のGPS座標はこのモジュールから game/ に渡る。
// 鬼へ送る前には必ず map/privacyArea.js（STEP 3）でぼかすこと。

const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 };

export function isGeolocationAvailable() {
  return 'geolocation' in navigator && window.isSecureContext;
}

/** 現在地を1回取得する -> Promise<{ lat, lng, accuracyM }> */
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!isGeolocationAvailable()) {
      reject(new Error('位置情報が使えません（HTTPS または localhost で開いてください）'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy }),
      (err) => reject(new Error(geoErrorMessage(err))),
      GEO_OPTIONS,
    );
  });
}

function geoErrorMessage(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return '位置情報の利用が許可されていません';
    case err.POSITION_UNAVAILABLE:
      return '現在地を取得できませんでした';
    case err.TIMEOUT:
      return '現在地の取得がタイムアウトしました';
    default:
      return '位置情報エラー';
  }
}
