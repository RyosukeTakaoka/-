// ルーム（ロビー）画面: 友達の招待・参加者一覧・ゲーム開始

import { el, fromHtml, toast } from '../utils/dom.js';
import { formatDistance } from '../utils/distance.js';
import { gameStore, setPlayers, startGame, resetGame } from '../game/gameState.js';
import { createInitialPositions } from '../dev/dummyData.js';
import { roomService } from '../services/roomService.js';

const TEMPLATE = `
<div class="screen lobby">
  <header class="screen-header">
    <button id="lobby-leave" class="btn-icon" type="button" aria-label="退出">←</button>
    <h2>ルーム</h2>
  </header>

  <section class="card room-code-card">
    <p class="muted">ルームコード</p>
    <p id="room-code" class="room-code"></p>
    <button id="lobby-invite" class="btn btn-small" type="button">🔗 友達を招待</button>
  </section>

  <section class="card">
    <h3>ルール</h3>
    <dl id="lobby-rules" class="rules"></dl>
  </section>

  <section class="card">
    <h3>参加者 <span id="player-count"></span></h3>
    <ul id="player-list" class="player-list"></ul>
    <button id="lobby-add-dummy" class="btn btn-small" type="button">＋ ダミーの友達を追加（開発用）</button>
  </section>

  <p class="hint">鬼と逃走者はゲーム開始時にランダムで決まります。</p>
  <button id="lobby-start" class="btn btn-primary" type="button">ゲーム開始</button>
  <p id="lobby-start-hint" class="hint center"></p>
</div>`;

function renderRules(dl, settings) {
  const rows = [
    ['ゲーム時間', `${settings.durationMin}分`],
    ['エリア半径', formatDistance(settings.radiusM)],
    ['初期ぼかし', formatDistance(settings.initialBlurM)],
    ['鬼の人数', `${settings.hunterCount}人`],
    ['確保距離', `${settings.captureRadiusM}m`],
    ['増え鬼', settings.zombieMode ? 'ON（捕まると鬼になる）' : 'OFF（捕まると脱落）'],
  ];
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

function renderPlayers(root, state) {
  const list = root.querySelector('#player-list');
  list.replaceChildren(
    ...state.players.map((p) => {
      const tags = [p.isHost && '👑 ホスト', p.id === state.selfId && 'あなた', p.isDummy && 'ダミー'].filter(Boolean);
      return el('li', {}, [el('span', { text: p.name }), el('span', { className: 'tag', text: tags.join(' / ') })]);
    }),
  );
  root.querySelector('#player-count').textContent = `(${state.players.length}人)`;

  const needed = state.settings.hunterCount + 1;
  const isHost = state.room?.hostId === state.selfId;
  const start = root.querySelector('#lobby-start');
  start.disabled = !isHost || state.players.length < needed;
  root.querySelector('#lobby-start-hint').textContent = !isHost
    ? 'ホストの開始を待っています…'
    : state.players.length < needed
      ? `鬼${state.settings.hunterCount}人＋逃走者1人以上、あと${needed - state.players.length}人必要です`
      : '';
}

export const lobbyScreen = (() => {
  let cleanups = [];

  return {
    mount(root, { navigate }) {
      root.append(fromHtml(TEMPLATE));
      const state = gameStore.getState();
      root.querySelector('#room-code').textContent = state.room.code;
      renderRules(root.querySelector('#lobby-rules'), state.settings);

      root.querySelector('#lobby-invite').addEventListener('click', async () => {
        const { room } = gameStore.getState();
        const url = `${location.origin}${location.pathname}?room=${room.code}`;
        const text = `リアル鬼ごっこに参加しよう！ルームコード: ${room.code}`;
        try {
          if (navigator.share) await navigator.share({ title: 'リアル鬼ごっこ', text, url });
          else {
            await navigator.clipboard.writeText(`${text}\n${url}`);
            toast('招待リンクをコピーしました');
          }
        } catch {
          /* 共有キャンセル */
        }
      });

      root.querySelector('#lobby-add-dummy').addEventListener('click', () => roomService.addDummyPlayer());

      root.querySelector('#lobby-leave').addEventListener('click', async () => {
        if (!confirm('ルームを解散してホームに戻りますか？')) return;
        await roomService.leaveRoom();
        resetGame();
        navigate('home');
      });

      root.querySelector('#lobby-start').addEventListener('click', () => {
        const s = gameStore.getState();
        try {
          // ダミー段階: ダミーはエリア内に仮配置、自分は GPS が届くまで開始地点にいるものとする
          startGame({ initialPositions: createInitialPositions(s.players, s.area) });
          navigate('game');
        } catch (err) {
          toast(err.message);
        }
      });

      // ルームの参加者の変化（今はダミー、将来は Firebase）をゲーム状態に反映
      cleanups.push(
        roomService.onPlayersChanged((players) => setPlayers(players)),
      );
      cleanups.push(gameStore.subscribe((s) => renderPlayers(root, s)));
      renderPlayers(root, state);
    },

    unmount() {
      for (const fn of cleanups) fn();
      cleanups = [];
    },
  };
})();
