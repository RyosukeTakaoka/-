// 定期実行（pg_cron が1分ごとに呼ぶ）。Firebase 版の advanceGame（Cloud Tasks の予約）と
// sweepRooms（Cloud Scheduler）を1つにまとめたもの:
//   - game_state.scheduled_at が過去になっているゲームを進める（公開・ミッション・時間切れ）
//   - ゲーム中でない部屋の実位置の削除・放置された部屋（1日）の削除
//
// Cloud Tasks のように「1ゲームに1件、正確な時刻に」予約するのではなく、1分ごとに全部屋を見に行く方式。
// 正しさには影響しない: どの要求（確保・到達など）も先に advance() で遅れを片付けるため、
// 予約の実行が1分未満ずれても、時間切れ後の確保や終了後の到達は成立しない（詳しくは ios/README.md）。
//
// 呼べるのは service_role のトークンだけ（pg_cron からの呼び出しに使う）。ユーザーの操作では呼ばれない。

import { sweep } from '../_shared/game.ts';

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
  if (auth !== expected) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  const report = await sweep(Date.now());
  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
});
