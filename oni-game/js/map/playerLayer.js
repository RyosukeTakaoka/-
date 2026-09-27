// 地図上のプレイヤー表示（自分・他プレイヤー・可能性エリア・自分の確保範囲）
// 入力は visibility.js のビューだけ。実位置の状態(positions)には触れない。

import { DISPLAY } from '../game/visibility.js';
import { ROLE, STATUS } from '../game/player.js';
import { destinationPoint } from '../utils/distance.js';
import { addPlayerMarker, addPossibleAreaLabel, playerPinKey, CIRCLE_STYLE } from './markers.js';

export function createPlayerLayer(board) {
  const markers = new Map(); // id -> { handle, key }
  const areas = new Map(); // id -> { circle, label, key }
  let captureCircle = null;
  let ownArea = null;

  function upsertMarker(id, player, position, isSelf) {
    const key = playerPinKey(player, isSelf);
    const existing = markers.get(id);
    if (existing && existing.key === key) {
      existing.handle.setPosition(position);
      return;
    }
    existing?.handle.remove();
    markers.set(id, { key, handle: addPlayerMarker(board, player, position, { isSelf }) });
  }

  /** 可能性エリア（円＋北端の❓ラベル）。公開されたときだけ作り直す */
  function upsertArea(id, name, area) {
    const key = `${area.center.lat},${area.center.lng},${area.radiusM},${name}`;
    const existing = areas.get(id);
    if (existing?.key === key) return;
    removeArea(id);
    areas.set(id, {
      key,
      circle: board.addCircle({ center: area.center, radiusM: area.radiusM, style: CIRCLE_STYLE.possibleArea }),
      label: addPossibleAreaLabel(board, destinationPoint(area.center, area.radiusM, 0), `${name}はこの中のどこか`),
    });
  }

  function removeArea(id) {
    const a = areas.get(id);
    if (!a) return;
    a.circle.remove();
    a.label.remove();
    areas.delete(id);
  }

  function updateOwnArea(area) {
    if (!area) {
      ownArea?.remove();
      ownArea = null;
      return;
    }
    if (!ownArea) {
      ownArea = board.addCircle({ center: area.center, radiusM: area.radiusM, style: CIRCLE_STYLE.ownPossibleArea });
    } else {
      ownArea.setCenter(area.center);
      ownArea.setRadius(area.radiusM);
    }
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
    /** ビューに合わせてマーカー・円を追加・移動・削除する */
    update(view) {
      const seenMarkers = new Set();
      const seenAreas = new Set();
      if (view.self?.position) {
        upsertMarker(view.self.id, view.self, view.self.position, true);
        seenMarkers.add(view.self.id);
      }
      for (const p of view.others) {
        if (p.display.kind === DISPLAY.EXACT) {
          upsertMarker(p.id, p, p.display.position, false);
          seenMarkers.add(p.id);
        } else if (p.display.kind === DISPLAY.AREA) {
          upsertArea(p.id, p.name, p.display);
          seenAreas.add(p.id);
        }
      }
      for (const [id, m] of markers) {
        if (!seenMarkers.has(id)) {
          m.handle.remove();
          markers.delete(id);
        }
      }
      for (const id of [...areas.keys()]) if (!seenAreas.has(id)) removeArea(id);
      updateOwnArea(view.self?.possibleArea ?? null);
      updateCaptureCircle(view);
    },

    clear() {
      for (const m of markers.values()) m.handle.remove();
      markers.clear();
      for (const id of [...areas.keys()]) removeArea(id);
      updateOwnArea(null);
      captureCircle?.remove();
      captureCircle = null;
    },
  };
}
