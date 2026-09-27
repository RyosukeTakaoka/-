// ゲーム画面: 地図（ゲームボード）＋HUD
// 表示はすべて getPlayerView()（見せてよい情報）から作る。

import { fromHtml, toast } from '../utils/dom.js';
import {
  gameStore, getPlayerView, updatePosition, requestCapture, tickGame, abortGame, resetGame, PHASE,
} from '../game/gameState.js';
import { CAPTURE_FAILURE_MESSAGE } from '../game/capture.js';
import { createBoard } from '../map/map.js';
import { addStartMarker, addAreaCircle } from '../map/markers.js';
import { createPlayerLayer } from '../map/playerLayer.js';
import { watchPosition } from '../services/locationService.js';
import { roomService } from '../services/roomService.js';
import { isDevMode } from '../dev/devMode.js';
import { startDummySimulator } from '../dev/dummySimulator.js';
import { createDevPanel } from '../dev/devPanel.js';
import { HUD_TEMPLATE, renderHud, renderClock } from './components/gameHud.js';

const TEMPLATE = `
<div class="screen game">
  <div id="game-map" class="game-map"></div>
  ${HUD_TEMPLATE}
  <div id="dev-slot"></div>
  <footer class="game-actions">
    <button id="game-fit" class="btn btn-small" type="button">🎯 エリア全体</button>
    <button id="game-end" class="btn btn-small btn-danger" type="button">ゲーム終了</button>
  </footer>
</div>`;

export const gameScreen = (() => {
  let root = null;
  let board = null;
  let layer = null;
  let viewerId = null;
  let lastLogId = 0;
  let devPanel = null;
  let cleanups = [];
  let stopRealtime = [];
  let disposed = false;

  const view = () => getPlayerView(viewerId);

  /** 位置の共有やダミーの動きを止める（終了したら必ず止める） */
  function stopLocationSharing() {
    for (const fn of stopRealtime) fn();
    stopRealtime = [];
  }

  function notifyNewLogs(v) {
    for (const entry of v.log) {
      if (entry.id <= lastLogId) continue;
      lastLogId = entry.id;
      if (entry.type === 'reveal') {
        const self = gameStore.getState().players.find((p) => p.id === viewerId);
        if (self?.status !== 'active') continue;
        toast(self.role === 'hunter' ? '🔔 逃走者の可能性エリアが更新された' : '⚠ あなたの可能性エリアが鬼に公開された');
        navigator.vibrate?.([80, 60, 80]);
      } else if (entry.type === 'capture' && entry.playerId === viewerId) {
        toast('あなたは確保された…', 3500);
        navigator.vibrate?.([400, 150, 400]);
      } else {
        toast(entry.text, 3000);
        if (entry.type !== 'start') navigator.vibrate?.(200);
      }
    }
  }

  function render() {
    const v = view();
    renderHud(root, v);
    layer?.update(v);
    notifyNewLogs(v);
    devPanel?.update(gameStore.getState().players, viewerId);
    root.querySelector('#game-end').hidden = !(v.phase === PHASE.PLAYING && v.self?.isHost);
    if (v.phase === PHASE.FINISHED) stopLocationSharing();
  }

  function startLocationSharing(selfId) {
    if (isDevMode) {
      toast('開発モード: 地図をタップすると、今の視点のプレイヤーが移動します', 4000);
    } else {
      stopRealtime.push(
        watchPosition(
          (pos) => updatePosition(selfId, pos),
          (err) => toast(err.message, 4000),
        ),
      );
    }
    // ダミー（ほかの端末の代わり）を動かす
    stopRealtime.push(startDummySimulator({ getControlledId: () => (isDevMode ? viewerId : selfId) }));
  }

  return {
    mount(rootEl, { navigate }) {
      root = rootEl;
      disposed = false;
      root.append(fromHtml(TEMPLATE));
      const state = gameStore.getState();
      viewerId = state.selfId;
      lastLogId = 0;

      if (isDevMode) {
        devPanel = createDevPanel({
          players: state.players,
          viewerId,
          onChange: (id) => {
            viewerId = id;
            render();
          },
        });
        root.querySelector('#dev-slot').replaceWith(devPanel.element);
      }

      root.querySelector('#btn-capture').addEventListener('click', () => {
        const result = requestCapture(viewerId);
        if (!result.ok) toast(CAPTURE_FAILURE_MESSAGE[result.reason]);
        else navigator.vibrate?.([100, 50, 100]);
      });
      root.querySelector('#game-fit').addEventListener('click', () => {
        const { area } = gameStore.getState();
        board?.fitCircle(area.center, area.radiusM);
      });
      root.querySelector('#game-end').addEventListener('click', () => {
        if (confirm('ゲームを終了しますか？')) abortGame();
      });
      root.querySelector('#finish-home').addEventListener('click', async () => {
        await roomService.leaveRoom();
        resetGame();
        navigate('home');
      });

      cleanups.push(gameStore.subscribe(render));
      const ticker = setInterval(() => {
        tickGame();
        renderClock(root, view());
      }, 250);
      cleanups.push(() => clearInterval(ticker));

      startLocationSharing(state.selfId);
      render();

      createBoard(root.querySelector('#game-map'), { center: state.area.center, zoom: 16 }).then((b) => {
        if (disposed) return b.destroy();
        board = b;
        const { area } = gameStore.getState();
        addAreaCircle(board, area);
        addStartMarker(board, area.center);
        layer = createPlayerLayer(board);
        if (isDevMode) cleanups.push(board.onClick((p) => updatePosition(viewerId, p)));
        board.fitCircle(area.center, area.radiusM);
        render();
      });
    },

    unmount() {
      disposed = true;
      stopLocationSharing();
      for (const fn of cleanups) fn();
      cleanups = [];
      layer?.clear();
      board?.destroy();
      board = null;
      layer = null;
      devPanel = null;
      root = null;
    },
  };
})();
