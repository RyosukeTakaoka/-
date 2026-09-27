// 開発モード（URL に ?dev を付けると有効）
// 地図タップで位置を動かす・視点の切り替えなど、1台で動作確認するための機能を出す。

export const isDevMode = new URLSearchParams(globalThis.location?.search ?? '').has('dev');
