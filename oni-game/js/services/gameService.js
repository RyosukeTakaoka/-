// 画面とゲームの間の窓口
//
// 画面（screens/）はゲームの状態（gameState・gameEngine）や Firebase を直接触らず、ここだけを使う。
//   - 読み取り: getSession()（ロビー情報）/ getView()（その人に見せてよいビュー）/ getResultView()
//   - 操作: すべて「要求」。最終的な判定は実装側（端末内なら gameEngine、Firebase 版ならサーバー）が行う
//
// インターフェース（端末内モード・Firebase 版で共通）
//   mode: 'local' | 'firebase'
//   getSession() -> { phase, room, selfId, isHost, settings, startPoint, area, exclusionZones, players, hasResult, closed }
//   subscribe(listener) -> 解除関数
//   getView(viewerId?, now?) -> visibility.buildPlayerView と同じ形
//   getResultView(viewerId?) -> resultSummary.resultViewFor の結果
//   createRoom({ hostName }) / joinRoom({ code, name }) / addDummyPlayer() / leaveRoom()
//   resetGame() / updateSettings(input) / setStartPoint(point) / addExclusionZone(point) / clearExclusionZones()
//   returnToLobby() / prepareRematch() / startGame()
//   reportPosition(playerId, pos) / requestCapture(hunterId?) / requestNewDestination(runnerId?) / abortGame()
//   tick()
//
// どちらの実装を使うかは initGameService() で決める（画面は変更しない）。
//   - 開発モード（?dev）は常に端末内モード
//   - それ以外は config.backend（'local' | 'firebase'）。URL の ?backend=firebase / ?backend=local で上書きできる
// Firebase 版は必要なときだけ読み込む（端末内モードでは Firebase SDK を読み込まない）。

import { createLocalGameService } from './localGameService.js';

export let gameService = createLocalGameService();

export async function initGameService(config, { devMode = false, backendOverride = null } = {}) {
  const backend = devMode ? 'local' : (backendOverride ?? config.backend ?? 'local');
  if (backend === 'firebase') {
    const { createFirebaseGameService } = await import('./firebaseGameService.js');
    gameService = await createFirebaseGameService(config.firebase);
  }
  return gameService.mode;
}
