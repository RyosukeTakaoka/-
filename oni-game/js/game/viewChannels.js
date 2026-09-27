// ビューを「公開範囲（誰が読めるか）ごとのチャンネル」に分ける / 組み立てる
//
// visibility.buildPlayerView(state, uid) は「その人に見せてよい情報」を1人分まとめて作る基準の実装。
// Firebase 版では人数分のビューを毎回書き直すと書き込みが人数の2乗で増えるため、同じ情報を
// 「読める人の集まり」ごとに分けて書く（buildChannels）。クライアントは、自分が読めるチャンネルだけを
// 受け取り、組み立てて同じ形のビューにする（assembleView）。
//
//   buildChannels(state)          … サーバー側（Cloud Functions）。実位置を読むのはここだけ
//   readableChannels(channels, uid) … 「誰が何を読めるか」の定義（= Security Rules の仕様）
//   assembleView(parts, uid, opts)  … クライアント側。実位置や秘密値を必要としない
//
// 性質: assembleView(readableChannels(buildChannels(state), uid), uid, { ownPosition }) は
//       buildPlayerView(state, uid) と一致する（tests/viewChannels.test.js で全員分を確認）
//
// チャンネル（Firebase 版での置き場所と読める人）
//   public           rooms/{r}/public                         … 部屋のメンバー全員
//   hunterPositions  rooms/{r}/channels/hunterPositions      … 参加中の鬼。設定 ON なら全メンバー
//   runnerPositions  rooms/{r}/channels/runnerPositions      … 参加中の逃走者だけ
//   possibleAreas    rooms/{r}/channels/possibleAreas        … 参加中の鬼だけ
//   views[uid]       rooms/{r}/views/{uid}                    … 本人だけ
// 実位置（state.positions）・秘密値（state.privacy.secrets）・ミッション予定はどのチャンネルにも入れない。
// 鬼と仲間の位置のチャンネルは、サーバーが実位置から作る派生データ（端末は書き込まない）。

import { isInsideArea } from './gameArea.js';
import { ROLE, STATUS, activeRunners, originalRunners } from './player.js';
import { CAPTURE_COOLDOWN_MS } from './capture.js';
import { nextRevealAt } from './locationPublisher.js';
import {
  HIDDEN, exact, possibleArea, publicInfo, isActive, sharedMissionInfo, ownMissionInfo,
} from './visibility.js';

const latLng = (pos) => ({ lat: pos.lat, lng: pos.lng });

/** 状態を公開範囲ごとのチャンネルに分ける（サーバー側） */
export function buildChannels(state) {
  const playing = state.phase === 'playing';
  const hunterPositions = {};
  const runnerPositions = {};
  const possibleAreas = {};
  if (playing) {
    for (const p of state.players) {
      const pos = state.positions[p.id];
      if (isActive(p, ROLE.HUNTER) && pos) hunterPositions[p.id] = latLng(pos);
      if (isActive(p, ROLE.RUNNER)) {
        if (pos) runnerPositions[p.id] = latLng(pos);
        const published = state.privacy?.published[p.id];
        if (published) possibleAreas[p.id] = possibleArea(p.id, published);
      }
    }
  }

  const views = {};
  for (const p of state.players) {
    const lastAttempt = state.captureAttempts?.[p.id];
    const ownArea = playing && isActive(p, ROLE.RUNNER) ? state.privacy?.published[p.id] : null;
    views[p.id] = {
      captureReadyAt: lastAttempt != null ? lastAttempt + CAPTURE_COOLDOWN_MS : 0,
      blurM: isActive(p, ROLE.RUNNER) ? p.blurM : null,
      possibleArea: ownArea ? possibleArea(p.id, ownArea) : null,
      mission: playing ? ownMissionInfo(state.missions, p.id) : null,
      missionHistory: (p.missionHistory ?? []).map((h) => ({ missionId: h.missionId, result: h.result })),
    };
  }

  return {
    public: {
      phase: state.phase,
      area: state.area,
      exclusionZones: state.exclusionZones ?? [],
      settings: state.settings,
      startedAt: state.startedAt,
      endsAt: state.endsAt,
      result: state.result,
      ...(playing ? sharedMissionInfo(state.missions) : { mission: null, missionsCompleted: 0, lastMission: null }),
      players: state.players.map(publicInfo),
      runnersRemaining: activeRunners(state.players).length,
      runnersTotal: originalRunners(state.players).length,
      log: state.log,
    },
    hunterPositions,
    runnerPositions,
    possibleAreas,
    views,
  };
}

/**
 * uid の人が読めるチャンネルだけを返す（読めないものは null）。部屋のメンバーでなければ null。
 * Firebase の Security Rules はこの定義どおりに書く（7-H でエミュレーターを使って照合する）。
 */
export function readableChannels(channels, uid) {
  const me = channels.public.players.find((p) => p.id === uid);
  if (!me) return null;
  const playing = channels.public.phase === 'playing';
  const activeHunter = isActive(me, ROLE.HUNTER);
  const activeRunner = isActive(me, ROLE.RUNNER);
  return {
    public: channels.public,
    hunterPositions: playing && (activeHunter || channels.public.settings.showHuntersToRunners)
      ? channels.hunterPositions : null,
    runnerPositions: playing && activeRunner ? channels.runnerPositions : null,
    possibleAreas: playing && activeHunter ? channels.possibleAreas : null,
    view: channels.views[uid] ?? null,
  };
}

/** 相手の表示（読めたチャンネルにあるものだけを使う） */
function displayFrom(parts, me, target) {
  if (parts.public.phase !== 'playing' || !me || target.status !== STATUS.ACTIVE) return HIDDEN;
  if (target.role === ROLE.HUNTER) {
    const pos = parts.hunterPositions?.[target.id];
    return pos ? exact(pos) : HIDDEN;
  }
  const pos = parts.runnerPositions?.[target.id];
  if (pos) return exact(pos);
  const area = parts.possibleAreas?.[target.id];
  return area ? { ...area, center: { ...area.center } } : HIDDEN;
}

/**
 * 読めたチャンネルから、buildPlayerView と同じ形のビューを組み立てる（クライアント側）。
 * ownPosition は端末自身の GPS（自分の位置は自分の端末が知っている）。
 */
export function assembleView(parts, uid, { now, ownPosition = null } = {}) {
  const pub = parts.public;
  const playing = pub.phase === 'playing';
  const me = pub.players.find((p) => p.id === uid) ?? null;
  const own = playing && ownPosition ? ownPosition : null;
  const view = parts.view;

  return {
    phase: pub.phase,
    now,
    area: pub.area,
    exclusionZones: pub.exclusionZones,
    settings: pub.settings,
    startedAt: pub.startedAt,
    endsAt: pub.endsAt,
    nextRevealAt: playing ? nextRevealAt(now, pub.startedAt, pub.settings) : null,
    result: pub.result,
    mission: pub.mission,
    missionsCompleted: pub.missionsCompleted,
    lastMission: pub.lastMission,
    self: me && {
      ...me,
      position: own ? { lat: own.lat, lng: own.lng, accuracyM: own.accuracyM ?? null } : null,
      outOfArea: Boolean(own && pub.area && !isInsideArea(pub.area, own)),
      captureReadyAt: view?.captureReadyAt ?? 0,
      blurM: view?.blurM ?? null,
      possibleArea: view?.possibleArea ?? null,
      mission: view?.mission ?? null,
      missionHistory: view?.missionHistory ?? [],
    },
    others: pub.players.filter((p) => p.id !== uid).map((p) => ({ ...p, display: displayFrom(parts, me, p) })),
    runnersRemaining: pub.runnersRemaining,
    runnersTotal: pub.runnersTotal,
    log: pub.log,
  };
}
