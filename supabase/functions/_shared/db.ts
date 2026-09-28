// サーバー専用のゲーム状態の読み書きと、公開用データ（テーブル）への書き出し
//
// Postgres 版の mutateGame() は、Firebase 版の RTDB トランザクション（store.js）と同じ役目を果たす:
//   1. 1つの DB トランザクションの中で「game_state の行をロックして読む → gameEngine の純粋関数で
//      新しい状態を作る → 書き戻す」を行う（SELECT ... FOR UPDATE で、同時に2人が確保しても順番に処理される）
//   2. 変わった部分だけを、読める人ごとのテーブル（public_doc・channels・views・access・results_*）へ書き出す
//   3. 次に何かが起きる時刻を game_state.scheduled_at に書く（Cloud Tasks の代わり。advance-due-games が見に行く）
//
// PostgREST（supabase-js の主な経路）は1リクエスト1文なので、複数の読み書きをまたぐロックを保証できない。
// そのため Edge Function からは Postgres に直接つなぎ（postgres.js）、明示的なトランザクションを使う。

import postgres from 'npm:postgres@3.4.7';
import * as engine from './game/gameEngine.js';
import { buildChannels } from './game/viewChannels.js';
import { resultViewFor } from './game/resultSummary.js';

const dbUrl = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DB_URL');
if (!dbUrl) throw new Error('SUPABASE_DB_URL がありません（ローカルでは supabase start が自動で設定します）');

// Edge Function の1インスタンスで使い回す（接続の張り直しを避ける）
export const sql = postgres(dbUrl, { max: 3 });

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const notFound = () => new HttpError(404, 'not-found', '部屋が見つかりません');

/** gameEngine が投げる Error（「ロビーからのみ開始できます」など）を、クライアントへ返せるエラーにする */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new HttpError(400, 'failed-precondition', message);
}

/**
 * ゲームの状態をトランザクションで更新する。
 * @param fn 純粋関数。HttpError を投げると、状態は変えずにそのエラーを呼び出し元へ返す
 */
export async function mutateGame<R>(
  roomId: string,
  now: number,
  fn: (state: any) => { state: any; result?: R },
): Promise<{ before: any; after: any; result: R | undefined }> {
  return await sql.begin('read write', async (tx) => {
    const rows = await tx`select state from game_state where room_id = ${roomId} for update`;
    if (rows.length === 0) throw notFound();
    const before = rows[0].state;

    let outcome: { state: any; result?: R };
    try {
      outcome = fn(before);
    } catch (err) {
      throw toHttpError(err);
    }
    const after = outcome.state;

    if (after !== before) {
      await tx`update game_state set state = ${sql.json(after)}, scheduled_at = null where room_id = ${roomId}`;
      await fanout(tx, roomId, before, after);
      const dueAt = engine.nextDueAt(after);
      if (dueAt != null) {
        await tx`update game_state set scheduled_at = ${new Date(dueAt).toISOString()} where room_id = ${roomId}`;
      }
    }
    return { before, after, result: outcome.result };
  });
}

/** Security（RLS）が参照する「誰がどの役割か」（ロール未定は 'none'。jsonb には null キーを入れられないため） */
function accessFor(state: any) {
  const players: Record<string, { role: string; status: string }> = {};
  for (const p of state.players) players[p.id] = { role: p.role ?? 'none', status: p.status ?? 'active' };
  return { phase: state.phase, showHunters: Boolean(state.settings?.showHuntersToRunners), players };
}

/** 状態の変化を、読める人ごとのテーブルへ書き出す（変わった部分だけ）。tx の中で呼ぶ（同じトランザクションにする） */
export async function fanout(tx: any, roomId: string, before: any, after: any) {
  const prev: any = before ? buildChannels(before) : null;
  const next: any = buildChannels(after);

  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

  if (!prev || changed(prev.public, next.public)) {
    await tx`insert into public_doc (room_id, doc) values (${roomId}, ${sql.json(next.public)})
      on conflict (room_id) do update set doc = excluded.doc`;
  }
  for (const name of ['hunterPositions', 'runnerPositions', 'possibleAreas'] as const) {
    if (!prev || changed(prev[name], next[name])) {
      await tx`insert into channels (room_id, name, data) values (${roomId}, ${name}, ${sql.json(next[name])})
        on conflict (room_id, name) do update set data = excluded.data`;
    }
  }
  const uids = new Set([...Object.keys(prev?.views ?? {}), ...Object.keys(next.views)]);
  for (const uid of uids) {
    if (!prev || changed(prev.views[uid], next.views[uid])) {
      if (next.views[uid] === undefined) {
        // 部屋から完全にいなくなった（退出した）プレイヤーの view は消す
        await tx`delete from views where room_id = ${roomId} and uid = ${uid}`;
      } else {
        await tx`insert into views (room_id, uid, data) values (${roomId}, ${uid}, ${sql.json(next.views[uid])})
          on conflict (room_id, uid) do update set data = excluded.data`;
      }
    }
  }

  const access = accessFor(after);
  if (!prev || changed(accessFor(before), access)) {
    await tx`insert into access (room_id, phase, show_hunters, players) values
      (${roomId}, ${access.phase}, ${access.showHunters}, ${sql.json(access.players)})
      on conflict (room_id) do update set phase = excluded.phase, show_hunters = excluded.show_hunters, players = excluded.players`;
  }
  if (before?.phase !== after.phase) {
    await tx`update rooms set phase = ${after.phase} where id = ${roomId}`;
  }

  // 結果（終了時に作られる）: 公開用と本人用に分ける
  if (!prev || changed(before?.resultSummary ?? null, after.resultSummary ?? null)) {
    if (after.resultSummary) {
      const { personal, ...shared } = after.resultSummary;
      await tx`insert into results_public (room_id, data) values (${roomId}, ${sql.json(shared)})
        on conflict (room_id) do update set data = excluded.data`;
      for (const p of after.players) {
        const view = resultViewFor(after.resultSummary, p.id).self;
        await tx`insert into results_personal (room_id, uid, data) values (${roomId}, ${p.id}, ${sql.json(view)})
          on conflict (room_id, uid) do update set data = excluded.data`;
      }
    } else {
      // もう一度遊ぶ: 前の結果を消す
      await tx`delete from results_public where room_id = ${roomId}`;
      await tx`delete from results_personal where room_id = ${roomId}`;
    }
  }

  // ゲームが終わったら、端末から届いた実位置も消す
  if (before?.phase === engine.PHASE.PLAYING && after.phase !== engine.PHASE.PLAYING) {
    await tx`delete from locations where room_id = ${roomId}`;
  }
}

export async function loadGame(roomId: string) {
  const rows = await sql`select state from game_state where room_id = ${roomId}`;
  return rows[0]?.state ?? null;
}

export { notFound };

