// ゲーム作成・設定画面（時間・半径・ぼかし・鬼の人数・開始地点）

import { fromHtml, toast } from '../utils/dom.js';
import { formatDistance } from '../utils/distance.js';
import { createOptionGroup } from './components/optionGroup.js';
import {
  DURATION_OPTIONS_MIN,
  RADIUS_OPTIONS_M,
  BLUR_OPTIONS_M,
  CAPTURE_RADIUS_OPTIONS_M,
  MIN_HUNTERS,
  MAX_HUNTERS,
  settingsWarnings,
} from '../game/settings.js';
import { gameStore, updateSettings, setStartPoint, enterLobby } from '../game/gameState.js';
import { createBoard } from '../map/map.js';
import { addStartMarker, addAreaCircle, CIRCLE_STYLE } from '../map/markers.js';
import { getCurrentPosition } from '../services/locationService.js';
import { roomService } from '../services/roomService.js';
import { DEFAULT_CENTER } from '../dev/dummyData.js';

const TEMPLATE = `
<div class="screen create">
  <header class="screen-header">
    <button id="create-back" class="btn-icon" type="button" aria-label="戻る">←</button>
    <h2>ゲーム作成</h2>
  </header>

  <section class="card">
    <h3>ゲーム時間</h3>
    <div data-slot="duration"></div>
  </section>

  <section class="card">
    <h3>ゲームエリアの半径</h3>
    <div data-slot="radius"></div>
  </section>

  <section class="card">
    <h3>初期の位置情報ぼかし</h3>
    <p class="hint">鬼に見える「逃走者がいるかもしれない円」の大きさ</p>
    <div data-slot="blur"></div>
  </section>

  <section class="card">
    <h3>鬼の人数</h3>
    <div class="stepper">
      <button id="hunter-minus" class="btn-icon" type="button" aria-label="減らす">－</button>
      <output id="hunter-count">1</output>
      <button id="hunter-plus" class="btn-icon" type="button" aria-label="増やす">＋</button>
    </div>
  </section>

  <section class="card">
    <h3>確保できる距離</h3>
    <p class="hint">鬼がこの距離まで近づくと「確保」できます（GPSの誤差があるため10m以上がおすすめ）</p>
    <div data-slot="capture"></div>
  </section>

  <section class="card">
    <h3>増え鬼</h3>
    <p class="hint">ON: 捕まった逃走者が鬼になる / OFF: 捕まった逃走者は脱落</p>
    <div data-slot="zombie"></div>
  </section>

  <section class="card">
    <h3>ゲーム開始地点</h3>
    <p class="hint">地図をタップして開始地点を選ぶか、現在地を使ってください。ここがエリアの中心になります。</p>
    <div class="create-map" id="create-map"></div>
    <button id="use-location" class="btn btn-small" type="button">📍 現在地を開始地点にする</button>
    <p id="start-status" class="hint"></p>
  </section>

  <p id="settings-warning" class="warning" hidden></p>
  <button id="create-room" class="btn btn-primary" type="button">ルームを作成</button>
</div>`;

export const createScreen = (() => {
  let board = null;
  let unsubscribe = null;
  let startMarker = null;
  let areaCircle = null;
  let disposed = false;

  function renderStart(root, state) {
    const status = root.querySelector('#start-status');
    status.textContent = state.startPoint
      ? `開始地点: ${state.startPoint.lat.toFixed(5)}, ${state.startPoint.lng.toFixed(5)} / 半径 ${formatDistance(state.settings.radiusM)}`
      : '開始地点が未設定です';
    root.querySelector('#hunter-count').textContent = state.settings.hunterCount;

    const warnings = settingsWarnings(state.settings);
    const warning = root.querySelector('#settings-warning');
    warning.hidden = warnings.length === 0;
    warning.textContent = warnings.join('\n');

    if (!board || !state.area) return;
    if (startMarker) startMarker.setPosition(state.startPoint);
    else startMarker = addStartMarker(board, state.startPoint);
    if (areaCircle) {
      areaCircle.setCenter(state.area.center);
      areaCircle.setRadius(state.area.radiusM);
    } else {
      areaCircle = addAreaCircle(board, state.area, CIRCLE_STYLE.preview);
    }
  }

  function chooseStart(point) {
    setStartPoint(point);
    const { area } = gameStore.getState();
    board?.fitCircle(area.center, area.radiusM);
  }

  return {
    mount(root, { navigate, hostName }) {
      disposed = false;
      root.append(fromHtml(TEMPLATE));
      const { settings } = gameStore.getState();

      root.querySelector('[data-slot=duration]').replaceWith(
        createOptionGroup({
          label: 'ゲーム時間',
          options: DURATION_OPTIONS_MIN,
          value: settings.durationMin,
          format: (v) => `${v}分`,
          onChange: (v) => updateSettings({ durationMin: v }),
        }),
      );
      root.querySelector('[data-slot=radius]').replaceWith(
        createOptionGroup({
          label: 'ゲームエリアの半径',
          options: RADIUS_OPTIONS_M,
          value: settings.radiusM,
          format: formatDistance,
          onChange: (v) => {
            updateSettings({ radiusM: v });
            const { area } = gameStore.getState();
            if (area) board?.fitCircle(area.center, area.radiusM);
          },
        }),
      );
      root.querySelector('[data-slot=blur]').replaceWith(
        createOptionGroup({
          label: '初期の位置情報ぼかし',
          options: BLUR_OPTIONS_M,
          value: settings.initialBlurM,
          format: formatDistance,
          onChange: (v) => updateSettings({ initialBlurM: v }),
        }),
      );

      root.querySelector('[data-slot=capture]').replaceWith(
        createOptionGroup({
          label: '確保できる距離',
          options: CAPTURE_RADIUS_OPTIONS_M,
          value: settings.captureRadiusM,
          format: (v) => `${v}m`,
          onChange: (v) => updateSettings({ captureRadiusM: v }),
        }),
      );
      root.querySelector('[data-slot=zombie]').replaceWith(
        createOptionGroup({
          label: '増え鬼',
          options: [false, true],
          value: settings.zombieMode,
          format: (v) => (v ? 'ON' : 'OFF'),
          onChange: (v) => updateSettings({ zombieMode: v }),
        }),
      );

      const changeHunters = (delta) => {
        const next = Math.min(MAX_HUNTERS, Math.max(MIN_HUNTERS, gameStore.getState().settings.hunterCount + delta));
        updateSettings({ hunterCount: next });
      };
      root.querySelector('#hunter-minus').addEventListener('click', () => changeHunters(-1));
      root.querySelector('#hunter-plus').addEventListener('click', () => changeHunters(1));

      root.querySelector('#create-back').addEventListener('click', () => navigate('home'));

      root.querySelector('#use-location').addEventListener('click', async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          chooseStart(await getCurrentPosition());
          toast('現在地を開始地点にしました');
        } catch (err) {
          toast(`${err.message}。地図をタップして選んでください`, 4000);
        } finally {
          button.disabled = false;
        }
      });

      root.querySelector('#create-room').addEventListener('click', async () => {
        const state = gameStore.getState();
        if (!state.startPoint) {
          toast('ゲーム開始地点を設定してください');
          return;
        }
        let created;
        try {
          created = await roomService.createRoom({ hostName });
        } catch (err) {
          toast(err.message);
          return;
        }
        enterLobby(created);
        navigate('lobby');
      });

      unsubscribe = gameStore.subscribe((state) => renderStart(root, state));

      const initial = gameStore.getState();
      createBoard(root.querySelector('#create-map'), { center: initial.startPoint ?? DEFAULT_CENTER, zoom: 15 }).then(
        (b) => {
          if (disposed) {
            b.destroy();
            return;
          }
          board = b;
          board.onClick(chooseStart);
          if (initial.area) board.fitCircle(initial.area.center, initial.area.radiusM);
          renderStart(root, gameStore.getState());
        },
      );
      renderStart(root, initial);
    },

    unmount() {
      disposed = true;
      unsubscribe?.();
      board?.destroy();
      board = null;
      startMarker = null;
      areaCircle = null;
    },
  };
})();
