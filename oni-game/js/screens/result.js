// 結果画面
// 表示に使うのは resultSummary（resultViewFor で本人向けに絞ったもの）だけ。
// 位置情報（実位置・可能性エリア・目的地）は扱わない。

import { el, fromHtml, clearToasts } from '../utils/dom.js';
import { gameStore, prepareRematch, resetGame } from '../game/gameState.js';
import { resultViewFor, MISSION_SUMMARY_STATUS, PERSONAL_RESULT } from '../game/resultSummary.js';
import { ROLE_LABEL } from '../game/player.js';
import { WINNER } from '../game/outcome.js';
import { formatClock } from '../game/gameTimer.js';
import { roomService } from '../services/roomService.js';

const TEMPLATE = `
<div class="screen result">
  <header class="result-hero">
    <p id="result-emoji" class="result-emoji" aria-hidden="true"></p>
    <h1 id="result-headline"></h1>
    <p id="result-you" class="result-you"></p>
    <p id="result-meta" class="muted"></p>
  </header>

  <section class="card">
    <h3>プレイヤー</h3>
    <ul id="result-players" class="result-players"></ul>
  </section>

  <section class="card">
    <h3>ミッション</h3>
    <p class="hint">全員の結果は人数だけを表示します（あなた自身の結果は「あなた」の列）</p>
    <table class="result-missions">
      <thead><tr><th></th><th>成功</th><th>失敗</th><th>無効</th><th>あなた</th></tr></thead>
      <tbody id="result-missions"></tbody>
    </table>
  </section>

  <button id="result-again" class="btn btn-primary" type="button">もう一度遊ぶ</button>
  <p id="result-again-hint" class="hint center">同じメンバー・同じ設定でロビーに戻ります（開始地点は設定し直します）</p>
  <button id="result-home" class="btn" type="button">ホームに戻る</button>
</div>`;

const PERSONAL_TEXT = {
  [PERSONAL_RESULT.SUCCESS]: '✅ 成功',
  [PERSONAL_RESULT.FAILURE]: '❌ 失敗',
  [PERSONAL_RESULT.CANCELLED]: '無効',
  [PERSONAL_RESULT.NOT_PARTICIPATED]: '－',
};

const MISSION_STATUS_NOTE = {
  [MISSION_SUMMARY_STATUS.ENDED_BY_GAME_OVER]: '（ゲーム終了で打ち切り）',
  [MISSION_SUMMARY_STATUS.NOT_HELD]: '（発生前に終了）',
  [MISSION_SUMMARY_STATUS.SKIPPED]: '（無効）',
};

function roleText(p) {
  const start = ROLE_LABEL[p.startRole] ?? '-';
  return p.roleChanged ? `${start} → ${ROLE_LABEL[p.finalRole]}` : start;
}

function playerStatus(p, zombieMode) {
  if (p.startRole === 'hunter') return `確保 ${p.captures}人`;
  if (p.survived) return '🏃 逃げ切り';
  const when = p.caughtAfterMin != null ? `開始${p.caughtAfterMin}分台に` : '';
  const after = zombieMode ? `（鬼として確保 ${p.captures}人）` : '';
  return `⛓ ${when}確保${after}`;
}

function renderPlayers(list, view) {
  // 鬼 → 逃げ切った逃走者 → 確保された逃走者 の順
  const order = (p) => (p.startRole === 'hunter' ? 0 : p.survived ? 1 : 2);
  const players = [...view.players].sort((a, b) => order(a) - order(b) || b.captures - a.captures);
  list.replaceChildren(
    ...players.map((p) =>
      el('li', { className: p.id === view.you ? 'is-you' : '' }, [
        el('span', { className: 'result-name', text: `${p.name}${p.id === view.you ? '（あなた）' : ''}` }),
        el('span', { className: `result-role ${p.finalRole}`, text: roleText(p) }),
        el('span', { className: 'result-status', text: playerStatus(p, view.zombieMode) }),
      ]),
    ),
  );
}

function renderMissions(tbody, view) {
  tbody.replaceChildren(
    ...view.missions.map((m) => {
      const own = view.self?.missions.find((x) => x.index === m.index)?.result ?? PERSONAL_RESULT.NOT_PARTICIPATED;
      const held = m.status !== MISSION_SUMMARY_STATUS.NOT_HELD;
      return el('tr', {}, [
        el('th', {}, [
          el('span', { text: `第${m.index}ミッション` }),
          ...(MISSION_STATUS_NOTE[m.status] ? [el('small', { className: 'mission-note', text: MISSION_STATUS_NOTE[m.status] })] : []),
        ]),
        el('td', { text: held ? `${m.success}人` : '－' }),
        el('td', { text: held ? `${m.failure}人` : '－' }),
        el('td', { text: held ? `${m.cancelled}人` : '－' }),
        el('td', { text: PERSONAL_TEXT[own] }),
      ]);
    }),
  );
}

export const resultScreen = {
  mount(root, { navigate, viewerId }) {
    clearToasts(); // ゲーム中の通知を結果画面に持ち込まない
    root.append(fromHtml(TEMPLATE));
    const state = gameStore.getState();
    const view = resultViewFor(state.resultSummary, viewerId ?? state.selfId);
    if (!view) {
      navigate('home');
      return;
    }

    root.querySelector('#result-emoji').textContent =
      view.winner === WINNER.HUNTERS ? '👹' : view.winner === WINNER.RUNNERS ? '🏃' : '🏁';
    root.querySelector('#result-headline').textContent = view.headline;
    const me = view.players.find((p) => p.id === view.you);
    const mySide = me?.finalRole === 'hunter' ? WINNER.HUNTERS : WINNER.RUNNERS;
    root.querySelector('#result-you').textContent =
      !view.winner || !me ? '' : mySide === view.winner ? 'あなたの陣営の勝利！' : 'あなたの陣営の負け…';
    root.querySelector('#result-meta').textContent =
      `プレイ時間 ${formatClock(view.playedMs)} / 設定 ${view.durationMin}分${view.zombieMode ? '・増え鬼' : ''}`;
    renderPlayers(root.querySelector('#result-players'), view);
    renderMissions(root.querySelector('#result-missions'), view);

    const isHost = state.room?.hostId === state.selfId;
    root.querySelector('#result-again').hidden = !isHost;
    root.querySelector('#result-again-hint').textContent = isHost
      ? '同じメンバー・同じ設定でロビーに戻ります（開始地点は設定し直します）'
      : 'ホストが「もう一度遊ぶ」を選ぶのを待っています';
    root.querySelector('#result-again').addEventListener('click', () => {
      prepareRematch();
      navigate('create', { rematch: true });
    });
    root.querySelector('#result-home').addEventListener('click', async () => {
      await roomService.leaveRoom();
      resetGame();
      navigate('home');
    });
  },
};
