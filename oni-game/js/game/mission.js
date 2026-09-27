// ミッションのルール（発生・到達判定・時間切れ・中断）
//
// state.missions（内部用。鬼の端末にそのまま渡してはいけない）
//   schedule: [{ index, startsAt, limitMs }]   … 発生時刻（秘密）
//   nextIndex: 次に発生するミッションの番号（0始まり）
//   active: null | {
//     id, index, startedAt, endsAt, arrivalRadiusM,
//     participants: { [runnerId]: { destination, result, resolvedAt, reason } }
//   }
//   history: [{ id, index, startedAt, endedAt, results: { [runnerId]: result } }] … 座標は残さない
//   rerollsUsed: { [runnerId]: true } … 目的地の変更を使った人（1ゲーム1回。鬼には渡さない）
//
// ここにある関数はすべて純粋関数（入力の state を変更せず、新しい値を返す）。
// 実位置と目的地を使うので、Firebase 導入後はサーバー側で実行する。

import { distanceM } from '../utils/distance.js';
import { activeRunners, withMissionResult, MISSION_RESULT, ROLE, STATUS } from './player.js';
import { blurAfterMission } from './blurPolicy.js';
import { chooseDestination, ARRIVAL_RADIUS_M } from './destinations.js';

export const MISSION_STATUS = Object.freeze({
  PENDING: 'pending', // 挑戦中
  SUCCESS: MISSION_RESULT.SUCCESS, // 時間内に到達
  FAILURE: MISSION_RESULT.FAILURE, // 時間切れ
  CANCELLED: 'cancelled', // 無効（確保された・ゲーム終了・目的地を作れなかった）
});

const LATE_START_MIN_MS = 20_000; // 発生が遅れて、残りがこれ未満ならそのミッションは無効
const END_MARGIN_MS = 10_000; // ゲーム終了のこの時間前までにミッションを終える

export function emptyMissionState() {
  return { schedule: [], nextIndex: 0, active: null, history: [], rerollsUsed: {} };
}

/** ゲーム開始時: スケジュール（開始からの時間）を実時刻にする */
export function createMissionState(schedule, startedAt) {
  return {
    ...emptyMissionState(),
    schedule: schedule.map((m) => ({ index: m.index, startsAt: startedAt + m.offsetMs, limitMs: m.limitMs })),
  };
}

/**
 * ミッション結果をプレイヤーに反映する（ミッション終了時に呼ぶ）。
 * - 結果を missionHistory に記録
 * - 参加中の逃走者なら blurPolicy で blurM を変える（成功 → 1段階大きく / 失敗 → 1段階小さく）
 *   確保されて脱落・鬼になった人は blurM を変えない
 * - ここで変えるのは player.blurM だけ。公開済みの可能性エリアは変えないので、
 *   鬼に見える円は「次の位置公開」から新しい大きさになる（locationPublisher.js）
 */
export function applyMissionOutcome(player, { missionId, result, at }) {
  const recorded = withMissionResult(player, { missionId, result, at });
  const isActiveRunner = player.role === ROLE.RUNNER && player.status === STATUS.ACTIVE;
  if (!isActiveRunner) return recorded;
  return { ...recorded, blurM: blurAfterMission(player.blurM, result) };
}

function destinationFor(game, runnerId, limitMs, rng) {
  const from = game.positions[runnerId];
  if (!from) return null;
  return chooseDestination({
    from,
    area: game.area,
    exclusionZones: game.exclusionZones ?? [],
    limitMs,
    rng,
  });
}

/** ミッションを開始する */
function startMission(game, missions, planned, now, rng) {
  const endsAt = Math.min(now + planned.limitMs, game.endsAt - END_MARGIN_MS);
  const id = `mission-${planned.index}`;
  if (endsAt - now < LATE_START_MIN_MS) {
    // 端末が止まっていた等で大きく遅れた場合（通常は起きない）
    const history = [...missions.history, { id, index: planned.index, startedAt: now, endedAt: now, results: {}, skipped: true }];
    return { missions: { ...missions, nextIndex: missions.nextIndex + 1, history }, started: null };
  }
  const participants = {};
  for (const runner of activeRunners(game.players)) {
    const destination = destinationFor(game, runner.id, endsAt - now, rng);
    participants[runner.id] = destination
      ? { destination, result: MISSION_STATUS.PENDING, resolvedAt: null, reason: null }
      : { destination: null, result: MISSION_STATUS.CANCELLED, resolvedAt: now, reason: 'no_destination' };
  }
  const active = { id, index: planned.index, startedAt: now, endsAt, arrivalRadiusM: ARRIVAL_RADIUS_M, participants };
  return { missions: { ...missions, nextIndex: missions.nextIndex + 1, active }, started: active };
}

function resolve(missions, runnerId, result, now, reason = null) {
  const p = missions.active.participants[runnerId];
  if (!p || p.result !== MISSION_STATUS.PENDING) return missions;
  return {
    ...missions,
    active: {
      ...missions.active,
      participants: { ...missions.active.participants, [runnerId]: { ...p, result, resolvedAt: now, reason } },
    },
  };
}

/** 実位置で到達判定（挑戦中の人だけ） */
export function checkArrivals(missions, positions, now) {
  if (!missions.active || now > missions.active.endsAt) return missions;
  let next = missions;
  for (const [runnerId, p] of Object.entries(missions.active.participants)) {
    if (p.result !== MISSION_STATUS.PENDING) continue;
    const pos = positions[runnerId];
    if (pos && distanceM(pos, p.destination) <= missions.active.arrivalRadiusM) {
      next = resolve(next, runnerId, MISSION_STATUS.SUCCESS, now);
    }
  }
  return next;
}

/** 進行中のミッションを終える（挑戦中の人は pendingResult にする） */
function closeActive(missions, now, pendingResult, reason) {
  let next = missions;
  for (const runnerId of Object.keys(missions.active.participants)) {
    next = resolve(next, runnerId, pendingResult, now, reason);
  }
  const { id, index, startedAt, participants } = next.active;
  const results = Object.fromEntries(Object.entries(participants).map(([rid, p]) => [rid, p.result]));
  return {
    missions: { ...next, active: null, history: [...next.history, { id, index, startedAt, endedAt: now, results }] },
    ended: { id, index, results },
  };
}

/** 確保された逃走者のミッションを無効にする */
export function withdrawParticipant(missions, runnerId, now) {
  if (!missions.active) return missions;
  return resolve(missions, runnerId, MISSION_STATUS.CANCELLED, now, 'captured');
}

/** ゲーム終了時: 進行中のミッションを無効として終え、以降のミッションも発生させない */
export function cancelMissions(missions, now) {
  const base = missions.active ? closeActive(missions, now, MISSION_STATUS.CANCELLED, 'game_over').missions : missions;
  return { ...base, nextIndex: base.schedule.length };
}

/** 目的地の変更をまだ使えるか（1ゲーム1回） */
export function canRerollDestination(missions, runnerId) {
  const p = missions?.active?.participants[runnerId];
  return Boolean(p && p.result === MISSION_STATUS.PENDING && !missions.rerollsUsed?.[runnerId]);
}

/**
 * 目的地が行けない・危ない場所だったとき、作り直す（1ゲームにつき1回）。
 * 変更後の目的地も chooseDestination の同じルールを通す。
 * 変更した事実・時刻はログにもビューにも出さない（本人のビューの目的地が変わるだけ）。
 */
export function rerollDestination(game, runnerId, now, rng = Math.random) {
  const missions = game.missions;
  const p = missions.active?.participants[runnerId];
  if (!p || p.result !== MISSION_STATUS.PENDING) return { ok: false, reason: 'not_in_mission' };
  if (missions.rerollsUsed?.[runnerId]) return { ok: false, reason: 'already_rerolled' };
  const destination = destinationFor(game, runnerId, missions.active.endsAt - now, rng)
    ?? destinationFor(game, runnerId, missions.active.endsAt - missions.active.startedAt, rng);
  if (!destination) return { ok: false, reason: 'no_destination' };
  return {
    ok: true,
    missions: {
      ...missions,
      rerollsUsed: { ...missions.rerollsUsed, [runnerId]: true },
      active: {
        ...missions.active,
        participants: { ...missions.active.participants, [runnerId]: { ...p, destination } },
      },
    },
  };
}

/**
 * ミッションを進める（定期的に呼ぶ）: 到達判定 → 時間切れ → 次のミッションの発生
 * @returns {{ missions, players, events: Array<{type:string,index:number,results?:object}> }}
 */
export function advanceMissions(game, now, rng = Math.random) {
  let missions = checkArrivals(game.missions, game.positions, now);
  let players = game.players;
  const events = [];

  if (missions.active && now >= missions.active.endsAt) {
    const closed = closeActive(missions, now, MISSION_STATUS.FAILURE, 'time_up');
    missions = closed.missions;
    events.push({ type: 'mission_end', index: closed.ended.index, results: closed.ended.results });
    players = players.map((pl) => {
      const result = closed.ended.results[pl.id];
      if (result !== MISSION_STATUS.SUCCESS && result !== MISSION_STATUS.FAILURE) return pl;
      return applyMissionOutcome(pl, { missionId: closed.ended.id, result, at: now });
    });
  }

  const planned = missions.schedule[missions.nextIndex];
  if (!missions.active && planned && now >= planned.startsAt) {
    const started = startMission({ ...game, missions, players }, missions, planned, now, rng);
    missions = started.missions;
    if (started.started) events.push({ type: 'mission_start', index: planned.index });
  }

  return { missions, players, events };
}

/** 結果の人数（鬼にも見せてよい集計） */
export function summarizeResults(results) {
  const counts = { success: 0, failure: 0, cancelled: 0 };
  for (const r of Object.values(results)) {
    if (r === MISSION_STATUS.SUCCESS) counts.success += 1;
    else if (r === MISSION_STATUS.FAILURE) counts.failure += 1;
    else counts.cancelled += 1;
  }
  return counts;
}
