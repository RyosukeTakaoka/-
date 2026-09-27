// STEP 7-C〜7-G: ゲーム進行をサーバー（Cloud Functions のハンドラー）で実行する
// RTDB エミュレーター上で、部屋の作成 → 開始 → 位置 → 確保 → 時間切れ → 結果 → もう一度遊ぶ までを通す。
// 各プレイヤーが読めるデータは、ルールを有効にしたクライアントとして確認する。
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as rooms from '../functions/src/rooms.js';
import * as game from '../functions/src/game.js';
import { loadGame } from '../functions/src/store.js';
import { createSeededRng } from '../oni-game/js/utils/random.js';
import { destinationPoint } from '../oni-game/js/utils/distance.js';
import { createTestEnv, asServer } from './helpers.js';

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearDatabase(); });

const START = { lat: 35.0, lng: 139.0 };
const T0 = 1_800_000_000_000;

function makeDeps(seed = 1) {
  const scheduled = [];
  return {
    scheduled,
    rng: {
      roles: createSeededRng(seed),
      privacy: createSeededRng(seed + 1),
      schedule: createSeededRng(seed + 2),
      destinations: createSeededRng(seed + 3),
    },
    newId: () => `game${seed}`,
    schedule: async (task) => { scheduled.push(task); },
  };
}

const read = (path) => asServer(env, async (db) => (await db.ref(path).get()).val());
const readJson = async (path) => { const v = await read(path); return v == null ? null : JSON.parse(v); };
const as = (uid) => env.authenticatedContext(uid).database();
const server = (fn) => asServer(env, fn);
const call = (handler, uid, data, now, deps) => server((db) => handler(db, uid ? { uid } : null, data, now, deps));
const expectHttpsError = async (promise, code) => {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `エラーコード ${err.code}（${err.message}）`);
    return true;
  });
};
const at = (m, bearing) => destinationPoint(START, m, bearing);
const locate = (roomId, uid, pos, now, deps) => server((db) => game.handleLocationWrite(db, { roomId, uid }, pos, now, deps));

/** alice（ホスト）・bob・carol の部屋を作る */
async function setupRoom(deps, settings = {}) {
  const { roomId, joinCode } = await call(rooms.createRoom, 'alice', {
    name: 'アリス',
    settings: { durationMin: 5, hunterCount: 1, captureRadiusM: 10, revealIntervalSec: 30, ...settings },
    startPoint: START,
    exclusionZones: [{ center: at(200, 90) }],
  }, T0, deps);
  await call(rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ' }, T0, deps);
  await call(rooms.joinRoom, 'carol', { code: joinCode, name: 'キャロル' }, T0, deps);
  return { roomId, joinCode };
}

test('部屋の作成・参加で、サーバーの状態と公開データ（public/doc・access）が作られる', async () => {
  const deps = makeDeps();
  const { roomId } = await setupRoom(deps);
  const pub = await readJson(`rooms/${roomId}/public/doc`);
  assert.equal(pub.phase, 'lobby');
  assert.deepEqual(pub.players.map((p) => p.name), ['アリス', 'ボブ', 'キャロル']);
  assert.equal(pub.players[0].isHost, true);
  assert.equal(pub.area.radiusM, 300);
  assert.equal(pub.exclusionZones.length, 1);
  assert.equal(pub.exclusionZones[0].radiusM, 30, '除外エリアの半径はサーバーが決める');
  const access = await read(`rooms/${roomId}/access`);
  assert.equal(access.phase, 'lobby');
  assert.equal(access.players.bob.role, 'none');
  // メンバーは public を読めるが、サーバーの状態は読めない
  await assertSucceeds(as('bob').ref(`rooms/${roomId}/public/doc`).get());
  await assertFails(as('alice').ref(`private/games/${roomId}`).get());
});

test('ホスト以外は開始できない・人数が足りなければ開始できない', async () => {
  const deps = makeDeps();
  const { roomId } = await call(rooms.createRoom, 'alice', { name: 'アリス', startPoint: START }, T0, deps);
  await expectHttpsError(call(game.startGame, 'alice', { roomId }, T0, deps), 'failed-precondition');
  const { roomId: r2 } = await setupRoom(deps);
  await expectHttpsError(call(game.startGame, 'bob', { roomId: r2 }, T0, deps), 'permission-denied');
  await expectHttpsError(call(game.startGame, 'mallory', { roomId: r2 }, T0, deps), 'permission-denied');
});

test('ゲーム全体: 開始 → 位置 → 公開範囲 → 確保 → 時間切れ → 結果 → もう一度遊ぶ', async () => {
  const deps = makeDeps(7);
  const { roomId, joinCode } = await setupRoom(deps);
  await call(game.startGame, 'alice', { roomId }, T0, deps);

  let state = await server((db) => loadGame(db, roomId));
  assert.equal(state.phase, 'playing');
  assert.equal(state.gameId, 'game7');
  const hunter = state.players.find((p) => p.role === 'hunter').id;
  const [near, far] = state.players.filter((p) => p.role === 'runner').map((p) => p.id);
  assert.equal((await read(`rooms/${roomId}/meta`)).phase, 'playing');
  assert.ok(deps.scheduled.length >= 1, '次の処理が予約される');
  assert.equal(deps.scheduled[0].gameId, 'game7');

  // ゲーム中は参加できない
  await expectHttpsError(call(rooms.joinRoom, 'dave', { code: joinCode, name: 'デイブ' }, T0, deps), 'failed-precondition');

  // 位置: 鬼は開始地点、near は 5m 先、far は 150m 先
  const t1 = T0 + 1_000;
  assert.deepEqual(await locate(roomId, hunter, START, t1, deps), { ok: true });
  assert.deepEqual(await locate(roomId, near, at(5, 0), t1, deps), { ok: true });
  assert.deepEqual(await locate(roomId, far, at(150, 180), t1, deps), { ok: true });
  // 不自然に速い移動は無視される
  assert.deepEqual(await locate(roomId, far, at(150, 0), t1 + 1_000, deps), { ok: false, reason: 'too_fast' });

  // 公開範囲: 鬼は可能性エリアだけ、逃走者は仲間の位置、誰も実位置（/locations）を読めない
  await assertSucceeds(as(hunter).ref(`rooms/${roomId}/channels/possibleAreas`).get());
  await assertFails(as(hunter).ref(`rooms/${roomId}/channels/runnerPositions`).get());
  await assertSucceeds(as(near).ref(`rooms/${roomId}/channels/runnerPositions`).get());
  await assertFails(as(near).ref(`rooms/${roomId}/channels/possibleAreas`).get());
  await assertSucceeds(as(near).ref(`rooms/${roomId}/channels/hunterPositions`).get()); // 設定 ON（既定）
  await assertFails(as(hunter).ref(`locations/${roomId}`).get());
  await assertFails(as(near).ref(`rooms/${roomId}/views/${far}`).get());

  const areas = await readJson(`rooms/${roomId}/channels/possibleAreas`);
  assert.deepEqual(Object.keys(areas).sort(), [near, far].sort());
  assert.equal(areas[near].radiusM, 300);
  assert.equal(areas[near].center.lat === at(5, 0).lat, false, '円の中心は実位置ではない');
  const pubText = await read(`rooms/${roomId}/public/doc`);
  assert.ok(!pubText.includes(String(at(5, 0).lat)), 'public に逃走者の実位置が入っていない');
  const nearView = await readJson(`rooms/${roomId}/views/${near}`);
  assert.equal(nearView.blurM, 300);
  assert.ok(nearView.possibleArea, '自分がどう見えているか（自分の円）は本人のビューにある');

  // 確保: 対象はサーバーが選ぶ（一番近い near）。すぐ次はクールダウン
  const t2 = T0 + 3_000;
  assert.deepEqual(await call(game.requestCapture, near, { roomId }, t2, deps), { ok: false, reason: 'not_hunter' });
  assert.deepEqual(await call(game.requestCapture, hunter, { roomId }, t2, deps), { ok: true, capturedId: near });
  assert.deepEqual(await call(game.requestCapture, hunter, { roomId }, t2 + 500, deps), { ok: false, reason: 'cooldown' });
  const access = await read(`rooms/${roomId}/access`);
  assert.equal(access.players[near].status, 'caught');
  // 脱落者は仲間の位置も可能性エリアも読めない・位置も書けない
  await assertFails(as(near).ref(`rooms/${roomId}/channels/runnerPositions`).get());
  await assertFails(as(near).ref(`rooms/${roomId}/channels/possibleAreas`).get());
  await assertFails(as(near).ref(`locations/${roomId}/${near}`).set({ lat: 35, lng: 139, t: { '.sv': 'timestamp' } }));

  // 位置が古い逃走者は確保の対象にならない（15秒より古い位置は使わない）
  const t3 = t2 + 20_000;
  assert.deepEqual(await locate(roomId, hunter, at(150, 180), t3, deps), { ok: true }); // far の最後の位置の真上
  assert.deepEqual(await call(game.requestCapture, hunter, { roomId }, t3 + 100, deps), { ok: false, reason: 'no_target' });

  // ホスト以外は途中終了できない
  await expectHttpsError(call(game.abortGame, far, { roomId }, t3, deps), 'permission-denied');

  // 誰も操作しなくても、予約（advanceGame）で時間切れまで進む
  state = await server((db) => loadGame(db, roomId));
  let now = t3;
  for (let i = 0; i < 100 && state.phase === 'playing'; i++) {
    now = Math.max(now + 1, deps.scheduled.at(-1).dueAt);
    await server((db) => game.advanceGame(db, { roomId, gameId: 'game7' }, now, deps));
    state = await server((db) => loadGame(db, roomId));
  }
  assert.equal(state.phase, 'finished');
  assert.equal(state.result.winner, 'runners');
  assert.equal(state.result.reason, 'time_up');
  assert.deepEqual(state.positions, {}, '終了したら実位置を消す');
  assert.deepEqual(state.privacy.secrets, {}, '秘密値も消す');
  assert.equal(await read(`locations/${roomId}`), null);
  assert.deepEqual(await readJson(`rooms/${roomId}/channels/possibleAreas`), {});
  const pub = await readJson(`rooms/${roomId}/results/public`);
  assert.equal(pub.winner, 'runners');
  assert.equal(pub.personal, undefined, '公開の結果に個人の結果を含めない');
  assert.equal(pub.missions.length, 4);
  const mine = await readJson(`rooms/${roomId}/results/personal/${far}`);
  assert.equal(mine.missions.length, 4);
  await assertFails(as(hunter).ref(`rooms/${roomId}/results/personal/${far}`).get());

  // 古いゲームの予約は無視される
  assert.deepEqual(await server((db) => game.advanceGame(db, { roomId, gameId: 'old' }, now + 1, deps)), { ok: true, phase: 'finished' });

  // もう一度遊ぶ: ホストだけ。結果は消え、開始地点を設定し直してロビーへ
  await expectHttpsError(call(game.prepareRematch, 'bob', { roomId }, now, deps), 'permission-denied');
  await call(game.prepareRematch, 'alice', { roomId }, now, deps);
  assert.equal((await readJson(`rooms/${roomId}/public/doc`)).phase, 'setup');
  assert.equal(await read(`rooms/${roomId}/results`), null);
  await expectHttpsError(call(game.configureGame, 'alice', { roomId }, now, deps), 'invalid-argument');
  await call(game.configureGame, 'alice', { roomId, startPoint: at(50, 0), settings: { durationMin: 10 } }, now, deps);
  const lobby = await readJson(`rooms/${roomId}/public/doc`);
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.settings.durationMin, 10);
  assert.deepEqual(lobby.exclusionZones, [], '除外エリアも設定し直す');
  assert.ok(lobby.players.every((p) => p.role == null), '役割はリセットされる');
  await call(game.startGame, 'alice', { roomId }, now + 1, makeDeps(8));
  assert.equal((await server((db) => loadGame(db, roomId))).gameId, 'game8', 'ゲームIDは毎回新しい');
});

test('ミッション: 目的地は本人のビューだけ、到達の申告はサーバーの実位置で判定する', async () => {
  const deps = makeDeps(3);
  const { roomId } = await setupRoom(deps, { hunterCount: 1 });
  await call(game.startGame, 'alice', { roomId }, T0, deps);
  let state = await server((db) => loadGame(db, roomId));
  const hunter = state.players.find((p) => p.role === 'hunter').id;
  const runners = state.players.filter((p) => p.role === 'runner').map((p) => p.id);
  const first = state.missions.schedule[0];

  // 全員の位置（離れた場所）
  const positions = { [hunter]: at(250, 270), [runners[0]]: at(10, 0), [runners[1]]: at(10, 180) };
  let now = first.startsAt - 5_000;
  for (const [uid, pos] of Object.entries(positions)) await locate(roomId, uid, pos, now, deps);

  // ミッション開始（予約で進める）
  now = first.startsAt;
  await server((db) => game.advanceGame(db, { roomId, gameId: 'game3' }, now, deps));
  state = await server((db) => loadGame(db, roomId));
  assert.equal(state.missions.active.index, 1);
  const view0 = await readJson(`rooms/${roomId}/views/${runners[0]}`);
  const dest = view0.mission.destination;
  assert.ok(dest, '本人のビューには目的地がある');
  const hunterView = await readJson(`rooms/${roomId}/views/${hunter}`);
  assert.equal(hunterView.mission, null, '鬼のビューに目的地は無い');
  const pub = await readJson(`rooms/${roomId}/public/doc`);
  assert.equal(pub.mission.index, 1);
  assert.ok(!JSON.stringify(pub).includes(String(dest.lat)), 'public に目的地が入っていない');

  // 目的地から遠いのに申告しても成功にならない
  assert.deepEqual(await call(game.claimArrival, runners[0], { roomId }, now + 1_000, deps), { ok: false, reason: 'not_arrived' });
  // 目的地の変更は1回だけ
  assert.deepEqual(await call(game.changeDestination, runners[1], { roomId }, now + 1_000, deps), { ok: true });
  assert.deepEqual(await call(game.changeDestination, runners[1], { roomId }, now + 1_100, deps), { ok: false, reason: 'already_rerolled' });

  // 目的地まで歩いて（位置の更新で到達判定される）
  const stepTo = async (uid, from, to, t) => {
    // 12m/s 以内になるよう、少しずつ進む
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const pos = { lat: from.lat + ((to.lat - from.lat) * i) / steps, lng: from.lng + ((to.lng - from.lng) * i) / steps };
      await locate(roomId, uid, pos, t + i * 1_000, deps);
    }
    return t + steps * 1_000;
  };
  now = await stepTo(runners[0], positions[runners[0]], dest, now + 2_000);
  const after = await readJson(`rooms/${roomId}/views/${runners[0]}`);
  assert.equal(after.mission.result, 'success');
  assert.equal(after.mission.destination, null, '結果が出たら目的地は消える');
  assert.deepEqual(await call(game.claimArrival, runners[0], { roomId }, now + 1, deps), { ok: false, reason: 'not_in_mission' });

  // 制限時間で終了 → blurM が変わる（成功: 1段階大きく / 失敗: 1段階小さく）
  now = state.missions.active.endsAt;
  await server((db) => game.advanceGame(db, { roomId, gameId: 'game3' }, now, deps));
  assert.equal((await readJson(`rooms/${roomId}/views/${runners[0]}`)).blurM, 400);
  assert.equal((await readJson(`rooms/${roomId}/views/${runners[1]}`)).blurM, 200);
  const shared = await readJson(`rooms/${roomId}/public/doc`);
  assert.deepEqual(shared.lastMission, { index: 1, success: 1, failure: 1, cancelled: 0 }, '全員には人数だけ');
});

test('予約が止まったゲームは掃除係が進め、放置された部屋は消える', async () => {
  const deps = makeDeps(5);
  const { roomId } = await setupRoom(deps);
  await call(game.startGame, 'alice', { roomId }, T0, deps);
  const state = await server((db) => loadGame(db, roomId));
  // 予約が失われた（scheduledAt が古い）とする
  await server((db) => db.ref(`private/games/${roomId}/scheduledAt`).set(T0));
  const report = await server((db) => game.sweep(db, state.endsAt + 5 * 60_000, deps));
  assert.deepEqual(report.advanced, [roomId]);
  assert.equal((await server((db) => loadGame(db, roomId))).phase, 'finished');

  // 1日以上たった部屋は消える（参加コードも解放）
  const { joinCode } = await read(`rooms/${roomId}/meta`);
  const report2 = await server((db) => game.sweep(db, T0 + 25 * 60 * 60_000, deps));
  assert.deepEqual(report2.deleted, [roomId]);
  assert.equal(await read(`rooms/${roomId}`), null);
  assert.equal(await read(`private/games/${roomId}`), null);
  assert.equal(await read(`joinCodes/${joinCode}`), null);
});
