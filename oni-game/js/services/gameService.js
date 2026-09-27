// 画面とゲームの間の窓口
//
// 画面（screens/）はゲームの状態（gameState・gameEngine）や Firebase を直接触らず、ここだけを使う。
//   - 読み取り: getSession()（ロビー情報）/ getView()（その人に見せてよいビュー）/ getResultView()
//   - 操作: すべて「要求」。最終的な判定は実装側（端末内なら gameEngine、Firebase 版ならサーバー）が行う
//
// インターフェース（端末内モード・Firebase 版で共通）
//   getSession() -> { phase, room, selfId, isHost, settings, startPoint, area, exclusionZones, players, hasResult }
//   subscribe(listener) -> 解除関数
//   getView(viewerId?, now?) -> visibility.buildPlayerView と同じ形
//   getResultView(viewerId?) -> resultSummary.resultViewFor の結果
//   createRoom({ hostName }) / joinRoom({ code, name }) / addDummyPlayer() / leaveRoom()
//   resetGame() / updateSettings(input) / setStartPoint(point) / addExclusionZone(point) / clearExclusionZones()
//   returnToLobby() / prepareRematch() / startGame()
//   reportPosition(playerId, pos) / requestCapture(hunterId?) / requestNewDestination(runnerId?) / abortGame()
//   tick()
//
// STEP 7-B 以降: 設定に応じて Firebase 版の実装に切り替える（画面は変更しない）。

import { createLocalGameService } from './localGameService.js';

export const gameService = createLocalGameService();
