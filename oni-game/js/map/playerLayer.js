// 地図上のプレイヤー表示（自分・他プレイヤー・自分の確保範囲）
// 入力は visibility.js のビューだけ。実位置の状態(positions)には触れない。

import { DISPLAY } from '../game/visibility.js';
import { ROLE, STATUS } from '../game/player.js';
import { addPlayerMarker, playerPinKey, CIRCLE_STYLE } from './markers.js';

export function createPlayerLayer(board) {
  const markers = new Map(); // id -> { handle, key }
  let captureCircle = null;

  function upsert(id, player, position, isSelf) {
    const key = playerPinKey(player, isSelf);
    const existing = markers.get(id);
    if (existing && existing.key === key) {
      existing.handle.setPosition(position);
      return;
    }
    existing?.handle.remove();
    markers.set(id, { key, handle: addPlayerMarker(board, player, position, { isSelf }) });
  }

  function updateCaptureCircle(view) {
    const self = view.self;
    const show =
      view.phase === 'playing' && self?.position && self.role === ROLE.HUNTER && self.status === STATUS.ACTIVE;
    if (!show) {
      captureCircle?.remove();
      captureCircle = null;
      return;
    }
    if (!captureCircle) {
      captureCircle = board.addCircle({
        center: self.position,
        radiusM: view.settings.captureRadiusM,
        style: CIRCLE_STYLE.capture,
      });
    } else {
      captureCircle.setCenter(self.position);
      captureCircle.setRadius(view.settings.captureRadiusM);
    }
  }

  return {
    /** ビューに合わせてマーカーを追加・移動・削除する */
    update(view) {
      const seen = new Set();
      if (view.self?.position) {
        upsert(view.self.id, view.self, view.self.position, true);
        seen.add(view.self.id);
      }
      for (const p of view.others) {
        // STEP 3: DISPLAY.AREA（可能性エリア）の描画をここに追加する
        if (p.display.kind !== DISPLAY.EXACT) continue;
        upsert(p.id, p, p.display.position, false);
        seen.add(p.id);
      }
      for (const [id, m] of markers) {
        if (!seen.has(id)) {
          m.handle.remove();
          markers.delete(id);
        }
      }
      updateCaptureCircle(view);
    },

    clear() {
      for (const m of markers.values()) m.handle.remove();
      markers.clear();
      captureCircle?.remove();
      captureCircle = null;
    },
  };
}
