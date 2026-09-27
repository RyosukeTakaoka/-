// ゲーム用の円・マーカーの見た目
// 「何をどう描くか」をここにまとめ、ボードの実装（Google / 簡易）とは切り離す。

import { ROLE } from '../game/player.js';

export const CIRCLE_STYLE = Object.freeze({
  area: { stroke: '#ef4444', fill: '#ef4444', fillOpacity: 0.06, strokeWidth: 3 },
  preview: { stroke: '#f59e0b', fill: '#f59e0b', fillOpacity: 0.08, strokeWidth: 2 },
});

function pin(className, emoji, label) {
  const wrap = document.createElement('div');
  wrap.className = `pin ${className}`;
  const icon = document.createElement('div');
  icon.className = 'pin-icon';
  icon.textContent = emoji;
  wrap.append(icon);
  if (label) {
    const text = document.createElement('div');
    text.className = 'pin-label';
    text.textContent = label; // 名前は textContent で入れる（HTMLとして解釈させない）
    wrap.append(text);
  }
  return wrap;
}

export function addStartMarker(board, position) {
  return board.addMarker({ position, element: pin('pin-start', '🚩', 'スタート'), title: 'ゲーム開始地点' });
}

export function addAreaCircle(board, area, style = CIRCLE_STYLE.area) {
  return board.addCircle({ center: area.center, radiusM: area.radiusM, style });
}

/** プレイヤーのマーカー。isSelf なら強調表示 */
export function addPlayerMarker(board, player, { isSelf = false } = {}) {
  const hunter = player.role === ROLE.HUNTER;
  const className = `${hunter ? 'pin-hunter' : 'pin-runner'}${isSelf ? ' pin-self' : ''}`;
  const label = isSelf ? `${player.name}（あなた）` : player.name;
  return board.addMarker({
    position: player.position,
    element: pin(className, hunter ? '👹' : '🏃', label),
    title: label,
  });
}
