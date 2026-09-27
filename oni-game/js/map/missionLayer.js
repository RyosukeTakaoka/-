// 地図上のミッション表示（自分の目的地・除外エリア）
// 入力は visibility.js のビューだけ。目的地は本人のビューにしか入っていない。

import { addDestinationMarker, CIRCLE_STYLE } from './markers.js';

export function createMissionLayer(board) {
  let destination = null; // { key, marker, circle }
  let exclusions = []; // circle handles
  let exclusionKey = '';

  function clearDestination() {
    destination?.marker.remove();
    destination?.circle.remove();
    destination = null;
  }

  function updateExclusions(zones) {
    const key = zones.map((z) => `${z.center.lat},${z.center.lng},${z.radiusM}`).join('|');
    if (key === exclusionKey) return;
    exclusionKey = key;
    for (const c of exclusions) c.remove();
    exclusions = zones.map((z) => board.addCircle({ center: z.center, radiusM: z.radiusM, style: CIRCLE_STYLE.exclusion }));
  }

  return {
    update(view) {
      updateExclusions(view.exclusionZones ?? []);
      const d = view.self?.mission?.destination;
      if (!d) return clearDestination();
      const key = `${d.lat},${d.lng}`;
      if (destination?.key === key) return;
      clearDestination();
      destination = {
        key,
        circle: board.addCircle({ center: d, radiusM: view.self.mission.arrivalRadiusM, style: CIRCLE_STYLE.destination }),
        marker: addDestinationMarker(board, d),
      };
    },

    clear() {
      clearDestination();
      updateExclusions([]);
    },
  };
}
