// ゲーム画面: 地図（ゲームボード）＋HUD

import { fromHtml, toast } from '../utils/dom.js';
import { gameStore, endGame, selfPlayer, resetGame } from '../game/gameState.js';
import { ROLE, ROLE_LABEL, hunters, runners } from '../game/player.js';
import { startCountdown, formatClock } from '../game/gameTimer.js';
import { createBoard } from '../map/map.js';
import { addStartMarker, addAreaCircle, addPlayerMarker } from '../map/markers.js';
import { roomService } from '../services/roomService.js';

const TEMPLATE = `
<div class="screen game">
  <div id="game-map" class="game-map"></div>

  <header class="hud">
    <div id="hud-role" class="role-badge"></div>
    <div id="hud-timer" class="hud-timer">--:--</div>
    <div id="hud-counts" class="hud-counts"></div>
  </header>

  <p class="dev-banner">開発表示：全員の位置をそのまま表示中（STEP 3 で可能性エリアに置き換え）</p>

  <footer class="game-actions">
    <button id="game-fit" class="btn btn-small" type="button">🎯 エリア全体</button>
    <button id="game-end" class="btn btn-small btn-danger" type="button">ゲーム終了</button>
  </footer>
</div>`;

export const gameScreen = (() => {
  let board = null;
  let stopTimer = null;
  let disposed = false;

  function drawBoard(state) {
    const { area } = state;
    addAreaCircle(board, area);
    addStartMarker(board, area.center);
    for (const p of state.players) {
      if (p.position) addPlayerMarker(board, p, { isSelf: p.id === state.selfId });
    }
    board.fitCircle(area.center, area.radiusM);
  }

  function finish(navigate, message) {
    endGame();
    toast(message, 3500);
    // 結果画面は STEP 6 で実装。今はホームへ戻る
    roomService.leaveRoom();
    resetGame();
    navigate('home');
  }

  return {
    mount(root, { navigate }) {
      disposed = false;
      root.append(fromHtml(TEMPLATE));
      const state = gameStore.getState();
      const me = selfPlayer(state);

      const badge = root.querySelector('#hud-role');
      badge.textContent = `${me.role === ROLE.HUNTER ? '👹' : '🏃'} ${ROLE_LABEL[me.role]}`;
      badge.classList.add(me.role);
      root.querySelector('#hud-counts').textContent =
        `鬼 ${hunters(state.players).length} / 逃走者 ${runners(state.players).length}`;

      const timerEl = root.querySelector('#hud-timer');
      stopTimer = startCountdown({
        endsAt: state.endsAt,
        onTick: (ms) => {
          timerEl.textContent = formatClock(ms);
          timerEl.classList.toggle('danger', ms < 60_000);
        },
        onEnd: () => finish(navigate, '時間切れ！ゲーム終了'),
      });

      root.querySelector('#game-fit').addEventListener('click', () => {
        const { area } = gameStore.getState();
        board?.fitCircle(area.center, area.radiusM);
      });
      root.querySelector('#game-end').addEventListener('click', () => {
        if (confirm('ゲームを終了しますか？')) finish(navigate, 'ゲームを終了しました');
      });

      createBoard(root.querySelector('#game-map'), { center: state.area.center, zoom: 16 }).then((b) => {
        if (disposed) return b.destroy();
        board = b;
        drawBoard(gameStore.getState());
      });
    },

    unmount() {
      disposed = true;
      stopTimer?.();
      board?.destroy();
      board = null;
    },
  };
})();
