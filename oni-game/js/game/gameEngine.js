// ゲームエンジン（状態 + 操作 → 新しい状態）
//
// ゲームの状態遷移をすべてここに集める。どの関数も:
// - 入力の state を書き換えず、新しい state を返す
// - ブラウザ API・Firebase・モジュール内の共有状態に依存しない
// - 時刻は ctx.now で受け取る（Date.now() を内部で呼ばない）
// - 乱数は ctx.rng で受け取れる（省略時は各ルールファイルの既定値）
//
// 端末内モードでは game/gameState.js がこれを呼び、Firebase 導入後は Cloud Functions が同じ関数を呼ぶ。
//
// ctx = {
//   now: number,                           必須。端末内モードは端末時刻、サーバーではサーバー時刻
//   rng?: { roles, privacy, schedule, destinations },  各 () => [0,1)
//   newId?: () => string                   ゲームIDの生成
// }
// ゲーム進行の関数は { state, events, result? } を返す。events はこの操作で増えたログ（start / capture /
// reveal / mission_start / mission_end / finish）で、サーバーではどの公開データを書き直すかの判断に使う。

import { isValidLatLng } from '../utils/distance.js';
import { randomId } from '../utils/random.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings.js';
import { createGameArea } from './gameArea.js';
import { preparePlayersForGame, ROLE } from './player.js';
import { attemptCapture, CAPTURE_FAILURE } from './capture.js';
import { judgeOutcome, FINISH_REASON } from './outcome.js';
import { buildResultSummary } from './resultSummary.js';
import { emptyPrivacy, initPrivacy, publishIfDue, publishMissing, withdraw } from './locationPublisher.js';
import { generateMissionSchedule } from './missionSchedule.js';
import {
  emptyMissionState, createMissionState, advanceMissions, checkArrivals, withdrawParticipant, cancelMissions,
  rerollDestination, summarizeResults, MISSION_STATUS,
} from './mission.js';

export const PHASE = Object.freeze({
  SETUP: 'setup', // ゲーム作成・設定中
  LOBBY: 'lobby', // ルームで友達を待っている
  PLAYING: 'playing', // ゲーム中
  FINISHED: 'finished', // 決着
});

export const EXCLUSION_RADIUS_M = 30;
const MAX_LOG = 50;

export function initialState() {
  return {
    phase: PHASE.SETUP,
    gameId: null, // ゲームごとに新しく作る
    settings: { ...DEFAULT_SETTINGS },
    startPoint: null, // ゲーム開始地点 { lat, lng }
    area: null, // { center, radiusM }
    exclusionZones: [], // ホストが設定した目的地の除外エリア [{ center, radiusM }]（道路・水辺・立入禁止など）
    room: null, // { code, hostId }
    selfId: null, // この端末のプレイヤーID（端末内モード用）
    players: [],
    positions: {}, // 実位置 { [playerId]: { lat, lng, accuracyM, updatedAt } }（ゲーム中のみ）
    privacy: emptyPrivacy(), // 可能性エリアの内部状態（秘密の値・公開済みエリア）
    captureAttempts: {}, // { [hunterId]: 最後に確保操作した時刻 }
    missions: emptyMissionState(), // ミッション（発生時刻・目的地は内部のみ）
    startedAt: null,
    endsAt: null,
    result: null, // { winner, reason, finishedAt }
    resultSummary: null, // 結果画面用（位置情報を含まない。resultSummary.js）
    log: [], // [{ id, at, type, text, playerId }] 位置情報は含めない
  };
}

function requireNow(ctx) {
  if (!Number.isFinite(ctx?.now)) throw new Error('ctx.now（現在時刻）を渡してください');
  return ctx.now;
}

function withLog(state, at, type, text, playerId = null) {
  const entry = { id: (state.log.at(-1)?.id ?? 0) + 1, at, type, text, playerId };
  return { ...state, log: [...state.log, entry].slice(-MAX_LOG) };
}

/** before → after で増えたログ（= この操作で起きたこと） */
function eventsBetween(before, after) {
  const lastId = before.log.at(-1)?.id ?? 0;
  return after.log.filter((e) => e.id > lastId);
}

const done = (before, state, extra = {}) => ({ state, events: eventsBetween(before, state), ...extra });

// ---- 作成・ロビー（state → state） ----

export function updateSettings(state, input) {
  const settings = sanitizeSettings(input, state.settings);
  return { ...state, settings, area: state.startPoint ? createGameArea(state.startPoint, settings.radiusM) : null };
}

export function setStartPoint(state, point) {
  return {
    ...state,
    startPoint: { lat: point.lat, lng: point.lng },
    area: createGameArea(point, state.settings.radiusM),
  };
}

/** 目的地にしない場所（道路・水辺・立入禁止など）を追加する */
export function addExclusionZone(state, point, radiusM = EXCLUSION_RADIUS_M) {
  if (!isValidLatLng(point)) return state;
  return { ...state, exclusionZones: [...state.exclusionZones, { center: { lat: point.lat, lng: point.lng }, radiusM }] };
}

export function clearExclusionZones(state) {
  return { ...state, exclusionZones: [] };
}

export function enterLobby(state, { room, selfId, players }) {
  return { ...state, phase: PHASE.LOBBY, room, selfId, players };
}

export function setPlayers(state, players) {
  return { ...state, players };
}

/** 作成画面から、同じルーム・同じメンバーのままロビーへ戻る（もう一度遊ぶとき） */
export function returnToLobby(state) {
  if (!state.room) throw new Error('ルームがありません');
  if (!state.area) throw new Error('ゲーム開始地点を設定してください');
  return { ...state, phase: PHASE.LOBBY };
}

/**
 * 結果画面から「もう一度遊ぶ」。
 * 再利用するのは ルーム・メンバー・ゲーム設定 だけ。
 * 開始地点・除外エリア（場所の情報）・実位置・秘密値・可能性エリア・ミッション・結果はすべて初期状態に戻す。
 * ゲームID・秘密値・ミッションのスケジュールと目的地は、次の startGame() で新しく作られる。
 */
export function prepareRematch(state) {
  if (state.phase !== PHASE.FINISHED) throw new Error('ゲーム終了後にだけ使えます');
  return {
    ...initialState(),
    phase: PHASE.SETUP,
    settings: { ...state.settings },
    room: state.room,
    selfId: state.selfId,
    players: state.players.map(({ id, name, isHost, isDummy }) => ({ id, name, isHost, isDummy })),
  };
}

// ---- ゲーム進行（→ { state, events, result? }） ----

/**
 * ゲーム開始。役割をランダムに決め、秘密値・ミッションのスケジュールを新しく作り、最初の公開を行う。
 * initialPositions: 開始時点で分かっている実位置（端末内モードのダミー配置など）
 */
export function startGame(state, { initialPositions = {} } = {}, ctx) {
  const now = requireNow(ctx);
  if (state.phase !== PHASE.LOBBY) throw new Error('ロビーからのみ開始できます');
  if (!state.area) throw new Error('ゲーム開始地点が設定されていません');
  const players = preparePlayersForGame(state.players, state.settings, ctx.rng?.roles);
  const durationMs = state.settings.durationMin * 60 * 1000;
  const positions = {};
  for (const [id, pos] of Object.entries(initialPositions)) {
    if (isValidLatLng(pos)) positions[id] = { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM ?? null, updatedAt: now };
  }
  const hunterNames = players.filter((p) => p.role === ROLE.HUNTER).map((p) => p.name);
  let next = {
    ...state,
    phase: PHASE.PLAYING,
    gameId: (ctx.newId ?? randomId)(),
    players,
    positions,
    privacy: initPrivacy(players, ctx.rng?.privacy),
    captureAttempts: {},
    missions: createMissionState(generateMissionSchedule(durationMs, ctx.rng?.schedule), now),
    startedAt: now,
    endsAt: now + durationMs,
    result: null,
    resultSummary: null,
    log: [],
  };
  next = withLog(next, now, 'start', `ゲーム開始！ 鬼は ${hunterNames.join('、')}`);
  next = { ...next, privacy: publishIfDue(next, now).privacy }; // 最初の公開
  return { state: next, events: next.log };
}

/** 実位置の更新。ゲーム中以外・参加者以外は受け付けない */
export function updatePosition(state, { playerId, pos }, ctx) {
  const now = requireNow(ctx);
  if (state.phase !== PHASE.PLAYING || !isValidLatLng(pos)) return done(state, state);
  if (!state.players.some((p) => p.id === playerId)) return done(state, state);
  let next = {
    ...state,
    positions: {
      ...state.positions,
      [playerId]: { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM ?? null, updatedAt: now },
    },
  };
  // ミッションの到達判定（実位置で判定。結果以外の情報は外に出さない）
  if (next.missions.active) next = { ...next, missions: checkArrivals(next.missions, next.positions, now) };
  // 公開済みの可能性エリアは変えない。まだ一度も公開されていない逃走者だけ公開する
  if (!next.privacy.published[playerId]) next = { ...next, privacy: publishMissing(next, now) };
  return done(state, next);
}

/** 鬼の確保操作。result は { ok, capturedId } / { ok: false, reason }（座標や距離は返さない） */
export function requestCapture(state, { hunterId }, ctx) {
  const now = requireNow(ctx);
  const attempt = attemptCapture(state, hunterId, now);
  let next = state;
  // 実際に判定まで進んだ操作だけクールダウンの起点にする
  if (attempt.ok || attempt.reason === CAPTURE_FAILURE.NO_TARGET) {
    next = { ...next, captureAttempts: { ...next.captureAttempts, [hunterId]: now } };
  }
  if (!attempt.ok) return done(state, next, { result: { ok: false, reason: attempt.reason } });

  next = {
    ...next,
    players: attempt.players,
    privacy: withdraw(next.privacy, attempt.capturedId),
    missions: withdrawParticipant(next.missions, attempt.capturedId, now),
  };
  const hunter = attempt.players.find((p) => p.id === hunterId);
  const caught = attempt.players.find((p) => p.id === attempt.capturedId);
  const suffix = state.settings.zombieMode ? `${caught.name} は鬼になった！` : `${caught.name} は脱落`;
  next = withLog(next, now, 'capture', `${hunter.name} が ${caught.name} を確保！ ${suffix}`, caught.id);
  next = checkOutcome(next, now);
  return done(state, next, { result: { ok: true, capturedId: attempt.capturedId } });
}

/**
 * 逃走者本人からの「到達した」申告（Firebase 版で使う）。
 * サーバーに保存されている実位置と秘密の目的地で判定する。result は { ok, reason? } だけ。
 */
export function claimArrival(state, { runnerId }, ctx) {
  const now = requireNow(ctx);
  if (state.phase !== PHASE.PLAYING) return done(state, state, { result: { ok: false, reason: 'not_playing' } });
  const p = state.missions.active?.participants[runnerId];
  if (!p || p.result !== MISSION_STATUS.PENDING) {
    return done(state, state, { result: { ok: false, reason: 'not_in_mission' } });
  }
  const pos = state.positions[runnerId];
  const missions = pos ? checkArrivals(state.missions, { [runnerId]: pos }, now) : state.missions;
  const ok = missions.active?.participants[runnerId]?.result === MISSION_STATUS.SUCCESS;
  const next = missions === state.missions ? state : { ...state, missions };
  return done(state, next, { result: ok ? { ok: true } : { ok: false, reason: 'not_arrived' } });
}

/** 目的地が行けない・危ない場所だったとき、変更する（1ゲーム1回。ログには残さない） */
export function changeDestination(state, { runnerId }, ctx) {
  const now = requireNow(ctx);
  if (state.phase !== PHASE.PLAYING) return done(state, state, { result: { ok: false, reason: 'not_playing' } });
  const r = rerollDestination(state, runnerId, now, ctx.rng?.destinations);
  if (!r.ok) return done(state, state, { result: { ok: false, reason: r.reason } });
  return done(state, { ...state, missions: r.missions }, { result: { ok: true } });
}

/**
 * 時間を進める: 時間切れの判定 → ミッションの開始・終了 → 可能性エリアの公開。
 * 端末内モードは定期的に、サーバーでは予約実行と各要求の処理で呼ぶ。同じ now で何度呼んでも結果は同じ。
 */
export function advance(state, ctx) {
  const now = requireNow(ctx);
  if (state.phase !== PHASE.PLAYING) return done(state, state);
  let next = checkOutcome(state, now);
  if (next.phase !== PHASE.PLAYING) return done(state, next); // 決着したらミッション・公開は進めない
  next = progressMissions(next, now, ctx.rng?.destinations);
  const { privacy, revealed } = publishIfDue(next, now);
  if (revealed) next = withLog({ ...next, privacy }, now, 'reveal', '逃走者の可能性エリアが更新されました');
  return done(state, next);
}

/** ホストによる途中終了 */
export function abort(state, ctx) {
  const now = requireNow(ctx);
  if (state.phase !== PHASE.PLAYING) return done(state, state);
  return done(state, finish(state, { winner: null, reason: FINISH_REASON.ABORTED }, now));
}

/**
 * 次に何かが起きる時刻（時間切れ・次の公開・ミッションの開始/終了のうち一番早いもの）。
 * サーバーではこの時刻に advance を1件だけ予約する。ゲーム中でなければ null。
 */
export function nextDueAt(state) {
  if (state.phase !== PHASE.PLAYING) return null;
  const intervalMs = state.settings.revealIntervalSec * 1000;
  const candidates = [
    state.endsAt,
    state.startedAt + (state.privacy.epoch + 1) * intervalMs,
    state.missions.active ? state.missions.active.endsAt : state.missions.schedule[state.missions.nextIndex]?.startsAt,
  ].filter(Number.isFinite);
  return Math.min(...candidates);
}

// ---- 内部 ----

function progressMissions(state, now, rng) {
  const { missions, players, events } = advanceMissions(state, now, rng);
  if (missions === state.missions && players === state.players) return state;
  let next = { ...state, missions, players };
  for (const e of events) {
    if (e.type === 'mission_start') {
      next = withLog(next, now, 'mission_start', `ミッション${e.index}発生！ 逃走者は制限時間内に目的地へ向かえ`);
    } else if (e.type === 'mission_end') {
      const c = summarizeResults(e.results);
      next = withLog(next, now, 'mission_end', `ミッション${e.index}終了：成功 ${c.success}人・失敗 ${c.failure}人`);
    }
  }
  return next;
}

function checkOutcome(state, now) {
  const outcome = judgeOutcome(state, now);
  return outcome ? finish(state, outcome, now) : state;
}

/** 決着: 位置情報・秘密値・可能性エリアを破棄し、ミッションを打ち切り、破棄した「後」の状態から結果を作る */
function finish(state, { winner, reason }, now) {
  const cleared = {
    ...state,
    phase: PHASE.FINISHED,
    endsAt: Math.min(state.endsAt, now),
    // 時間切れの判定が少し遅れて動いても、終了時刻は予定の終了時刻を超えない
    result: { winner, reason, finishedAt: Math.min(state.endsAt, now) },
    positions: {}, // 終了したら実位置は保持しない
    privacy: emptyPrivacy(), // 秘密の値・公開済みエリアも消す
    // 進行中のミッションは無効として終え、以降は発生させない。目的地と発生予定も消す（履歴に座標は残らない）
    missions: { ...cancelMissions(state.missions, now), schedule: [], nextIndex: 0 },
    captureAttempts: {},
  };
  const withSummary = { ...cleared, resultSummary: buildResultSummary(cleared) };
  const text = {
    [FINISH_REASON.TIME_UP]: '時間切れ！ 逃走者の勝ち',
    [FINISH_REASON.ALL_CAUGHT]: '全員確保！ 鬼の勝ち',
    [FINISH_REASON.ABORTED]: 'ホストがゲームを終了しました',
  }[reason];
  return withLog(withSummary, now, 'finish', text);
}
