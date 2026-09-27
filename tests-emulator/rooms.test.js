// STEP 7-B: 部屋の作成・参加・退出（Cloud Functions のハンドラーをエミュレーター上で実行）
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as rooms from '../functions/src/rooms.js';
import { LIMITS } from '../functions/src/rateLimit.js';
import { createTestEnv, asServer, callAs } from './helpers.js';

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearDatabase(); });

const read = (path) => asServer(env, async (db) => (await db.ref(path).get()).val());
const as = (uid) => env.authenticatedContext(uid).database();
const expectHttpsError = async (promise, code) => {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `エラーコード ${err.code}（${err.message}）`);
    return true;
  });
};

test('匿名ユーザーが部屋を作れる: 内部ID と 4桁コードは別・ホストはサーバーが決める・設定はサーバーで検証', async () => {
  const r = await callAs(env, rooms.createRoom, 'alice', {
    name: '  アリス  ', settings: { durationMin: 20, hunterCount: 99, evil: true }, hostUid: 'mallory', isHost: true,
  });
  assert.match(r.roomId, /^[a-z0-9]{20}$/);
  assert.match(r.joinCode, /^\d{4}$/);
  assert.notEqual(r.roomId, r.joinCode);
  assert.deepEqual(await read(`joinCodes/${r.joinCode}`), { roomId: r.roomId, createdAt: (await read(`joinCodes/${r.joinCode}`)).createdAt });
  const meta = await read(`rooms/${r.roomId}/meta`);
  assert.equal(meta.hostUid, 'alice', 'クライアントが送った hostUid は使わない');
  assert.equal(meta.joinCode, r.joinCode);
  assert.equal(meta.phase, 'lobby');
  const members = await read(`rooms/${r.roomId}/members`);
  assert.deepEqual(Object.keys(members), ['alice']);
  assert.equal(members.alice.name, 'アリス');
  assert.deepEqual(Object.keys(members.alice).sort(), ['joinedAt', 'name'], '役割やホストのフラグは保存しない');
  const settings = JSON.parse(await read(`rooms/${r.roomId}/public/doc`)).settings;
  assert.equal(settings.durationMin, 20);
  assert.equal(settings.hunterCount, 10, '範囲外は丸める');
  assert.equal(settings.evil, undefined, '知らない項目は保存しない');
});

test('ログインしていない・名前が空なら作れない', async () => {
  await expectHttpsError(callAs(env, rooms.createRoom, null, { name: 'A' }), 'unauthenticated');
  await expectHttpsError(callAs(env, rooms.createRoom, 'alice', { name: '   ' }), 'invalid-argument');
});

test('4桁コードで別のユーザーが参加でき、メンバーは互いの公開情報を読める', async () => {
  const { roomId, joinCode } = await callAs(env, rooms.createRoom, 'alice', { name: 'アリス' });
  const joined = await callAs(env, rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ' });
  assert.deepEqual(joined, { roomId, joinCode, hostUid: 'alice' });
  assert.deepEqual(Object.keys(await read(`rooms/${roomId}/members`)).sort(), ['alice', 'bob']);
  // 参加後はクライアントとして読める・参加前（carol）は読めない
  await assertSucceeds(as('bob').ref(`rooms/${roomId}/members`).get());
  await assertSucceeds(as('alice').ref(`rooms/${roomId}/members/bob`).get());
  await assertFails(as('carol').ref(`rooms/${roomId}/members`).get());
  // 2回参加しても1人のまま（名前だけ更新）
  await callAs(env, rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ2' });
  const members = await read(`rooms/${roomId}/members`);
  assert.equal(Object.keys(members).length, 2);
  assert.equal(members.bob.name, 'ボブ2');
});

test('参加コードで参加してもホストにはならない・ホスト権限は取れない', async () => {
  const { roomId, joinCode } = await callAs(env, rooms.createRoom, 'alice', { name: 'アリス' });
  await callAs(env, rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ', hostUid: 'bob', isHost: true, role: 'hunter' });
  assert.equal((await read(`rooms/${roomId}/meta`)).hostUid, 'alice');
  assert.deepEqual(Object.keys((await read(`rooms/${roomId}/members/bob`))).sort(), ['joinedAt', 'name']);
  await assertFails(as('bob').ref(`rooms/${roomId}/meta/hostUid`).set('bob'));
  await assertFails(as('bob').ref(`joinCodes/${joinCode}`).get());
  // ホストでない人が退出しても部屋は残る
  const left = await callAs(env, rooms.leaveRoom, 'bob', { roomId });
  assert.equal(left.closed, false);
  assert.equal((await read(`rooms/${roomId}/meta`)).hostUid, 'alice');
});

test('参加できないケース: 形式違い・存在しないコード・ゲーム中・満員', async () => {
  await expectHttpsError(callAs(env, rooms.joinRoom, 'bob', { code: '12a4', name: 'ボブ' }), 'invalid-argument');
  await expectHttpsError(callAs(env, rooms.joinRoom, 'bob', { code: '12345', name: 'ボブ' }), 'invalid-argument');
  await expectHttpsError(callAs(env, rooms.joinRoom, 'bob', { code: '0000', name: 'ボブ' }), 'not-found');

  const { roomId, joinCode } = await callAs(env, rooms.createRoom, 'alice', { name: 'アリス' });
  await asServer(env, (db) => db.ref(`rooms/${roomId}/meta/phase`).set('playing'));
  await expectHttpsError(callAs(env, rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ' }), 'failed-precondition');
  await asServer(env, (db) => db.ref(`rooms/${roomId}/meta/phase`).set('lobby'));

  const many = Object.fromEntries(Array.from({ length: rooms.MAX_MEMBERS }, (_, i) => [`u${i}`, { name: `u${i}`, joinedAt: i }]));
  await asServer(env, (db) => db.ref(`rooms/${roomId}/members`).set(many));
  await expectHttpsError(callAs(env, rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ' }), 'resource-exhausted');
});

test('同時に同じ参加コードを作ろうとしても衝突しない（トランザクションで片方だけが確保）', async () => {
  const picks = (seq) => { let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; };
  const [a, b] = await Promise.all([
    asServer(env, (db) => rooms.allocateJoinCode(db, 'roomA', 1, picks(['1234', '1111']))),
    asServer(env, (db) => rooms.allocateJoinCode(db, 'roomB', 1, picks(['1234', '2222']))),
  ]);
  assert.notEqual(a, b);
  assert.ok([a, b].includes('1234'), 'どちらか一方が 1234 を確保する');
  const codes = await read('joinCodes');
  assert.equal(codes[a].roomId, 'roomA');
  assert.equal(codes[b].roomId, 'roomB');
  // すでに使われているコードは上書きしない
  await asServer(env, (db) => rooms.allocateJoinCode(db, 'roomC', 1, picks(['1234', '3333'])));
  assert.equal((await read('joinCodes/1234')).roomId === 'roomC', false);
});

test('ホストが退出すると部屋は解散し、参加コードも解放される', async () => {
  const { roomId, joinCode } = await callAs(env, rooms.createRoom, 'alice', { name: 'アリス' });
  await callAs(env, rooms.joinRoom, 'bob', { code: joinCode, name: 'ボブ' });
  const r = await callAs(env, rooms.leaveRoom, 'alice', { roomId });
  assert.equal(r.closed, true);
  assert.equal(await read(`rooms/${roomId}`), null);
  assert.equal(await read(`joinCodes/${joinCode}`), null);
  await expectHttpsError(callAs(env, rooms.joinRoom, 'carol', { code: joinCode, name: 'C' }), 'not-found');
});

test('参加の総当たり対策: 一定回数を超えると拒否される', async () => {
  const { max } = LIMITS.joinRoom;
  for (let i = 0; i < max; i++) {
    await expectHttpsError(callAs(env, rooms.joinRoom, 'mallory', { code: String(i).padStart(4, '0'), name: 'M' }, 1000), 'not-found');
  }
  await expectHttpsError(callAs(env, rooms.joinRoom, 'mallory', { code: '9999', name: 'M' }, 1000), 'resource-exhausted');
  // 別のユーザーには影響しない。時間がたてば解除
  await expectHttpsError(callAs(env, rooms.joinRoom, 'bob', { code: '9999', name: 'B' }, 1000), 'not-found');
  await expectHttpsError(callAs(env, rooms.joinRoom, 'mallory', { code: '9999', name: 'M' }, 1000 + LIMITS.joinRoom.windowMs), 'not-found');
});

test('不正な部屋IDでの退出は拒否', async () => {
  await expectHttpsError(callAs(env, rooms.leaveRoom, 'alice', { roomId: '../private' }), 'invalid-argument');
  await expectHttpsError(callAs(env, rooms.leaveRoom, null, { roomId: 'a'.repeat(20) }), 'unauthenticated');
});
