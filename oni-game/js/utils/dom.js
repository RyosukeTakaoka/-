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

// 通知は順番に表示する（同時に複数届いても上書きで消えないように）
const toastQueue = [];
let toastShowing = null;

export function toast(message, ms = 2500) {
  if (toastShowing === message || toastQueue.some((t) => t.message === message)) return;
  toastQueue.push({ message, ms });
  if (toastQueue.length > 4) toastQueue.shift(); // 溜まりすぎたら古いものを捨てる
  if (!toastShowing) showNextToast();
}

function showNextToast() {
  const next = toastQueue.shift();
  let node = document.getElementById('toast');
  if (!next) {
    toastShowing = null;
    node?.classList.remove('show');
    return;
  }
  if (!node) {
    node = el('div', { className: 'toast', attrs: { id: 'toast', role: 'status' } });
    document.body.append(node);
  }
  toastShowing = next.message;
  node.textContent = next.message;
  node.classList.add('show');
  // 後ろに待っている通知があるときは少し短めに切り替える
  setTimeout(showNextToast, toastQueue.length > 0 ? Math.min(next.ms, 2000) : next.ms);
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
