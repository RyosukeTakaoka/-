// ゲーム全体の流れを、Edge Function の中身（rooms.ts・game.ts・db.ts）を直接呼んで確認する。
// HTTP 層（http.ts の serveCallable）は薄いラッパーなので、ここではロジック本体だけを確認する。
// supabase start で local スタックが動いている前提（SUPABASE_DB_URL・SUPABASE_URL・SUPABASE_ANON_KEY が必要）。
//
//   deno test --allow-net --allow-env supabase/functions/_shared/tests/flow.test.ts

import { assertEquals, assertExists, assertNotEquals } from 'jsr:@std/assert@1';
import * as rooms from '../rooms.ts';
import * as game from '../game.ts';
import { sql, loadGame, HttpError } from '../db.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

async function signUp(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.user.id as string;
}

async function expectHttpError(fn: () => Promise<unknown>, status: number) {
  try {
    await fn();
    throw new Error('例外が発生しませんでした');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    assertEquals(err.status, status);
  }
}

Deno.test('部屋の作成・参加・退出', async () => {
  const alice = await signUp();
  const bob = await signUp();
  const mallory = await signUp();

  const created = await rooms.createRoom(Date.now(), alice, {
    name: '  アリス  ', settings: { durationMin: 20, hunterCount: 99 }, startPoint: { lat: 35, lng: 139 },
  });
  assertExists(created.roomId);
  assertEquals(created.hostUid, alice);
  assertEquals(created.joinCode.length, 4);

  const state1 = await loadGame(created.roomId);
  assertEquals(state1.phase, 'lobby');
  assertEquals(state1.settings.hunterCount, 10, '範囲外は丸める');
  assertEquals(state1.players[0].name, 'アリス', '前後の空白を除く');

  const joined = await rooms.joinRoom(Date.now(), bob, { code: created.joinCode, name: 'ボブ' });
  assertEquals(joined.roomId, created.roomId);
  assertEquals(joined.hostUid, alice, '参加してもホストにはならない');

  const state2 = await loadGame(created.roomId);
  assertEquals(state2.players.map((p: any) => p.id).sort(), [alice, bob].sort());

  await expectHttpError(() => rooms.joinRoom(Date.now(), mallory, { code: '0000', name: 'M' }), 404);

  const left = await rooms.leaveRoom(Date.now(), bob, { roomId: created.roomId });
  assertEquals(left.closed, false);
  const state3 = await loadGame(created.roomId);
  assertEquals(state3.players.map((p: any) => p.id), [alice]);

  const closed = await rooms.leaveRoom(Date.now(), alice, { roomId: created.roomId });
  assertEquals(closed.closed, true);
  assertEquals(await loadGame(created.roomId), null, 'ホストが退出したら部屋が消える');
});

Deno.test('ゲーム全体: 開始 → 位置 → 確保 → 途中終了 → 結果 → もう一度遊ぶ', async () => {
  const alice = await signUp();
  const bob = await signUp();
  const carol = await signUp();
  const T0 = Date.now();

  const created = await rooms.createRoom(T0, alice, {
    name: 'アリス', settings: { durationMin: 5, hunterCount: 1, revealIntervalSec: 30 },
    startPoint: { lat: 35.0, lng: 139.0 }, exclusionZones: [],
  });
  const roomId = created.roomId;
  await rooms.joinRoom(T0, bob, { code: created.joinCode, name: 'ボブ' });
  await rooms.joinRoom(T0, carol, { code: created.joinCode, name: 'キャロル' });

  await expectHttpError(() => game.startGame(T0, bob, { roomId }), 403); // ホスト以外は開始できない
  const started = await game.startGame(T0, alice, { roomId });
  assertExists(started.gameId);

  const state = await loadGame(roomId);
  assertEquals(state.phase, 'playing');
  const hunter = state.players.find((p: any) => p.role === 'hunter').id;
  const runners = state.players.filter((p: any) => p.role === 'runner').map((p: any) => p.id);

  // ゲーム中は参加できない
  const daveUid = await signUp();
  await expectHttpError(() => rooms.joinRoom(T0, daveUid, { code: created.joinCode, name: 'dave' }), 409);

  const t1 = T0 + 1000;
  assertEquals((await game.reportLocation(t1, hunter, { roomId, position: { lat: 35.0, lng: 139.0 } }) as any).ok, true);
  assertEquals((await game.reportLocation(t1, runners[0], { roomId, position: { lat: 35.00003, lng: 139.0 } }) as any).ok, true); // 約3.3m（確保距離10m以内）
  assertEquals((await game.reportLocation(t1, runners[1], { roomId, position: { lat: 35.002, lng: 139.0 } }) as any).ok, true); // 約220m

  // 鬼が読める possibleAreas に2人分入る。実位置そのものではない
  const [areasRow] = await sql`select data from channels where room_id = ${roomId} and name = 'possibleAreas'`;
  assertEquals(Object.keys(areasRow.data).sort(), [...runners].sort());
  assertNotEquals(areasRow.data[runners[0]].center.lat, 35.0001);

  // 逃走者が読める runnerPositions には仲間の実位置が入る／鬼の実位置は入らない
  const [runnerPosRow] = await sql`select data from channels where room_id = ${roomId} and name = 'runnerPositions'`;
  assertEquals(Object.keys(runnerPosRow.data).sort(), [...runners].sort());

  const t2 = T0 + 3000;
  const capture = await game.requestCapture(t2, hunter, { roomId });
  assertEquals(capture, { ok: true, capturedId: runners[0] });
  const cooldown = await game.requestCapture(t2 + 100, hunter, { roomId });
  assertEquals((cooldown as any).reason, 'cooldown');

  // 脱落者は仲間の位置を読めない（access テーブルの status で判断。RLS の判定用）
  const [access] = await sql`select players from access where room_id = ${roomId}`;
  assertEquals(access.players[runners[0]].status, 'caught');

  await expectHttpError(() => game.abortGame(t2 + 200, bob, { roomId }), 403);
  await game.abortGame(t2 + 200, alice, { roomId });

  const finished = await loadGame(roomId);
  assertEquals(finished.phase, 'finished');
  assertEquals(finished.result.reason, 'aborted');
  assertEquals(finished.positions, {}, '終了したら実位置を消す');
  const locRows = await sql`select 1 from locations where room_id = ${roomId}`;
  assertEquals(locRows.length, 0, '終了したら locations テーブルの行も消す');

  const [publicResult] = await sql`select data from results_public where room_id = ${roomId}`;
  assertEquals(publicResult.data.reason, 'aborted');
  assertEquals(publicResult.data.personal, undefined, '公開の結果に個人の結果を含めない');
  const [personal] = await sql`select data from results_personal where room_id = ${roomId} and uid = ${carol}`;
  assertExists(personal.data.missions);

  await expectHttpError(() => game.prepareRematch(t2 + 300, bob, { roomId }), 403);
  await game.prepareRematch(t2 + 300, alice, { roomId });
  const rematch = await loadGame(roomId);
  assertEquals(rematch.phase, 'setup');
  assertEquals(rematch.players.map((p: any) => p.id).sort(), [alice, bob, carol].sort());
  assertEquals(rematch.players.every((p: any) => p.role == null), true);
  const [resultsGone] = await sql`select count(*)::int as n from results_public where room_id = ${roomId}`;
  assertEquals(resultsGone.n, 0, 'もう一度遊ぶで前の結果は消える');

  await expectHttpError(() => game.configureGame(t2 + 400, alice, { roomId }), 400); // 開始地点が無い
  await game.configureGame(t2 + 400, alice, { roomId, startPoint: { lat: 35.1, lng: 139.1 }, settings: { durationMin: 10 } });
  const lobby = await loadGame(roomId);
  assertEquals(lobby.phase, 'lobby');
  assertEquals(lobby.settings.durationMin, 10);

  // 掃除係: 放置扱いにして部屋が消えることを確認
  const [{ id: dummyRoomId }] = await sql`
    insert into rooms (host_uid, join_code, phase, created_at) values (${alice}, '9999', 'lobby', now() - interval '2 days')
    returning id`;
  await sql`insert into game_state (room_id, state) values (${dummyRoomId}, ${sql.json({ phase: 'lobby' })})`;
  const report = await game.sweep(Date.now());
  assertEquals(report.deleted.includes(dummyRoomId), true);
  await sql`delete from rooms where id = ${roomId}`;
});

Deno.test('位置・ミッション: 到達判定と目的地の変更', async () => {
  const alice = await signUp();
  const bob = await signUp();
  const carol = await signUp();
  const T0 = Date.now();
  const created = await rooms.createRoom(T0, alice, {
    name: 'アリス', settings: { durationMin: 5, hunterCount: 1, revealIntervalSec: 30 },
    startPoint: { lat: 35.0, lng: 139.0 },
  });
  const roomId = created.roomId;
  await rooms.joinRoom(T0, bob, { code: created.joinCode, name: 'ボブ' });
  await rooms.joinRoom(T0, carol, { code: created.joinCode, name: 'キャロル' });
  await game.startGame(T0, alice, { roomId });
  let state = await loadGame(roomId);
  const runners = state.players.filter((p: any) => p.role === 'runner').map((p: any) => p.id);
  const first = state.missions.schedule[0];

  for (const uid of runners) {
    await game.reportLocation(first.startsAt - 5000, uid, { roomId, position: { lat: 35.0005, lng: 139.0 } });
  }
  await game.advanceGame(roomId, state.gameId, first.startsAt);
  state = await loadGame(roomId);
  assertEquals(state.missions.active.index, 1);

  const [view0] = await sql`select data from views where room_id = ${roomId} and uid = ${runners[0]}`;
  assertExists(view0.data.mission.destination, '本人のビューには目的地がある');
  const [hunterUid] = state.players.filter((p: any) => p.role === 'hunter').map((p: any) => p.id);
  const [hunterView] = await sql`select data from views where room_id = ${roomId} and uid = ${hunterUid}`;
  assertEquals(hunterView.data.mission, null, '鬼のビューに目的地は無い');

  const rerolled = await game.changeDestination(first.startsAt + 1000, runners[1], { roomId });
  assertEquals(rerolled, { ok: true });
  const again = await game.changeDestination(first.startsAt + 1100, runners[1], { roomId });
  assertEquals((again as any).reason, 'already_rerolled');

  await sql`delete from rooms where id = ${roomId}`;
});
