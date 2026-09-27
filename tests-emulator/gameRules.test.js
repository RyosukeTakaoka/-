// STEP 7-H: ゲーム中のデータに対する Security Rules の攻撃テスト（悪意のあるクライアントとして実行）
import test, { before, after, beforeEach } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnv, asServer } from './helpers.js';

let env;
before(async () => { env = await createTestEnv(); });
after(async () => { await env.cleanup(); });

// 部屋 r1 はゲーム中: hunter（鬼）・runner（逃走者）・caught（脱落）・zombie（増え鬼で鬼になった元逃走者）
async function seed({ phase = 'playing', showHunters = true } = {}) {
  await env.clearDatabase();
  await asServer(env, (db) => db.ref().set({
    rooms: {
      r1: {
        meta: { hostUid: 'hunter', joinCode: '1234', phase, createdAt: 1 },
        members: {
          hunter: { name: 'H', joinedAt: 1 }, runner: { name: 'R', joinedAt: 2 },
          runner2: { name: 'R2', joinedAt: 3 }, caught: { name: 'C', joinedAt: 4 }, zombie: { name: 'Z', joinedAt: 5 },
        },
        access: {
          phase,
          showHunters,
          players: {
            hunter: { role: 'hunter', status: 'active' },
            runner: { role: 'runner', status: 'active' },
            runner2: { role: 'runner', status: 'active' },
            caught: { role: 'runner', status: 'caught' },
            zombie: { role: 'hunter', status: 'active' },
          },
        },
        public: { doc: '{}' },
        channels: { hunterPositions: '{}', runnerPositions: '{}', possibleAreas: '{}' },
        views: { hunter: '{}', runner: '{}', runner2: '{}' },
      },
    },
    locations: { r1: { runner2: { lat: 35, lng: 139, t: 1 } } },
    private: { games: { r1: { state: '{}' } } },
  }));
}
beforeEach(() => seed());

const as = (uid) => env.authenticatedContext(uid).database();
const loc = (extra = {}) => ({ lat: 35.001, lng: 139.001, acc: 8, t: { '.sv': 'timestamp' }, ...extra });

test('参加中のプレイヤーは自分の位置を /locations に書ける（サーバー時刻）', async () => {
  await assertSucceeds(as('runner').ref('locations/r1/runner').set(loc()));
  await assertSucceeds(as('hunter').ref('locations/r1/hunter').set(loc({ acc: 0 })));
  await assertSucceeds(as('zombie').ref('locations/r1/zombie').set(loc()));
});

test('実位置は誰も読めない（自分の分も）', async () => {
  await assertFails(as('hunter').ref('locations/r1').get());
  await assertFails(as('hunter').ref('locations/r1/runner2').get());
  await assertFails(as('runner2').ref('locations/r1/runner2').get());
});

test('他人の位置・脱落者の位置・ゲーム外の位置は書けない', async () => {
  await assertFails(as('runner').ref('locations/r1/runner2').set(loc()));
  await assertFails(as('caught').ref('locations/r1/caught').set(loc()));
  await assertFails(as('mallory').ref('locations/r1/mallory').set(loc()));
  await seed({ phase: 'lobby' });
  await assertFails(as('runner').ref('locations/r1/runner').set(loc()));
  await seed({ phase: 'finished' });
  await assertFails(as('runner').ref('locations/r1/runner').set(loc()));
});

test('時刻 t の偽装・形式違い・2秒未満の連続書き込みは拒否', async () => {
  const runner = as('runner');
  await assertFails(runner.ref('locations/r1/runner').set(loc({ t: Date.now() - 60_000 })));
  await assertFails(runner.ref('locations/r1/runner').set(loc({ lat: 91 })));
  await assertFails(runner.ref('locations/r1/runner').set(loc({ lng: 'x' })));
  await assertFails(runner.ref('locations/r1/runner').set(loc({ role: 'hunter' })));
  await assertFails(runner.ref('locations/r1/runner').set({ lat: 35, lng: 139 }));
  await assertSucceeds(runner.ref('locations/r1/runner').set(loc()));
  await assertFails(runner.ref('locations/r1/runner').set(loc()));
  await assertFails(runner.ref('locations/r1/runner').remove());
});

test('鬼は可能性エリアと鬼の位置だけ読める（逃走者の位置は読めない）', async () => {
  for (const uid of ['hunter', 'zombie']) {
    await assertSucceeds(as(uid).ref('rooms/r1/channels/possibleAreas').get());
    await assertSucceeds(as(uid).ref('rooms/r1/channels/hunterPositions').get());
    await assertFails(as(uid).ref('rooms/r1/channels/runnerPositions').get());
  }
});

test('逃走者は仲間の位置と（設定 ON なら）鬼の位置を読める・可能性エリアは読めない', async () => {
  await assertSucceeds(as('runner').ref('rooms/r1/channels/runnerPositions').get());
  await assertSucceeds(as('runner').ref('rooms/r1/channels/hunterPositions').get());
  await assertFails(as('runner').ref('rooms/r1/channels/possibleAreas').get());
  await seed({ showHunters: false });
  await assertFails(as('runner').ref('rooms/r1/channels/hunterPositions').get());
  await assertFails(as('caught').ref('rooms/r1/channels/hunterPositions').get());
  await assertSucceeds(as('hunter').ref('rooms/r1/channels/hunterPositions').get());
});

test('脱落者は逃走者の位置も可能性エリアも読めない（鬼に教えられないように）', async () => {
  await assertFails(as('caught').ref('rooms/r1/channels/runnerPositions').get());
  await assertFails(as('caught').ref('rooms/r1/channels/possibleAreas').get());
  await assertSucceeds(as('caught').ref('rooms/r1/channels/hunterPositions').get()); // 設定 ON
});

test('ゲーム外ではどのチャンネルも読めない・メンバー以外は何も読めない', async () => {
  await assertFails(as('mallory').ref('rooms/r1/channels/hunterPositions').get());
  await assertFails(as('mallory').ref('rooms/r1/access').get());
  await seed({ phase: 'finished' });
  for (const name of ['hunterPositions', 'runnerPositions', 'possibleAreas']) {
    await assertFails(as('hunter').ref(`rooms/r1/channels/${name}`).get());
    await assertFails(as('runner').ref(`rooms/r1/channels/${name}`).get());
  }
});

test('ゲームの結果・役割・状態・チャンネルはクライアントから書けない', async () => {
  const runner = as('runner');
  await assertFails(runner.ref('rooms/r1/access/players/runner/role').set('hunter'));
  await assertFails(runner.ref('rooms/r1/access/players/hunter/status').set('caught'));
  await assertFails(runner.ref('rooms/r1/access/showHunters').set(true));
  await assertFails(runner.ref('rooms/r1/public/doc').set('{"result":{"winner":"runners"}}'));
  await assertFails(runner.ref('rooms/r1/views/runner').set('{"mission":{"result":"success"}}'));
  await assertFails(runner.ref('rooms/r1/channels/runnerPositions').set('{}'));
  await assertFails(as('hunter').ref('rooms/r1/channels/hunterPositions').set('{}'));
  await assertFails(runner.ref('private/games/r1/state').set('{}'));
  await assertFails(runner.ref('private/games/r1').get());
});
