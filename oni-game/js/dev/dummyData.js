// 開発用のダミーデータ
// Firebase導入前に、1台の端末でゲームの流れを確認するためのもの。

import { createPlayer } from '../game/player.js';
import { randomPointInArea } from '../game/gameArea.js';
import { randomId } from '../utils/random.js';

const DUMMY_NAMES = ['たろう', 'はなこ', 'けんた', 'さくら', 'ゆうと', 'みお', 'そうた', 'あおい', 'りく', 'ひなた'];

/** 開始地点が決まっていないときの既定の地図中心（東京駅付近） */
export const DEFAULT_CENTER = Object.freeze({ lat: 35.681236, lng: 139.767125 });

export function createDummyPlayer(index) {
  return createPlayer({
    id: `dummy-${randomId(8)}`,
    name: `${DUMMY_NAMES[index % DUMMY_NAMES.length]}(仮)`,
    isDummy: true,
  });
}

/**
 * ゲーム開始時の実位置（ダミー段階用）。
 * ダミーはエリア内のランダムな地点、それ以外は selfPosition（なければ開始地点）に置く。
 */
export function createInitialPositions(players, area, { selfPosition = null, rng = Math.random } = {}) {
  const positions = {};
  for (const p of players) {
    positions[p.id] = p.isDummy
      ? randomPointInArea(area, rng, { marginM: area.radiusM * 0.1 })
      : (selfPosition ?? area.center);
  }
  return positions;
}
