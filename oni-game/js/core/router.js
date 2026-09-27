// 画面遷移
// 各画面は { mount(root, params), unmount() } を持つオブジェクト。

export function createRouter(root) {
  const screens = new Map();
  let current = null;

  const router = {
    register(name, screen) {
      screens.set(name, screen);
    },

    go(name, params = {}) {
      const screen = screens.get(name);
      if (!screen) throw new Error(`画面 "${name}" は登録されていません`);
      current?.screen.unmount?.();
      root.replaceChildren();
      root.dataset.screen = name;
      current = { name, screen };
      // 画面には移動用の navigate 関数を渡す（画面同士が直接 import し合わないように）
      screen.mount(root, { ...params, navigate: router.go });
      window.scrollTo(0, 0);
    },

    get currentName() {
      return current?.name ?? null;
    },
  };
  return router;
}
