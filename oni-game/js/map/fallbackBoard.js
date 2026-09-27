// APIキーが無いとき用の簡易ボード（方眼紙）
// 開発中やオフラインでもゲームの流れを確認できるようにするためのもの。
// 公開するメソッドは googleBoard.js と同じ。

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;
const GRID_M = 50;

export function createFallbackBoard(container, { center }) {
  const origin = { ...center };
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const view = { x: 0, y: 0, scale: 1 }; // 表示中心（m）と 1m あたりのピクセル数
  const items = new Set();
  const clickHandlers = new Set();

  const root = document.createElement('div');
  root.className = 'fallback-board';
  const layer = document.createElement('div');
  layer.className = 'fallback-layer';
  const notice = document.createElement('div');
  notice.className = 'fallback-notice';
  notice.textContent = '簡易マップ（Google Maps 未設定）・1マス50m';
  const zoomBox = document.createElement('div');
  zoomBox.className = 'fallback-zoom';
  zoomBox.innerHTML = '<button type="button" data-z="1.5" aria-label="拡大">＋</button><button type="button" data-z="0.667" aria-label="縮小">－</button>';
  root.append(layer, notice, zoomBox);
  container.replaceChildren(root);

  const toMeters = (p) => ({
    x: (p.lng - origin.lng) * cosLat * M_PER_DEG_LNG_AT_EQUATOR,
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  });
  const toLatLng = (m) => ({
    lat: origin.lat + m.y / M_PER_DEG_LAT,
    lng: origin.lng + m.x / (cosLat * M_PER_DEG_LNG_AT_EQUATOR),
  });
  const toScreen = (p) => {
    const m = toMeters(p);
    return {
      x: root.clientWidth / 2 + (m.x - view.x) * view.scale,
      y: root.clientHeight / 2 - (m.y - view.y) * view.scale,
    };
  };

  function redraw() {
    const size = GRID_M * view.scale;
    root.style.backgroundSize = `${size}px ${size}px`;
    root.style.backgroundPosition = `${root.clientWidth / 2 - view.x * view.scale}px ${root.clientHeight / 2 + view.y * view.scale}px`;
    for (const item of items) item.draw();
  }

  function zoomBy(factor) {
    view.scale = Math.min(20, Math.max(0.01, view.scale * factor));
    redraw();
  }

  // ---- 操作（ドラッグで移動・タップでクリック・ホイールでズーム） ----
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.fallback-zoom')) return;
    drag = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    view.x = drag.vx - dx / view.scale;
    view.y = drag.vy + dy / view.scale;
    redraw();
  });
  root.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      const rect = root.getBoundingClientRect();
      const point = toLatLng({
        x: view.x + (e.clientX - rect.left - root.clientWidth / 2) / view.scale,
        y: view.y - (e.clientY - rect.top - root.clientHeight / 2) / view.scale,
      });
      for (const cb of clickHandlers) cb(point);
    }
    drag = null;
  });
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });
  zoomBox.addEventListener('click', (e) => {
    const z = e.target.closest('button')?.dataset.z;
    if (z) zoomBy(Number(z));
  });

  const resizeObserver = new ResizeObserver(redraw);
  resizeObserver.observe(root);

  function track(item) {
    items.add(item);
    item.draw();
    return item;
  }

  return {
    kind: 'fallback',

    setCenter(point) {
      Object.assign(view, toMeters(point));
      redraw();
    },

    fitCircle(point, radiusM) {
      Object.assign(view, toMeters(point));
      const size = Math.min(root.clientWidth, root.clientHeight) || 300;
      view.scale = (size * 0.45) / radiusM;
      redraw();
    },

    onClick(callback) {
      clickHandlers.add(callback);
      return () => clickHandlers.delete(callback);
    },

    addCircle({ center: c, radiusM, style }) {
      const node = document.createElement('div');
      node.className = 'fallback-circle';
      node.style.borderColor = style.stroke;
      node.style.borderWidth = `${style.strokeWidth ?? 2}px`;
      node.style.setProperty('--fill', style.fill);
      node.style.setProperty('--fill-opacity', style.fillOpacity ?? 0.1);
      layer.append(node);
      const item = {
        center: c,
        radiusM,
        draw() {
          const p = toScreen(this.center);
          const r = this.radiusM * view.scale;
          Object.assign(node.style, { left: `${p.x - r}px`, top: `${p.y - r}px`, width: `${2 * r}px`, height: `${2 * r}px` });
        },
      };
      track(item);
      return {
        setCenter: (p) => { item.center = p; item.draw(); },
        setRadius: (r) => { item.radiusM = r; item.draw(); },
        remove: () => { items.delete(item); node.remove(); },
      };
    },

    addMarker({ position, element, title }) {
      const node = document.createElement('div');
      node.className = 'fallback-marker';
      if (title) node.title = title;
      node.append(element);
      layer.append(node);
      const item = {
        position,
        draw() {
          const p = toScreen(this.position);
          node.style.transform = `translate(${p.x}px, ${p.y}px)`;
        },
      };
      track(item);
      return {
        setPosition: (p) => { item.position = p; item.draw(); },
        remove: () => { items.delete(item); node.remove(); },
      };
    },

    destroy() {
      resizeObserver.disconnect();
      items.clear();
      clickHandlers.clear();
      container.replaceChildren();
    },
  };
}
