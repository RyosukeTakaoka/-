// Firebase JS SDK の読み込み口（ブラウザ用）
// SDK はここだけで読み込む。ほかのファイルはこのモジュール経由で使う（テストではここを差し替える）。
// ビルド不要で使えるよう、公式の ESM 配布（gstatic）から読み込む。
// バージョンは開発用の npm パッケージ（package.json の firebase）と合わせる。

export { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
export {
  getAuth, connectAuthEmulator, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
export {
  getDatabase, connectDatabaseEmulator, ref, onValue, set, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
export {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
