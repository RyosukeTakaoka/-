// STEP 7-B: RTDB Security Rules（エミュレーターで実際に許可・拒否されることを確認）
import test, { before, after, beforeEach } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnv, asServer } from './helpers.js';

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.cleanup(); });

// 部屋 r1（alice がホスト・bob がメンバー）、部屋 r2（carol がホスト）
beforeEach(async () => {
  await env.clearDatabase();
  await asServer(env, (db) => db.ref().set({
    joinCodes: { 1234: { roomId: 'r1', createdAt: 1 }, 5678: { roomId: 'r2', createdAt: 1 } },
    rooms: {
      r1: {
        meta: { hostUid: 'alice', joinCode: '1234', phase: 'lobby', createdAt: 1 },
        members: { alice: { name: 'アリス', joinedAt: 1 }, bob: { name: 'ボブ', joinedAt: 2 } },
        presence: { alice: { online: true, lastChanged: 1 } },
        public: { settings: { durationMin: 10 } },
        views: { alice: { blurM: 300 }, bob: { blurM: 300 } },
        results: { public: { winner: 'runners' }, personal: { alice: { x: 1 }, bob: { x: 1 } } },
      },
      r2: {
        meta: { hostUid: 'carol', joinCode: '5678', phase: 'lobby', createdAt: 1 },
        members: { carol: { name: 'キャロル', joinedAt: 1 } },
      },
    },
    locations: { r1: { alice: { lat: 35, lng: 139, t: 1 }, bob: { lat: 35.1, lng: 139.1, t: 1 } } },
    private: { r1: { game: { secret: 42 } }, rateLimits: { alice: { joinRoom: { count: 1, windowStart: 1 } } } },
  }));
});

const as = (uid) => env.authenticatedContext(uid).database();
const anon = () => env.unauthenticatedContext().database();

// ---- 成功するべき操作 ----

test('メンバーは部屋の meta・members・presence・public を読める', async () => {
  const bob = as('bob');
  for (const path of ['rooms/r1/meta', 'rooms/r1/members', 'rooms/r1/presence', 'rooms/r1/public']) {
    await assertSucceeds(bob.ref(path).get());
  }
});

test('自分のメンバー情報（名前）を変更できる', async () => {
  await assertSucceeds(as('bob').ref('rooms/r1/members/bob/name').set('ボブ2'));
});

test('自分の在席状態を更新できる（サーバー時刻）', async () => {
  const db = as('bob');
  await assertSucceeds(db.ref('rooms/r1/presence/bob').set({ online: true, lastChanged: { '.sv': 'timestamp' } }));
  await assertSucceeds(db.ref('rooms/r1/presence/bob').onDisconnect().set({ online: false, lastChanged: { '.sv': 'timestamp' } }));
});

test('自分の view・自分の個人結果・公開の結果は読める', async () => {
  const bob = as('bob');
  await assertSucceeds(bob.ref('rooms/r1/views/bob').get());
  await assertSucceeds(bob.ref('rooms/r1/results/personal/bob').get());
  await assertSucceeds(bob.ref('rooms/r1/results/public').get());
});

// ---- 拒否されるべき操作 ----

test('他人のメンバー情報は書き換えられない', async () => {
  const bob = as('bob');
  await assertFails(bob.ref('rooms/r1/members/alice/name').set('のっとり'));
  await assertFails(bob.ref('rooms/r1/members/alice').remove());
  await assertFails(bob.ref('rooms/r1/members').set({ bob: { name: 'ボブ', joinedAt: 2 } }));
});

test('hostUid・meta はホスト本人でも書き換えられない', async () => {
  await assertFails(as('bob').ref('rooms/r1/meta/hostUid').set('bob'));
  await assertFails(as('alice').ref('rooms/r1/meta/hostUid').set('alice'));
  await assertFails(as('alice').ref('rooms/r1/meta/phase').set('playing'));
  await assertFails(as('bob').ref('rooms/r1/meta').set({ hostUid: 'bob' }));
});

test('役割（role）やホストのフラグなど、名前以外のメンバー情報は書けない', async () => {
  const bob = as('bob');
  await assertFails(bob.ref('rooms/r1/members/bob/role').set('hunter'));
  await assertFails(bob.ref('rooms/r1/members/bob/isHost').set(true));
  await assertFails(bob.ref('rooms/r1/members/bob').set({ name: 'ボブ', joinedAt: 2, role: 'hunter' }));
  await assertFails(bob.ref('rooms/r1/members/bob').update({ joinedAt: 0 }));
});

test('名前の形式が正しくなければ拒否（空・長すぎ・削除）', async () => {
  const bob = as('bob');
  await assertFails(bob.ref('rooms/r1/members/bob/name').set(''));
  await assertFails(bob.ref('rooms/r1/members/bob/name').set('あ'.repeat(13)));
  await assertFails(bob.ref('rooms/r1/members/bob/name').set(123));
  await assertFails(bob.ref('rooms/r1/members/bob/name').remove());
});

test('他の部屋のメンバーを作ったり書き換えたりできない（部屋の外から入れない）', async () => {
  const bob = as('bob');
  await assertFails(bob.ref('rooms/r2/members/bob/name').set('ボブ'));
  await assertFails(bob.ref('rooms/r2/members/bob').set({ name: 'ボブ', joinedAt: 1 }));
  await assertFails(bob.ref('rooms/r2/members/carol/name').set('のっとり'));
  await assertFails(as('mallory').ref('rooms/r1/members/mallory').set({ name: 'M', joinedAt: 1 }));
  await assertFails(as('mallory').ref('rooms/r1/members/mallory/name').set('M'));
});

test('メンバーでない人は部屋の中身を読めない（部屋IDを知っていても）', async () => {
  const mallory = as('mallory');
  for (const path of ['rooms/r1/meta', 'rooms/r1/members', 'rooms/r1/presence', 'rooms/r1/public', 'rooms/r1/results/public']) {
    await assertFails(mallory.ref(path).get());
  }
  await assertFails(as('bob').ref('rooms/r2/members').get());
});

test('/locations はクライアントから読めない・書けない（自分の分も）', async () => {
  const alice = as('alice');
  await assertFails(alice.ref('locations').get());
  await assertFails(alice.ref('locations/r1').get());
  await assertFails(alice.ref('locations/r1/alice').get());
  await assertFails(alice.ref('locations/r1/bob').get());
  await assertFails(alice.ref('locations/r1/alice').set({ lat: 1, lng: 1, t: { '.sv': 'timestamp' } }));
  await assertFails(alice.ref('locations/r1/bob').set({ lat: 1, lng: 1 }));
});

test('/private はクライアントから読めない・書けない（ホストも）', async () => {
  const alice = as('alice');
  await assertFails(alice.ref('private').get());
  await assertFails(alice.ref('private/r1/game').get());
  await assertFails(alice.ref('private/rateLimits/alice').get());
  await assertFails(alice.ref('private/r1/game').set({ secret: 0 }));
  await assertFails(alice.ref('private/rateLimits/alice/joinRoom').remove());
});

test('他人の個人 view・他人の個人結果は読めない（ホストも）', async () => {
  await assertFails(as('bob').ref('rooms/r1/views/alice').get());
  await assertFails(as('alice').ref('rooms/r1/views/bob').get());
  await assertFails(as('alice').ref('rooms/r1/views').get());
  await assertFails(as('bob').ref('rooms/r1/results/personal/alice').get());
});

test('view・results・public・channels はクライアントから書けない', async () => {
  const alice = as('alice');
  await assertFails(alice.ref('rooms/r1/views/alice/blurM').set(1000));
  await assertFails(alice.ref('rooms/r1/results/public/winner').set('hunters'));
  await assertFails(alice.ref('rooms/r1/public/settings/durationMin').set(60));
  await assertFails(alice.ref('rooms/r1/channels/hunterPositions/alice').set({ lat: 1, lng: 1 }));
  await assertFails(alice.ref('rooms/r1/channels/runnerPositions').get());
});

test('参加コードだけでは何も得られない（コード一覧の読み取り・書き換え・部屋の中身）', async () => {
  const mallory = as('mallory');
  await assertFails(mallory.ref('joinCodes').get());
  await assertFails(mallory.ref('joinCodes/1234').get());
  await assertFails(mallory.ref('joinCodes/1234').set({ roomId: 'r2' }));
  await assertFails(mallory.ref('joinCodes/9999').set({ roomId: 'r1' }));
  await assertFails(as('bob').ref('joinCodes/1234').get());
});

test('他人の在席状態は書けない・形式外の在席状態は拒否', async () => {
  const bob = as('bob');
  await assertFails(bob.ref('rooms/r1/presence/alice').set({ online: false, lastChanged: { '.sv': 'timestamp' } }));
  await assertFails(bob.ref('rooms/r1/presence/bob').set({ online: 'yes', lastChanged: { '.sv': 'timestamp' } }));
  await assertFails(bob.ref('rooms/r1/presence/bob').set({ online: true, lastChanged: Date.now() + 3_600_000 }));
  await assertFails(bob.ref('rooms/r1/presence/bob').set({ online: true, lastChanged: { '.sv': 'timestamp' }, role: 'hunter' }));
  await assertFails(as('mallory').ref('rooms/r1/presence/mallory').set({ online: true, lastChanged: { '.sv': 'timestamp' } }));
});

test('ログインしていない人は何も読めない・書けない', async () => {
  const db = anon();
  for (const path of ['rooms', 'rooms/r1/meta', 'rooms/r1/members', 'joinCodes', 'locations', 'private']) {
    await assertFails(db.ref(path).get());
  }
  await assertFails(db.ref('rooms/r1/members/x/name').set('x'));
});

test('部屋の一覧やデータベース全体は読めない', async () => {
  await assertFails(as('alice').ref('rooms').get());
  await assertFails(as('alice').ref('rooms/r1').get());
  await assertFails(as('alice').ref('/').get());
  await assertFails(as('alice').ref('rooms/r3/meta').set({ hostUid: 'alice' }));
});
