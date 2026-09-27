// ルーム（ロビー）画面: 友達の招待・参加者一覧・ゲーム開始

import { el, fromHtml, toast } from '../utils/dom.js';
import { formatDistance } from '../utils/distance.js';
import { gameService } from '../services/gameService.js';

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
    ['位置の公開間隔', settings.revealIntervalSec < 60 ? `${settings.revealIntervalSec}秒` : `${settings.revealIntervalSec / 60}分`],
    ['鬼の位置', settings.showHuntersToRunners ? '逃走者に見せる' : '逃走者に見せない'],
    ['鬼の人数', `${settings.hunterCount}人`],
    ['確保距離', `${settings.captureRadiusM}m`],
    ['増え鬼', settings.zombieMode ? 'ON（捕まると鬼になる）' : 'OFF（捕まると脱落）'],
  ];
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

/** session（gameService.getSession()）だけを使って描画する */
function renderPlayers(root, state) {
  const list = root.querySelector('#player-list');
  list.replaceChildren(
    ...state.players.map((p) => {
      const tags = [
        p.isHost && '👑 ホスト',
        p.id === state.selfId && 'あなた',
        p.isDummy && 'ダミー',
        p.online === false && 'オフライン', // 在席は目安（切断の反映には時間がかかることがある）
      ].filter(Boolean);
      return el('li', {}, [el('span', { text: p.name }), el('span', { className: 'tag', text: tags.join(' / ') })]);
    }),
  );
  root.querySelector('#player-count').textContent = `(${state.players.length}人)`;

  const needed = state.settings.hunterCount + 1;
  const { isHost } = state;
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
      const state = gameService.getSession();
      root.querySelector('#room-code').textContent = state.room.code;
      renderRules(root.querySelector('#lobby-rules'), state.settings);

      root.querySelector('#lobby-invite').addEventListener('click', async () => {
        const { room } = gameService.getSession();
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

      const dummyButton = root.querySelector('#lobby-add-dummy');
      dummyButton.hidden = gameService.mode !== 'local'; // ダミーは端末内モードだけ
      dummyButton.addEventListener('click', () => gameService.addDummyPlayer());

      root.querySelector('#lobby-leave').addEventListener('click', async () => {
        const { isHost } = gameService.getSession();
        if (!confirm(isHost ? 'ルームを解散してホームに戻りますか？' : 'ルームから退出しますか？')) return;
        await gameService.leaveRoom();
        navigate('home');
      });

      root.querySelector('#lobby-start').addEventListener('click', () => {
        try {
          gameService.startGame();
          navigate('game');
        } catch (err) {
          toast(err.message);
        }
      });

      // 参加者の変化（今はダミー、将来は Firebase）は gameService から通知される
      let leaving = false;
      cleanups.push(gameService.subscribe(() => {
        const session = gameService.getSession();
        if (session.closed && !leaving) {
          // ホストが退出して部屋が解散した
          leaving = true;
          toast('ホストが部屋を解散しました', 4000);
          gameService.leaveRoom().finally(() => navigate('home'));
          return;
        }
        if (!session.room) return;
        renderRules(root.querySelector('#lobby-rules'), session.settings);
        renderPlayers(root, session);
      }));
      renderPlayers(root, state);
    },

    unmount() {
      for (const fn of cleanups) fn();
      cleanups = [];
    },
  };
})();
