// ゲーム画面: 地図（ゲームボード）＋HUD
// 表示はすべて getPlayerView()（見せてよい情報）から作る。

import { fromHtml, toast } from '../utils/dom.js';
import {
  gameStore, getPlayerView, updatePosition, requestCapture, requestNewDestination, tickGame, abortGame, resetGame, PHASE,
} from '../game/gameState.js';
import { CAPTURE_FAILURE_MESSAGE } from '../game/capture.js';
import { createBoard } from '../map/map.js';
import { addStartMarker, addAreaCircle } from '../map/markers.js';
import { createPlayerLayer } from '../map/playerLayer.js';
import { createMissionLayer } from '../map/missionLayer.js';
import { watchPosition } from '../services/locationService.js';
import { roomService } from '../services/roomService.js';
import { isDevMode } from '../dev/devMode.js';
import { startDummySimulator } from '../dev/dummySimulator.js';
import { createDevPanel } from '../dev/devPanel.js';
import { HUD_TEMPLATE, renderHud, renderClock } from './components/gameHud.js';
import { MISSION_PANEL_TEMPLATE, renderMissionPanel } from './components/missionPanel.js';

const TEMPLATE = `
<div class="screen game">
  <div id="game-map" class="game-map"></div>
  ${HUD_TEMPLATE}
  ${MISSION_PANEL_TEMPLATE}
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
  let missionLayer = null;
  let lastOwnResult = null; // 自分のミッション結果の変化を知らせるため
  let lastOwn = null; // { viewerId, historyLength, blurM } 自分のぼかし精度の変化を知らせるため
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
      if (entry.type === 'mission_start') {
        const mine = getPlayerView(viewerId).self?.mission;
        toast(mine?.destination ? '🎯 ミッション発生！ 制限時間内に目的地へ向かえ' : entry.text, 3500);
        navigator.vibrate?.([200, 100, 200, 100, 200]);
      } else if (entry.type === 'reveal') {
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

  function notifyOwnMissionResult(v) {
    const own = v.self?.mission;
    const key = own ? `${own.index}:${own.result}` : null;
    if (key && key !== lastOwnResult && lastOwnResult?.startsWith(`${own.index}:`)) {
      if (own.result === 'success') {
        toast('✅ ミッション成功！', 3000);
        navigator.vibrate?.([100, 50, 100, 50, 300]);
      }
    }
    lastOwnResult = key;
  }

  /** ミッション終了で自分の blurM が変わったことを本人にだけ知らせる（鬼には通知しない） */
  function notifyOwnBlurChange(v) {
    const self = v.self;
    const now = self ? { viewerId, historyLength: self.missionHistory.length, blurM: self.blurM } : null;
    const prev = lastOwn;
    lastOwn = now;
    if (!now || !prev || prev.viewerId !== viewerId || now.historyLength <= prev.historyLength) return;
    if (self.role !== 'runner' || self.status !== 'active') return;
    const result = self.missionHistory.at(-1)?.result;
    const change = `${prev.blurM}m → ${now.blurM}m・次の位置公開から反映`;
    if (result === 'success') {
      toast(now.blurM > prev.blurM
        ? `✅ ミッション成功！ 位置情報のぼかしが強くなりました（${change}）`
        : '✅ ミッション成功！ ぼかしはすでに最大です', 4500);
    } else if (result === 'failure') {
      toast(now.blurM < prev.blurM
        ? `❌ ミッション失敗… 位置情報のぼかしが弱くなりました（${change}）`
        : '❌ ミッション失敗… ぼかしはすでに最小です', 4500);
      navigator.vibrate?.([300, 100, 300]);
    }
  }

  function render() {
    const v = view();
    renderHud(root, v);
    renderMissionPanel(root, v);
    notifyOwnMissionResult(v);
    layer?.update(v);
    missionLayer?.update(v);
    notifyNewLogs(v);
    notifyOwnBlurChange(v); // ログの通知より後（本人向けの通知を優先して表示する）
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
      root.querySelector('#mission-reroll').addEventListener('click', () => {
        if (!confirm('目的地を変更しますか？（1ゲームにつき1回だけ使えます）')) return;
        const result = requestNewDestination(viewerId);
        toast(result.ok ? '目的地を変更しました' : '目的地を変更できませんでした');
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
        const v = view();
        renderClock(root, v);
        renderMissionPanel(root, v);
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
        missionLayer = createMissionLayer(board);
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
      missionLayer?.clear();
      board?.destroy();
      board = null;
      layer = null;
      missionLayer = null;
      lastOwnResult = null;
      lastOwn = null;
      devPanel = null;
      root = null;
    },
  };
})();
