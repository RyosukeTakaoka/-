// STEP 7-B: クライアント側のルームサービス（js/firebase/room.js）と在席状態
// npm の Firebase JS SDK（modular）でエミュレーターに接続し、Cloud Functions の代わりにハンドラーを直接呼ぶ。
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as rooms from '../functions/src/rooms.js';
import { createFirebaseRoomService } from '../oni-game/js/firebase/room.js';
import { createTestEnv, callAs, clientFor, waitFor } from './helpers.js';

let env;
const clients = [];
before(async () => { env = await createTestEnv(); });
after(async () => {
  for (const c of clients) await c.close();
  await env.cleanup();
});
beforeEach(async () => { await env.clearDatabase(); });

function serviceFor(uid) {
  const client = clientFor(uid);
  clients.push(client);
  const call = (name, data) => callAs(env, rooms[name], uid, data);
  const service = createFirebaseRoomService({ sdk: client.sdk, db: client.db, uid, call });
  let latest = service.getSnapshot();
  service.subscribe((s) => { latest = s; });
  return { service, client, latest: () => latest };
}

test('ホストが作成 → 別端末が4桁コードで参加 → メンバー・ホスト・在席がリアルタイムに同期する', async () => {
  const alice = serviceFor('alice');
  const bob = serviceFor('bob');
  await alice.service.createRoom({ name: 'アリス', settings: { durationMin: 30 } });
  const { joinCode, roomId } = alice.latest().room;
  assert.match(joinCode, /^\d{4}$/);
  await waitFor(alice.latest, (s) => s.members.length === 1 && s.settings?.durationMin === 30);

  await bob.service.joinRoom({ code: joinCode, name: 'ボブ' });
  assert.equal(bob.latest().room.roomId, roomId);

  // アリスの画面にボブが現れる（リアルタイム同期）
  const s = await waitFor(alice.latest, (v) => v.members.length === 2 && v.members.every((m) => m.online));
  assert.deepEqual(s.members.map((m) => [m.name, m.isHost]), [['アリス', true], ['ボブ', false]]);
  const b = await waitFor(bob.latest, (v) => v.members.length === 2 && v.settings?.durationMin === 30);
  assert.equal(b.members.find((m) => m.id === 'alice').isHost, true, 'ホストは meta.hostUid で判定');
  assert.equal(b.members.find((m) => m.id === 'bob').isHost, false);
});

test('接続が切れると在席がオフラインになる（onDisconnect）', async () => {
  const alice = serviceFor('alice');
  const bob = serviceFor('bob');
  await alice.service.createRoom({ name: 'アリス' });
  await bob.service.joinRoom({ code: alice.latest().room.joinCode, name: 'ボブ' });
  await waitFor(alice.latest, (v) => v.members.find((m) => m.id === 'bob')?.online === true);
  bob.client.sdk.goOffline(bob.client.db);
  const s = await waitFor(alice.latest, (v) => v.members.find((m) => m.id === 'bob')?.online === false);
  assert.equal(s.members.length, 2, 'オフラインでもメンバーには残る');
  bob.client.sdk.goOnline(bob.client.db);
  await waitFor(alice.latest, (v) => v.members.find((m) => m.id === 'bob')?.online === true);
});

test('退出するとメンバーから消え、ホストが退出すると部屋が解散したことが伝わる', async () => {
  const alice = serviceFor('alice');
  const bob = serviceFor('bob');
  const carol = serviceFor('carol');
  await alice.service.createRoom({ name: 'アリス' });
  const code = alice.latest().room.joinCode;
  await bob.service.joinRoom({ code, name: 'ボブ' });
  await carol.service.joinRoom({ code, name: 'キャロル' });
  await waitFor(alice.latest, (v) => v.members.length === 3);

  await carol.service.leaveRoom();
  assert.equal(carol.latest().room, null);
  await waitFor(alice.latest, (v) => v.members.length === 2);

  await alice.service.leaveRoom();
  const b = await waitFor(bob.latest, (v) => v.closed === true);
  assert.equal(b.closed, true);
});
