// ゲーム全体の状態と、状態を変える操作（アクション）
// 画面(screens)はここの関数を呼ぶだけにして、ルールは game/ の各ファイルにまとめる。
//
// 状態の中の「実位置」は positions にだけ持つ（Player には持たせない）。
// 画面は positions を直接読まず、getPlayerView() の結果だけを使う。

import { createStore } from '../core/store.js';
import { isValidLatLng } from '../utils/distance.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings.js';
import { createGameArea } from './gameArea.js';
import { preparePlayersForGame, ROLE } from './player.js';
import { attemptCapture, CAPTURE_FAILURE } from './capture.js';
import { judgeOutcome, FINISH_REASON } from './outcome.js';
import { buildPlayerView } from './visibility.js';
import { emptyPrivacy, initPrivacy, publishIfDue, publishMissing, withdraw } from './locationPublisher.js';
import { generateMissionSchedule } from './missionSchedule.js';
import {
  emptyMissionState, createMissionState, advanceMissions, checkArrivals, withdrawParticipant, cancelMissions,
  rerollDestination, summarizeResults,
} from './mission.js';

export const PHASE = Object.freeze({
  SETUP: 'setup', // ゲーム作成・設定中
  LOBBY: 'lobby', // ルームで友達を待っている
  PLAYING: 'playing', // ゲーム中
  FINISHED: 'finished', // 決着
});

const MAX_LOG = 50;

export function initialState() {
  return {
    phase: PHASE.SETUP,
    settings: { ...DEFAULT_SETTINGS },
    startPoint: null, // ゲーム開始地点 { lat, lng }
    area: null, // { center, radiusM }
    exclusionZones: [], // ホストが設定した目的地の除外エリア [{ center, radiusM }]（道路・水辺・立入禁止など）
    room: null, // { code, hostId }
    selfId: null, // この端末のプレイヤーID
    players: [],
    positions: {}, // 実位置 { [playerId]: { lat, lng, accuracyM, updatedAt } }（ゲーム中のみ）
    privacy: emptyPrivacy(), // 可能性エリアの内部状態（秘密の値・公開済みエリア）。ビューには published だけが出る
    captureAttempts: {}, // { [hunterId]: 最後に確保操作した時刻 }
    missions: emptyMissionState(), // ミッション（発生時刻・目的地は内部のみ）
    startedAt: null,
    endsAt: null,
    result: null, // { winner, reason, finishedAt }
    log: [], // [{ id, at, type, text, playerId }] 位置情報は含めない
  };
}

export const gameStore = createStore(initialState());

// ---- 作成・ロビー ----

export function resetGame() {
  gameStore.setState(initialState());
}

export function updateSettings(input) {
  gameStore.setState((s) => {
    const settings = sanitizeSettings(input, s.settings);
    return {
      settings,
      area: s.startPoint ? createGameArea(s.startPoint, settings.radiusM) : null,
    };
  });
}

export function setStartPoint(point) {
  gameStore.setState((s) => ({
    startPoint: { lat: point.lat, lng: point.lng },
    area: createGameArea(point, s.settings.radiusM),
  }));
}

export const EXCLUSION_RADIUS_M = 30;

/** 目的地にしない場所（道路・水辺・立入禁止など）を追加する */
export function addExclusionZone(point, radiusM = EXCLUSION_RADIUS_M) {
  if (!isValidLatLng(point)) return;
  gameStore.setState((s) => ({ exclusionZones: [...s.exclusionZones, { center: { lat: point.lat, lng: point.lng }, radiusM }] }));
}

export function clearExclusionZones() {
  gameStore.setState({ exclusionZones: [] });
}

export function enterLobby({ room, selfId, players }) {
  gameStore.setState({ phase: PHASE.LOBBY, room, selfId, players });
}

export function setPlayers(players) {
  gameStore.setState({ players });
}

// ---- ゲーム進行 ----

/**
 * ゲーム開始。役割をランダムに決め、開始時刻と終了時刻を記録する。
 * initialPositions: 開始時点で分かっている実位置（ダミー配置など）
 */
export function startGame({
  now = Date.now(), rng = Math.random, privacyRng, missionRng, initialPositions = {},
} = {}) {
  const s = gameStore.getState();
  if (s.phase !== PHASE.LOBBY) throw new Error('ロビーからのみ開始できます');
  if (!s.area) throw new Error('ゲーム開始地点が設定されていません');
  const players = preparePlayersForGame(s.players, s.settings, rng);
  const durationMs = s.settings.durationMin * 60 * 1000;
  const missions = createMissionState(generateMissionSchedule(durationMs, missionRng), now);
  const positions = {};
  for (const [id, pos] of Object.entries(initialPositions)) {
    if (isValidLatLng(pos)) positions[id] = { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM ?? null, updatedAt: now };
  }
  const hunterNames = players.filter((p) => p.role === ROLE.HUNTER).map((p) => p.name);
  gameStore.setState({
    phase: PHASE.PLAYING,
    players,
    positions,
    privacy: initPrivacy(players, privacyRng),
    captureAttempts: {},
    missions,
    startedAt: now,
    endsAt: now + durationMs,
    result: null,
    log: [],
  });
  addLog(now, 'start', `ゲーム開始！ 鬼は ${hunterNames.join('、')}`);
  gameStore.setState((st) => ({ privacy: publishIfDue(st, now).privacy })); // 最初の公開
}

/** 実位置の更新（GPS・ダミー）。ゲーム中以外は保持しない */
export function updatePosition(playerId, pos, now = Date.now()) {
  const s = gameStore.getState();
  if (s.phase !== PHASE.PLAYING || !isValidLatLng(pos)) return;
  if (!s.players.some((p) => p.id === playerId)) return;
  gameStore.setState({
    positions: {
      ...s.positions,
      [playerId]: { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM ?? null, updatedAt: now },
    },
  });
  // ミッションの到達判定（実位置で判定。結果以外の情報は外に出さない）
  const current = gameStore.getState();
  if (current.missions.active) {
    const missions = checkArrivals(current.missions, current.positions, now);
    if (missions !== current.missions) gameStore.setState({ missions });
  }
  // 公開済みの可能性エリアは変えない。まだ一度も公開されていない逃走者だけ公開する
  const next = gameStore.getState();
  if (!next.privacy.published[playerId]) {
    const privacy = publishMissing(next, now);
    if (privacy !== next.privacy) gameStore.setState({ privacy });
  }
}

/**
 * 鬼の確保操作。
 * @returns {{ ok: boolean, reason?: string, capturedId?: string }} 座標や距離は返さない
 */
export function requestCapture(hunterId, now = Date.now()) {
  const s = gameStore.getState();
  const result = attemptCapture(s, hunterId, now);
  // 実際に判定まで進んだ操作だけクールダウンの起点にする
  const judged = result.ok || result.reason === CAPTURE_FAILURE.NO_TARGET;
  if (judged) {
    gameStore.setState({ captureAttempts: { ...s.captureAttempts, [hunterId]: now } });
  }
  if (!result.ok) return { ok: false, reason: result.reason };

  gameStore.setState({
    players: result.players,
    privacy: withdraw(s.privacy, result.capturedId),
    missions: withdrawParticipant(s.missions, result.capturedId, now),
  });
  const hunter = result.players.find((p) => p.id === hunterId);
  const caught = result.players.find((p) => p.id === result.capturedId);
  const suffix = s.settings.zombieMode ? `${caught.name} は鬼になった！` : `${caught.name} は脱落`;
  addLog(now, 'capture', `${hunter.name} が ${caught.name} を確保！ ${suffix}`, caught.id);
  checkOutcome(now);
  return { ok: true, capturedId: result.capturedId };
}

/** 定期的に呼ぶ（時間切れの判定・可能性エリアの公開） */
export function tickGame(now = Date.now()) {
  if (gameStore.getState().phase !== PHASE.PLAYING) return;
  checkOutcome(now);
  if (gameStore.getState().phase !== PHASE.PLAYING) return; // 決着したらミッション・公開は進めない
  progressMissions(now);
  const s = gameStore.getState();
  const { privacy, revealed } = publishIfDue(s, now);
  if (revealed) {
    gameStore.setState({ privacy });
    addLog(now, 'reveal', '逃走者の可能性エリアが更新されました');
  }
}

let missionRandom = Math.random;
/** テスト用: 目的地生成に使う乱数を差し替える */
export function setMissionRandom(rng) {
  missionRandom = rng;
}

function progressMissions(now) {
  const s = gameStore.getState();
  const { missions, players, events } = advanceMissions(s, now, missionRandom);
  if (missions === s.missions && players === s.players) return;
  gameStore.setState({ missions, players });
  for (const e of events) {
    if (e.type === 'mission_start') {
      addLog(now, 'mission_start', `ミッション${e.index}発生！ 逃走者は制限時間内に目的地へ向かえ`);
    } else if (e.type === 'mission_end') {
      const c = summarizeResults(e.results);
      addLog(now, 'mission_end', `ミッション${e.index}終了：成功 ${c.success}人・失敗 ${c.failure}人`);
    }
  }
}

/** 目的地が行けない場所だったとき、1回だけ変更する */
export function requestNewDestination(runnerId, now = Date.now()) {
  const s = gameStore.getState();
  if (s.phase !== PHASE.PLAYING) return { ok: false, reason: 'not_playing' };
  const result = rerollDestination(s, runnerId, now, missionRandom);
  if (!result.ok) return { ok: false, reason: result.reason };
  gameStore.setState({ missions: result.missions });
  return { ok: true };
}

/** ホストによる途中終了 */
export function abortGame(now = Date.now()) {
  if (gameStore.getState().phase !== PHASE.PLAYING) return;
  finish({ winner: null, reason: FINISH_REASON.ABORTED }, now);
}

function checkOutcome(now) {
  const outcome = judgeOutcome(gameStore.getState(), now);
  if (outcome) finish(outcome, now);
}

function finish({ winner, reason }, now) {
  const s = gameStore.getState();
  gameStore.setState({
    phase: PHASE.FINISHED,
    endsAt: Math.min(s.endsAt, now),
    result: { winner, reason, finishedAt: now },
    positions: {}, // 終了したら実位置は保持しない
    privacy: emptyPrivacy(), // 秘密の値・公開済みエリアも消す
    // 進行中のミッションは無効として終え、以降は発生させない。目的地と発生予定も消す（履歴に座標は残らない）
    missions: { ...cancelMissions(s.missions, now), schedule: [], nextIndex: 0 },
    captureAttempts: {},
  });
  const text = {
    [FINISH_REASON.TIME_UP]: '時間切れ！ 逃走者の勝ち',
    [FINISH_REASON.ALL_CAUGHT]: '全員確保！ 鬼の勝ち',
    [FINISH_REASON.ABORTED]: 'ホストがゲームを終了しました',
  }[reason];
  addLog(now, 'finish', text);
}

function addLog(at, type, text, playerId = null) {
  gameStore.setState((s) => {
    const entry = { id: (s.log.at(-1)?.id ?? 0) + 1, at, type, text, playerId };
    return { log: [...s.log, entry].slice(-MAX_LOG) };
  });
}

// ---- 読み取り ----

/** 画面用: viewerId の人に見せてよい情報だけ */
export function getPlayerView(viewerId, now = Date.now()) {
  return buildPlayerView(gameStore.getState(), viewerId, now);
}
