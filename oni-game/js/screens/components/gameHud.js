// ゲーム画面のHUD（役割・残り時間・人数・警告・確保ボタン・決着パネル）
// 受け取るのは visibility.js のビューだけ。

import { ROLE, ROLE_LABEL, STATUS } from '../../game/player.js';
import { WINNER, FINISH_REASON } from '../../game/outcome.js';
import { formatClock, remainingMs } from '../../game/gameTimer.js';

export const HUD_TEMPLATE = `
<header class="hud">
  <div id="hud-role" class="role-badge"></div>
  <div id="hud-timer" class="hud-timer">--:--</div>
  <div id="hud-counts" class="hud-counts"></div>
</header>
<div class="game-banners">
  <p id="banner-area" class="banner banner-warn" hidden>⚠ ゲームエリアの外にいます。エリア内に戻ってください</p>
  <p id="banner-status" class="banner" hidden></p>
  <p id="banner-gps" class="banner" hidden>📡 位置情報を取得しています…</p>
</div>
<button id="btn-capture" class="btn btn-primary btn-capture" type="button" hidden>🫳 確保！</button>
<div id="finish-panel" class="finish-panel" hidden>
  <p id="finish-title" class="finish-title"></p>
  <p id="finish-reason" class="muted"></p>
  <p id="finish-self" class="finish-self"></p>
  <button id="finish-home" class="btn btn-primary" type="button">ホームに戻る</button>
</div>`;

function roleText(self) {
  if (!self?.role) return '-';
  if (self.status === STATUS.CAUGHT) return '⛓ 脱落';
  return `${self.role === ROLE.HUNTER ? '👹' : '🏃'} ${ROLE_LABEL[self.role]}`;
}

/** 毎秒以下の頻度で呼ぶ部分（時計・確保ボタンのクールダウン） */
export function renderClock(root, view, now = Date.now()) {
  const timer = root.querySelector('#hud-timer');
  const left = view.phase === 'playing' ? remainingMs(view.endsAt, now) : 0;
  timer.textContent = formatClock(left);
  timer.classList.toggle('danger', view.phase === 'playing' && left < 60_000);

  const button = root.querySelector('#btn-capture');
  const waitMs = (view.self?.captureReadyAt ?? 0) - now;
  button.disabled = waitMs > 0 || !view.self?.position;
  button.textContent = waitMs > 0 ? `🫳 確保（あと${Math.ceil(waitMs / 1000)}秒）` : '🫳 確保！';
}

export function renderHud(root, view) {
  const { self } = view;
  const badge = root.querySelector('#hud-role');
  badge.textContent = roleText(self);
  badge.className = `role-badge ${self?.status === STATUS.CAUGHT ? 'caught' : (self?.role ?? '')}`;
  root.querySelector('#hud-counts').textContent = `逃走者 残り ${view.runnersRemaining}/${view.runnersTotal}`;

  const playing = view.phase === 'playing';
  root.querySelector('#banner-area').hidden = !(playing && self?.outOfArea);
  root.querySelector('#banner-gps').hidden = !(playing && self && !self.position);

  const status = root.querySelector('#banner-status');
  if (playing && self?.status === STATUS.CAUGHT) {
    status.hidden = false;
    status.textContent = '確保されました。観戦中です（逃走者の位置は表示されません）';
  } else if (playing && self?.originalRole === ROLE.RUNNER && self.role === ROLE.HUNTER) {
    status.hidden = false;
    status.textContent = '確保されて鬼になりました。逃走者を捕まえよう！';
  } else {
    status.hidden = true;
  }

  const canCapture = playing && self?.role === ROLE.HUNTER && self.status === STATUS.ACTIVE;
  root.querySelector('#btn-capture').hidden = !canCapture;

  renderFinish(root, view);
  renderClock(root, view);
}

function renderFinish(root, view) {
  const panel = root.querySelector('#finish-panel');
  panel.hidden = view.phase !== 'finished';
  if (panel.hidden || !view.result) return;
  const { winner, reason } = view.result;
  root.querySelector('#finish-title').textContent =
    winner === WINNER.HUNTERS ? '👹 鬼の勝ち！' : winner === WINNER.RUNNERS ? '🏃 逃走者の勝ち！' : 'ゲーム終了';
  root.querySelector('#finish-reason').textContent = {
    [FINISH_REASON.TIME_UP]: '制限時間まで逃げ切りました',
    [FINISH_REASON.ALL_CAUGHT]: '逃走者が全員確保されました',
    [FINISH_REASON.ABORTED]: 'ホストがゲームを終了しました',
  }[reason];
  const self = view.self;
  const side = self?.role === ROLE.HUNTER ? WINNER.HUNTERS : WINNER.RUNNERS;
  root.querySelector('#finish-self').textContent = !winner
    ? ''
    : side === winner
      ? 'あなたの陣営の勝利！'
      : 'あなたの陣営の負け…';
}
