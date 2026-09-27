// ゲーム用の円・マーカーの見た目
// 「何をどう描くか」をここにまとめ、ボードの実装（Google / 簡易）とは切り離す。

import { ROLE, STATUS } from '../game/player.js';

export const CIRCLE_STYLE = Object.freeze({
  area: { stroke: '#ef4444', fill: '#ef4444', fillOpacity: 0.06, strokeWidth: 3 },
  preview: { stroke: '#f59e0b', fill: '#f59e0b', fillOpacity: 0.08, strokeWidth: 2 },
  capture: { stroke: '#fca5a5', fill: '#ef4444', fillOpacity: 0.15, strokeWidth: 1 },
  possibleArea: { stroke: '#a855f7', fill: '#a855f7', fillOpacity: 0.18, strokeWidth: 2 }, // 鬼から見た逃走者
  ownPossibleArea: { stroke: '#60a5fa', fill: '#60a5fa', fillOpacity: 0.08, strokeWidth: 1 }, // 自分が鬼にどう見えているか
  destination: { stroke: '#22c55e', fill: '#22c55e', fillOpacity: 0.25, strokeWidth: 2 }, // ミッション目的地の到達範囲
  exclusion: { stroke: '#9ca3af', fill: '#6b7280', fillOpacity: 0.35, strokeWidth: 1 }, // 目的地の除外エリア
});

export function addDestinationMarker(board, destination) {
  return board.addMarker({ position: destination, element: pin('pin-destination', '🎯', destination.label ?? '目的地'), title: 'ミッション目的地' });
}

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

/**
 * 可能性エリアのラベル（❓）。円の中心に置くと「中心にいる」と誤解されるため、円の北端に置く。
 */
export function addPossibleAreaLabel(board, position, text) {
  const element = pin('pin-possible', '❓', text);
  return board.addMarker({ position, element, title: text });
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
