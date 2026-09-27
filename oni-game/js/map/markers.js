// ゲーム用の円・マーカーの見た目
// 「何をどう描くか」をここにまとめ、ボードの実装（Google / 簡易）とは切り離す。

import { ROLE, STATUS } from '../game/player.js';

export const CIRCLE_STYLE = Object.freeze({
  area: { stroke: '#ef4444', fill: '#ef4444', fillOpacity: 0.06, strokeWidth: 3 },
  preview: { stroke: '#f59e0b', fill: '#f59e0b', fillOpacity: 0.08, strokeWidth: 2 },
  capture: { stroke: '#fca5a5', fill: '#ef4444', fillOpacity: 0.15, strokeWidth: 1 },
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

/** プレイヤーの見た目のキー（役割や状態が変わったらマーカーを作り直すため） */
export function playerPinKey(player, isSelf) {
  return `${player.role}|${player.status}|${isSelf}|${player.name}`;
}

/**
 * プレイヤーのマーカー。
 * position は必ず visibility.js のビューから受け取った「表示してよい位置」を渡すこと。
 */
export function addPlayerMarker(board, player, position, { isSelf = false } = {}) {
  const hunter = player.role === ROLE.HUNTER;
  const out = player.status === STATUS.CAUGHT;
  const className = `${out ? 'pin-caught' : hunter ? 'pin-hunter' : 'pin-runner'}${isSelf ? ' pin-self' : ''}`;
  const label = isSelf ? `${player.name}（あなた）` : player.name;
  return board.addMarker({
    position,
    element: pin(className, out ? '⛓' : hunter ? '👹' : '🏃', label),
    title: label,
  });
}
