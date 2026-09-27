// 選択肢ボタン（セグメント）の部品

import { el } from '../../utils/dom.js';

/**
 * @param {{ options: any[], value: any, format: (v:any)=>string, onChange: (v:any)=>void, label: string }} props
 */
export function createOptionGroup({ options, value, format, onChange, label }) {
  const group = el('div', { className: 'option-group', attrs: { role: 'radiogroup', 'aria-label': label } });
  const buttons = options.map((option) => {
    const button = el('button', {
      className: 'option',
      text: format(option),
      attrs: { type: 'button', role: 'radio' },
    });
    button.addEventListener('click', () => {
      select(option);
      onChange(option);
    });
    return { option, button };
  });

  function select(v) {
    for (const { option, button } of buttons) {
      const on = option === v;
      button.classList.toggle('selected', on);
      button.setAttribute('aria-checked', String(on));
    }
  }

  group.append(...buttons.map((b) => b.button));
  select(value);
  return group;
}
