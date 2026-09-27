// アプリの入口: 画面を登録して起動する

import { createRouter } from './core/router.js';
import { homeScreen } from './screens/home.js';
import { createScreen } from './screens/create.js';
import { lobbyScreen } from './screens/lobby.js';
import { gameScreen } from './screens/game.js';

const router = createRouter(document.getElementById('app'));
router.register('home', homeScreen);
router.register('create', createScreen);
router.register('lobby', lobbyScreen);
router.register('game', gameScreen);
router.go('home');
