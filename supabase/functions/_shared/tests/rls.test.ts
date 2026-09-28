// Row Level Security の攻撃テスト（database.rules.json 版の tests-emulator/gameRules.test.js に相当）。
// REST（PostgREST）を、各ユーザーのアクセストークンで直接呼び、読める・読めないを確認する。
//
//   deno test --allow-net --allow-env supabase/functions/_shared/tests/rls.test.ts

import { assertEquals } from 'jsr:@std/assert@1';
import * as rooms from '../rooms.ts';
import * as game from '../game.ts';
import { sql, loadGame } from '../db.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

async function signUp(): Promise<{ uid: string; token: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  return { uid: body.user.id, token: body.access_token };
}

/** そのユーザーとして REST を呼ぶ */
async function asUser(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const isEmpty = (r: { status: number; body: unknown }) => r.status === 200 && Array.isArray(r.body) && r.body.length === 0;
const hasRows = (r: { status: number; body: unknown }) => r.status === 200 && Array.isArray(r.body) && r.body.length > 0;

Deno.test('メンバーは部屋の情報を読める。メンバーでない人は何も読めない', async () => {
  const alice = await signUp();
  const bob = await signUp();
  const mallory = await signUp();
  const created = await rooms.createRoom(Date.now(), alice.uid, { name: 'アリス', startPoint: { lat: 35, lng: 139 } });
  await rooms.joinRoom(Date.now(), bob.uid, { code: created.joinCode, name: 'ボブ' });

  for (const uid of [alice, bob]) {
    assertEquals(hasRows(await asUser(uid.token, `/rooms?id=eq.${created.roomId}`)), true, 'meta');
    assertEquals(hasRows(await asUser(uid.token, `/members?room_id=eq.${created.roomId}`)), true, 'members');
    assertEquals(hasRows(await asUser(uid.token, `/public_doc?room_id=eq.${created.roomId}`)), true, 'public_doc');
    assertEquals(hasRows(await asUser(uid.token, `/access?room_id=eq.${created.roomId}`)), true, 'access');
  }
  assertEquals(isEmpty(await asUser(mallory.token, `/rooms?id=eq.${created.roomId}`)), true, '非メンバーは部屋を読めない');
  assertEquals(isEmpty(await asUser(mallory.token, `/members?room_id=eq.${created.roomId}`)), true);
  assertEquals(isEmpty(await asUser(mallory.token, `/public_doc?room_id=eq.${created.roomId}`)), true);

  await sql`delete from rooms where id = ${created.roomId}`;
});

Deno.test('game_state・rate_limits・locations はクライアントから読めない（RLS を有効にしてポリシーを作っていない）', async () => {
  const alice = await signUp();
  const created = await rooms.createRoom(Date.now(), alice.uid, { name: 'アリス', startPoint: { lat: 35, lng: 139 } });

  assertEquals(isEmpty(await asUser(alice.token, `/game_state?room_id=eq.${created.roomId}`)), true, 'ホストでも読めない');
  assertEquals(isEmpty(await asUser(alice.token, `/rate_limits?uid=eq.${alice.uid}`)), true);
  assertEquals(isEmpty(await asUser(alice.token, `/locations?room_id=eq.${created.roomId}`)), true);

  // 書き込みも拒否される（RLS でポリシーが無いテーブルへの insert/update。PostgREST は
  // 「対象0件」を 204 で返すので、実際に書き換わっていないかを見る）
  await asUser(alice.token, `/game_state?room_id=eq.${created.roomId}`, {
    method: 'PATCH', body: JSON.stringify({ state: { hacked: true } }),
  });
  const [row] = await sql`select state from game_state where room_id = ${created.roomId}`;
  assertEquals((row.state as any).hacked, undefined, 'game_state への直接書き込みは効果が無い');

  await sql`delete from rooms where id = ${created.roomId}`;
});

Deno.test('役割ごとのチャンネル: 鬼は可能性エリアだけ、逃走者は仲間の位置、脱落者はどちらも読めない', async () => {
  const alice = await signUp(); // ホスト
  const bob = await signUp();
  const carol = await signUp();
  const T0 = Date.now();
  const created = await rooms.createRoom(T0, alice.uid, {
    name: 'アリス', settings: { durationMin: 5, hunterCount: 1, captureRadiusM: 10 }, startPoint: { lat: 35.0, lng: 139.0 },
  });
  await rooms.joinRoom(T0, bob.uid, { code: created.joinCode, name: 'ボブ' });
  await rooms.joinRoom(T0, carol.uid, { code: created.joinCode, name: 'キャロル' });
  await game.startGame(T0, alice.uid, { roomId: created.roomId });
  const state = await loadGame(created.roomId);
  const users = { [alice.uid]: alice, [bob.uid]: bob, [carol.uid]: carol } as Record<string, { uid: string; token: string }>;
  const hunterId = state.players.find((p: any) => p.role === 'hunter').id;
  const runnerIds = state.players.filter((p: any) => p.role === 'runner').map((p: any) => p.id);
  const hunter = users[hunterId];
  const runner1 = users[runnerIds[0]];
  const runner2 = users[runnerIds[1]];

  const t1 = T0 + 1000;
  await game.reportLocation(t1, hunterId, { roomId: created.roomId, position: { lat: 35.0, lng: 139.0 } });
  await game.reportLocation(t1, runnerIds[0], { roomId: created.roomId, position: { lat: 35.00003, lng: 139.0 } }); // 約3.3m

  // 鬼: 可能性エリアは読める、逃走者の実位置は読めない
  assertEquals(hasRows(await asUser(hunter.token, `/channels?room_id=eq.${created.roomId}&name=eq.possibleAreas`)), true);
  assertEquals(isEmpty(await asUser(hunter.token, `/channels?room_id=eq.${created.roomId}&name=eq.runnerPositions`)), true);
  // 逃走者: 仲間の位置は読める、可能性エリアは読めない
  assertEquals(hasRows(await asUser(runner1.token, `/channels?room_id=eq.${created.roomId}&name=eq.runnerPositions`)), true);
  assertEquals(isEmpty(await asUser(runner1.token, `/channels?room_id=eq.${created.roomId}&name=eq.possibleAreas`)), true);

  // 脱落者: 確保後は仲間の位置も可能性エリアも読めない
  const capture = await game.requestCapture(t1 + 2000, hunterId, { roomId: created.roomId });
  const caughtId = (capture as any).capturedId;
  const caught = users[caughtId];
  assertEquals(isEmpty(await asUser(caught.token, `/channels?room_id=eq.${created.roomId}&name=eq.runnerPositions`)), true, '脱落者は仲間の位置を読めない');
  assertEquals(isEmpty(await asUser(caught.token, `/channels?room_id=eq.${created.roomId}&name=eq.possibleAreas`)), true);

  await sql`delete from rooms where id = ${created.roomId}`;
});

Deno.test('本人の view・結果だけが読める。他人の view・結果は読めない', async () => {
  const alice = await signUp();
  const bob = await signUp();
  const created = await rooms.createRoom(Date.now(), alice.uid, { name: 'アリス', startPoint: { lat: 35, lng: 139 } });
  await rooms.joinRoom(Date.now(), bob.uid, { code: created.joinCode, name: 'ボブ' });

  assertEquals(hasRows(await asUser(alice.token, `/views?room_id=eq.${created.roomId}&uid=eq.${alice.uid}`)), true, '本人の view は読める');
  assertEquals(isEmpty(await asUser(bob.token, `/views?room_id=eq.${created.roomId}&uid=eq.${alice.uid}`)), true, '他人の view は読めない');

  // 名前の変更は rename_self だけを通す
  const renamed = await asUser(bob.token, `/rpc/rename_self`, {
    method: 'POST', body: JSON.stringify({ p_room_id: created.roomId, p_name: 'ボブ2' }),
  });
  assertEquals(renamed.status, 204); // void を返す関数なので No Content
  const failRename = await asUser(bob.token, `/rpc/rename_self`, {
    method: 'POST', body: JSON.stringify({ p_room_id: created.roomId, p_name: '' }),
  });
  assertEquals(failRename.status >= 400, true, '空の名前は拒否される');

  // members テーブルへの直接更新（UPDATE ポリシーが無い）は効果が無い
  await asUser(alice.token, `/members?room_id=eq.${created.roomId}&uid=eq.${bob.uid}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'のっとり' }),
  });
  const [member] = await sql`select name from members where room_id = ${created.roomId} and uid = ${bob.uid}`;
  assertEquals(member.name, 'ボブ2', '他人の名前は書き換えられない（rename_self で変えた名前のまま）');

  await sql`delete from rooms where id = ${created.roomId}`;
});
