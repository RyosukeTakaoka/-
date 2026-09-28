// 呼び出し型 Edge Function の共通処理（Cloud Functions 版の onCall・common.js に相当）
//
// Supabase の Edge Function は「素の HTTP リクエストを受ける関数」なので、onCall のような
// 「認証済みユーザーを渡してくれる」仕組みは無い。ここで JWT を読んで uid を取り出し、
// 同じ形（handler(now, uid, data, deps) => 結果 の JSON）にそろえる。

import { HttpError } from './db.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/**
 * 呼び出し型関数の入口。iOS からは Authorization: Bearer <アクセストークン> を付けて呼ぶ
 * （supabase-swift の functions.invoke がこれを自動で付ける）。
 */
export function serveCallable(handler: (now: number, uid: string, data: any) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) throw new HttpError(401, 'unauthenticated', 'ログインしてください');
      const uid = await verifyUser(authHeader);

      const data = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      const result = await handler(Date.now(), uid, data ?? {});
      return json(result); // Supabase の Edge Function は普通の HTTP ハンドラーなので、Firebase の
      // onCall のような { data: ... } の包み紙は付けない（クライアントは結果をそのままデコードする）
    } catch (err) {
      const httpErr = err instanceof HttpError ? err : new HttpError(500, 'internal', (err as Error)?.message ?? '不明なエラー');
      return json({ error: { code: httpErr.code, message: httpErr.message } }, httpErr.status);
    }
  });
}

/**
 * アクセストークンから uid を取り出す。SDK（@supabase/supabase-js）は使わず、
 * Auth（GoTrue）の /auth/v1/user を直接呼ぶ（本人確認だけが目的。DB へは _shared/db.ts が
 * Postgres に直接、service_role の権限でつなぐので、こちらの結果を経由しない）。
 */
async function verifyUser(authHeader: string): Promise<string> {
  const base = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('SUPABASE_INTERNAL_URL') ?? 'http://kong:8000';
  const res = await fetch(`${base}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
  });
  if (!res.ok) throw new HttpError(401, 'unauthenticated', 'ログインしてください');
  const user = await res.json();
  if (!user?.id) throw new HttpError(401, 'unauthenticated', 'ログインしてください');
  return user.id as string;
}
