// アプリの入口: 画面を登録して起動する

import { createRouter } from './core/router.js';
import { loadConfig } from './core/config.js';
import { initGameService } from './services/gameService.js';
import { isDevMode } from './dev/devMode.js';
import { toast } from './utils/dom.js';
import { homeScreen } from './screens/home.js';
import { createScreen } from './screens/create.js';
import { lobbyScreen } from './screens/lobby.js';
import { gameScreen } from './screens/game.js';
import { resultScreen } from './screens/result.js';

const router = createRouter(document.getElementById('app'));
router.register('home', homeScreen);
router.register('create', createScreen);
router.register('lobby', lobbyScreen);
router.register('game', gameScreen);
router.register('result', resultScreen);
// 使うバックエンド（端末内 / Firebase）を決めてから画面を出す
const config = await loadConfig();
const backendOverride = new URLSearchParams(location.search).get('backend');
try {
  await initGameService(config, { devMode: isDevMode, backendOverride });
} catch (err) {
  console.error(err);
  toast(`オンライン接続に失敗したため、端末内モードで起動します（${err.message}）`, 5000);
}
router.go('home');
