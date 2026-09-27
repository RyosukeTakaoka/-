// 端末内モードの gameService（今までどおり、1台の端末の中でゲームを動かす）
//
// gameState.js（端末内のストア + gameEngine）と LocalRoomService（ダミーの部屋）を使う。
// Firebase 版（STEP 7-B 以降の firebase/）は同じメソッドを持つ別の実装にする。

import * as game from '../game/gameState.js';
import { resultViewFor } from '../game/resultSummary.js';
import { createInitialPositions } from '../dev/dummyData.js';
import { roomService } from './roomService.js';

/** ロビー・作成画面で使う情報（位置情報・秘密値・ミッション予定は含めない） */
export function toSession(state) {
  return {
    phase: state.phase,
    room: state.room,
    selfId: state.selfId,
    isHost: Boolean(state.room && state.room.hostId === state.selfId),
    settings: state.settings,
    startPoint: state.startPoint,
    area: state.area,
    exclusionZones: state.exclusionZones,
    players: state.players.map(({ id, name, isHost, isDummy }) => ({ id, name, isHost, isDummy })),
    hasResult: Boolean(state.resultSummary),
  };
}

export function createLocalGameService() {
  // ダミーの部屋の参加者の変化を、ゲームの状態に反映する
  roomService.onPlayersChanged((players) => {
    if (game.gameStore.getState().room) game.setPlayers(players);
  });

  const selfId = () => game.gameStore.getState().selfId;

  return {
    mode: 'local',

    // ---- 読み取り ----
    getSession: () => toSession(game.gameStore.getState()),
    subscribe: (listener) => game.gameStore.subscribe(() => listener()),
    /** viewerId の人のビュー（端末内モードの開発用視点切り替えのため viewerId を受け取る） */
    getView: (viewerId = selfId(), now = Date.now()) => game.getPlayerView(viewerId, now),
    getResultView: (viewerId = selfId()) => resultViewFor(game.gameStore.getState().resultSummary, viewerId),

    // ---- ルーム ----
    async createRoom({ hostName }) {
      game.enterLobby(await roomService.createRoom({ hostName }));
    },
    async joinRoom({ code, name }) {
      game.enterLobby(await roomService.joinRoom({ code, name }));
    },
    addDummyPlayer: () => roomService.addDummyPlayer(),
    async leaveRoom() {
      await roomService.leaveRoom();
      game.resetGame();
    },

    // ---- 作成・ロビー ----
    resetGame: () => game.resetGame(),
    updateSettings: (input) => game.updateSettings(input),
    setStartPoint: (point) => game.setStartPoint(point),
    addExclusionZone: (point) => game.addExclusionZone(point),
    clearExclusionZones: () => game.clearExclusionZones(),
    returnToLobby: () => game.returnToLobby(),
    prepareRematch: () => game.prepareRematch(),
    startGame() {
      const s = game.gameStore.getState();
      // 端末内モード: ダミーはエリア内に仮配置、自分は GPS が届くまで開始地点にいるものとする
      game.startGame({ initialPositions: createInitialPositions(s.players, s.area) });
    },

    // ---- ゲーム中 ----
    /** 位置の送信（端末内モードは開発用に他のプレイヤーの位置も動かせる） */
    reportPosition: (playerId, pos) => game.updatePosition(playerId, pos),
    requestCapture: (hunterId = selfId()) => game.requestCapture(hunterId),
    requestNewDestination: (runnerId = selfId()) => game.requestNewDestination(runnerId),
    abortGame: () => game.abortGame(),
    /** 時間を進める（端末内モードだけ。Firebase 版ではサーバーが進めるので何もしない） */
    tick: () => game.tickGame(),
  };
}
