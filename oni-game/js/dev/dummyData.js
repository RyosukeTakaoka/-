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

/** 位置のないプレイヤーに、エリア内のダミー位置を割り当てる */
export function placePlayersInArea(players, area, rng = Math.random) {
  return players.map((p) =>
    p.position ? p : { ...p, position: randomPointInArea(area, rng, { marginM: area.radiusM * 0.1 }) },
  );
}
