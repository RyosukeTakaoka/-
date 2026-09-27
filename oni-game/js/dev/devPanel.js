// 開発用パネル: 視点（どのプレイヤーとして見るか）の切り替え
// 視点を変えても、表示は visibility.js のルールどおり（その人に見えるものだけ）になる。

import { el } from '../utils/dom.js';
import { ROLE_LABEL } from '../game/player.js';

/**
 * @param {{ players: object[], viewerId: string, onChange: (id: string) => void }} props
 */
export function createDevPanel({ players, viewerId, onChange }) {
  const select = el('select', { attrs: { 'aria-label': '視点を切り替え' } });
  const panel = el('div', { className: 'dev-panel' }, [el('span', { text: '🛠 視点' }), select]);
  select.addEventListener('change', () => onChange(select.value));

  let lastKey = '';
  function update(nextPlayers, nextViewerId) {
    // 位置更新のたびに作り直すと開いている選択肢が閉じるので、内容が変わったときだけ更新する
    const key = nextPlayers.map((p) => `${p.id}:${p.role}:${p.status}`).join(',') + `|${nextViewerId}`;
    if (key === lastKey) return;
    lastKey = key;
    select.replaceChildren(
      ...nextPlayers.map((p) =>
        el('option', { text: `${p.name}（${ROLE_LABEL[p.role] ?? '-'}${p.status === 'caught' ? '・脱落' : ''}）`, attrs: { value: p.id } }),
      ),
    );
    select.value = nextViewerId;
  }

  update(players, viewerId);
  return { element: panel, update };
}
