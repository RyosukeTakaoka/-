// Google Maps 版のゲームボード
// Google Maps は「盤面」として使うだけで、ゲームのルールは持たせない。
// 公開するメソッドは fallbackBoard.js と同じ（map.js 参照）。

export async function createGoogleBoard(container, { center, zoom = 16, mapId }) {
  const { Map, Circle } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');

  const map = new Map(container, {
    center,
    zoom,
    mapId,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy', // スマホで1本指スクロールできるように
    clickableIcons: false, // 施設アイコンのタップでゲーム操作が邪魔されないように
  });

  return {
    kind: 'google',

    setCenter(point) {
      map.setCenter(point);
    },

    fitCircle(point, radiusM) {
      const bounds = new Circle({ center: point, radius: radiusM }).getBounds();
      if (bounds) map.fitBounds(bounds, 24);
    },

    onClick(callback) {
      const listener = map.addListener('click', (e) => callback({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
      return () => listener.remove();
    },

    addCircle({ center: c, radiusM, style }) {
      const circle = new Circle({
        map,
        center: c,
        radius: radiusM,
        clickable: false,
        strokeColor: style.stroke,
        strokeOpacity: 0.9,
        strokeWeight: style.strokeWidth ?? 2,
        fillColor: style.fill,
        fillOpacity: style.fillOpacity ?? 0.1,
      });
      return {
        setCenter: (p) => circle.setCenter(p),
        setRadius: (r) => circle.setRadius(r),
        remove: () => circle.setMap(null),
      };
    },

    addMarker({ position, element, title }) {
      const marker = new AdvancedMarkerElement({ map, position, content: element, title });
      return {
        setPosition: (p) => {
          marker.position = p;
        },
        remove: () => {
          marker.map = null;
        },
      };
    },

    destroy() {
      google.maps.event.clearInstanceListeners(map);
      container.replaceChildren();
    },
  };
}
