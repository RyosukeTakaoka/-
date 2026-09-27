// 小さな状態管理（購読できるストア）
// Firebase導入後も、同期処理がこのストアを更新するだけで画面が追従する。

export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    getState: () => state,

    /** patch はオブジェクト、または (state) => 新しい部分状態 を返す関数 */
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    },

    /** 変更を購読する。戻り値の関数で解除 */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
