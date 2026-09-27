// ゲームボード（地図）の作成窓口
//
// どの実装でも同じメソッドを持つ「ボード」を返す:
//   setCenter(point), fitCircle(point, radiusM), onClick(cb) -> 解除関数,
//   addCircle({ center, radiusM, style }) -> { setCenter, setRadius, remove },
//   addMarker({ position, element, title }) -> { setPosition, remove },
//   destroy()
// 画面側は Google Maps を直接触らず、このボードと markers.js だけを使う。

import { loadConfig } from '../core/config.js';
import { loadGoogleMaps } from './loader.js';
import { createGoogleBoard } from './googleBoard.js';
import { createFallbackBoard } from './fallbackBoard.js';

let googleUnavailable = false;

export async function createBoard(container, { center, zoom } = {}) {
  const config = await loadConfig();
  if (config.googleMapsApiKey && !googleUnavailable) {
    try {
      await loadGoogleMaps(config.googleMapsApiKey);
      return await createGoogleBoard(container, { center, zoom, mapId: config.googleMapsMapId });
    } catch (err) {
      googleUnavailable = true; // 以降は簡易ボードを使う
      console.warn('Google Maps を使えないため簡易マップに切り替えます:', err);
    }
  }
  return createFallbackBoard(container, { center });
}

// APIキーが無効・リファラー制限に一致しない場合に Google Maps から呼ばれる
window.gm_authFailure = () => {
  console.error('Google Maps の認証に失敗しました。APIキーと HTTPリファラー制限を確認してください。');
};
