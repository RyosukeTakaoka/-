// 可能性エリア（「逃走者はこの円の中のどこかにいる」）の生成
//
// 入力: 実位置・現在の blurM・逃走者ごとの秘密の値・公開回数(epoch)
// 出力: { center, radiusM } と、内部用のマス情報 cell
//
// ■ アルゴリズム（R = blurM）
//  1. 逃走者ごとの秘密の値で「回転・平行移動した一辺 CELL_RATIO×R のマス目」を作り、
//     実位置が入るマスを求める（境界付近で円が行き来しないよう、前回のマスを優先して使い続ける）
//  2. マスの中心から、秘密のシード＋公開回数＋マスから作った乱数で最大 JITTER_RATIO×R ずらした点を円の中心にする
//  3. 半径は R
//
// ■ 可能性エリアは「作った時点（公開時点）の実位置を含むスナップショット」
//    公開後に逃走者が動けば、現在位置が古い円の外に出ることはあり得る
//
// ■ 満たす性質
//  - 公開時点の実位置は必ず円の内側: マスの対角の半分(0.64R) ≤ KEEP_CELL_RATIO×R(0.65R) なのでマス内の点は必ず
//    |実位置 - マス中心| ≤ 0.65R。ずらし ≤ JITTER_RATIO×R(0.25R) なので |実位置 - 円の中心| ≤ 0.9R < R
//  - 円の中心は実位置と一致しない: MIN_OFFSET_RATIO×R 未満になる候補は使わない
//  - 中心はマスに結びついているので、止まっている逃走者の円を何回分平均しても、
//    平均位置はマスの中心付近に集まり、実位置そのものには近づきにくい（設計上の狙い）
//    検証結果（保証ではない）: R=300m・200人分のシミュレーションで、平均した中心と実位置の距離は
//    1回 約122m、200回 約105m で、実位置付近への収束は見られなかった。
//    毎回単純にランダムにずらす方式では 200回で 約12m まで近づいた（tests/privacy.test.js）
//  - 注意: 1回の円でも、実位置は「円の中心から 0.9R 以内」にあるので、円全体より少しだけ範囲が狭い
//  - マスの中で動いても円は動かない。公開ごとのずらしは移動方向と無関係
//
// この関数は実位置を扱うので、実行するのは実位置を持つ側（今は端末内、Firebase 導入後はサーバー側）だけ。
// 秘密の値 (secret) は鬼の端末に渡してはいけない。

import { toLocalXY, fromLocalXY } from '../utils/distance.js';
import { createSeededRng, hashToSeed, secureRandom } from '../utils/random.js';

export const CELL_RATIO = 0.9; // マスの一辺 / R
export const JITTER_RATIO = 0.25; // マス中心からのずらしの最大 / R
export const KEEP_CELL_RATIO = 0.65; // 前回のマス中心からこの距離 / R 以内なら同じマスを使い続ける
export const MIN_OFFSET_RATIO = 0.1; // 円の中心と実位置の最小距離 / R
const MAX_ATTEMPTS = 16;

/**
 * 逃走者ごとの秘密の値（ゲーム開始時に1回作る）
 * @param {() => number} rng テスト以外では暗号学的乱数を使う
 */
export function createPrivacySecret(rng = secureRandom) {
  return {
    seed: Math.floor(rng() * 4294967296),
    gridAngle: rng() * (Math.PI / 2), // マス目の回転
    gridU: rng(), // マス目の原点のずれ（0〜1、マスの一辺に対する割合）
    gridV: rng(),
  };
}

const rotate = ({ x, y }, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 平面座標 → マス目座標（回転・平行移動済み、単位はマス） */
function toGrid(xy, secret, cellM) {
  const r = rotate(xy, -secret.gridAngle);
  return { x: r.x / cellM + secret.gridU, y: r.y / cellM + secret.gridV };
}

/** マス (i, j) の中心の平面座標 */
function cellCenterXY({ i, j }, secret, cellM) {
  const g = { x: (i + 0.5 - secret.gridU) * cellM, y: (j + 0.5 - secret.gridV) * cellM };
  return rotate(g, secret.gridAngle);
}

/** 実位置が属するマス（前回のマスに十分近ければそれを使い続ける） */
function chooseCell(p, radiusM, secret, cellM, previousCell) {
  if (previousCell && previousCell.radiusM === radiusM) {
    const c = cellCenterXY(previousCell, secret, cellM);
    if (dist(p, c) <= KEEP_CELL_RATIO * radiusM) return previousCell;
  }
  const g = toGrid(p, secret, cellM);
  return { i: Math.floor(g.x), j: Math.floor(g.y), radiusM };
}

/** 半径 r の円内に一様なランダム点（平面座標のずれ） */
function randomInDisk(rng, r) {
  const d = r * Math.sqrt(rng());
  const a = rng() * 2 * Math.PI;
  return { x: d * Math.cos(a), y: d * Math.sin(a) };
}

/**
 * 可能性エリアを作る。
 * @param {object} p
 * @param {{lat:number,lng:number}} p.position 実位置
 * @param {number} p.blurM 現在の位置ぼかし精度（= 円の半径）
 * @param {object} p.secret createPrivacySecret() の値
 * @param {number} p.epoch 公開回数（同じ値なら同じ結果）
 * @param {{lat:number,lng:number}} p.origin 平面座標の原点（ゲームエリアの中心）
 * @param {object|null} p.previousCell 前回のマス（内部用）
 * @returns {{ center: {lat:number,lng:number}, radiusM: number, cell: object }}
 */
export function computePossibleArea({ position, blurM, secret, epoch, origin, previousCell = null }) {
  if (!(blurM > 0)) throw new Error('blurM が正しくありません');
  const radiusM = blurM;
  const cellM = CELL_RATIO * radiusM;
  const p = toLocalXY(origin, position);
  const cell = chooseCell(p, radiusM, secret, cellM, previousCell);
  const q = cellCenterXY(cell, secret, cellM);
  const minOffset = MIN_OFFSET_RATIO * radiusM;

  let c = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !c; attempt++) {
    const rng = createSeededRng(hashToSeed(secret.seed, epoch, cell.i, cell.j, radiusM, attempt));
    const j = randomInDisk(rng, JITTER_RATIO * radiusM);
    const candidate = { x: q.x + j.x, y: q.y + j.y };
    if (dist(p, candidate) >= minOffset) c = candidate;
  }
  if (!c) {
    // 念のための保険: 実位置から離れる向きにずらす（|p-c| = |p-q| + ずらし なので条件を満たす）
    const d = dist(p, q) || 1;
    const ux = (q.x - p.x) / d || 1;
    const uy = (q.y - p.y) / d || 0;
    c = { x: q.x + ux * JITTER_RATIO * radiusM, y: q.y + uy * JITTER_RATIO * radiusM };
  }

  return { center: fromLocalXY(origin, c), radiusM, cell };
}

/** マスの中心（内部・テスト用。鬼の端末に渡してはいけない） */
export function cellCenterOf(cell, secret, origin) {
  return fromLocalXY(origin, cellCenterXY(cell, secret, CELL_RATIO * cell.radiusM));
}
