// DOM操作の小さなヘルパー

/** HTML文字列から要素を作る（固定のテンプレート専用。ユーザー入力は入れないこと） */
export function fromHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content;
}

/** 要素を作る。text はテキストとして入るので安全 */
export function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

let toastTimer = null;
export function toast(message, ms = 2500) {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { className: 'toast', attrs: { id: 'toast', role: 'status' } });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

/** 保存できない環境（プライベートモード等）でも落ちない localStorage */
export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 保存できなくても続行 */
    }
  },
};
