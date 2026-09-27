// ミッションの表示（ゲーム画面の下部パネル）
// 受け取るのは visibility.js のビューだけ。

import { distanceM, formatDistance } from '../../utils/distance.js';
import { formatClock, remainingMs } from '../../game/gameTimer.js';

export const MISSION_PANEL_TEMPLATE = `
<section id="mission-panel" class="mission-panel" hidden>
  <p id="mission-title" class="mission-title"></p>
  <p id="mission-detail" class="mission-detail"></p>
  <p id="mission-safety" class="mission-safety" hidden>⚠ 道路・水辺・私有地など危ない場所や入れない場所なら、向かわずに目的地を変更してください</p>
  <button id="mission-reroll" class="btn btn-small" type="button" hidden>この目的地には行けない（1回だけ変更）</button>
</section>`;

const RESULT_TEXT = {
  success: '✅ ミッション成功！',
  failure: '❌ ミッション失敗…',
  cancelled: 'このミッションは無効になりました',
};

export function renderMissionPanel(root, view, now = Date.now()) {
  const panel = root.querySelector('#mission-panel');
  const shared = view.mission;
  const own = view.self?.mission;
  panel.hidden = !shared;
  if (!shared) return;

  const left = formatClock(remainingMs(shared.endsAt, now));
  const title = root.querySelector('#mission-title');
  const detail = root.querySelector('#mission-detail');
  const reroll = root.querySelector('#mission-reroll');
  const safety = root.querySelector('#mission-safety');
  panel.classList.toggle('mine', Boolean(own));

  if (own?.result === 'pending' && own.destination) {
    title.textContent = `🎯 ミッション ${shared.index}/${shared.total}　残り ${left}`;
    const pos = view.self.position;
    const dist = pos ? `（あと約${formatDistance(distanceM(pos, own.destination))}）` : '';
    detail.textContent = `制限時間内に目的地（🎯・半径${own.arrivalRadiusM}m）へ到達せよ${dist}`;
    safety.hidden = false;
    reroll.hidden = !own.canReroll;
  } else if (own) {
    title.textContent = `ミッション ${shared.index}/${shared.total}　残り ${left}`;
    detail.textContent = RESULT_TEXT[own.result] ?? '';
    safety.hidden = true;
    reroll.hidden = true;
  } else {
    title.textContent = `⚠ ミッション ${shared.index}/${shared.total} 発生中　残り ${left}`;
    detail.textContent = '逃走者が目的地へ向かっています（目的地は鬼には分かりません）';
    safety.hidden = true;
    reroll.hidden = true;
  }
}
