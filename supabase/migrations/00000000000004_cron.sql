-- 定期実行（pg_cron）: 1分ごとに advance-due-games を呼ぶ
--
-- Cloud Tasks の「1ゲームに1件、正確な時刻に予約する」方式ではなく、pg_cron の最短間隔（1分）で
-- 全部屋をポーリングする方式にした（Supabase には Cloud Tasks に相当するサービスがないため）。
-- 正しさには影響しない（advance-due-games/index.ts のコメント参照）。
--
-- pg_net で Edge Function を HTTP 呼び出しする。呼び出し先の URL と認証キーは、
-- Supabase Vault（秘密の値を暗号化して保存する仕組み）に入れておき、cron のジョブからはそこを読む。
-- 本番では supabase/production-setup.sql を1回実行して、Vault に本番の値を入れる（README 参照）。
-- ローカル（supabase start）では、Vault に値が無いので既定値（Kong ゲートウェイのコンテナ名・デモの
-- service_role キー）にフォールバックする。
--
-- なぜ ALTER DATABASE ... SET ではなく Vault か: ローカルの postgres ロールには使えるが、
-- 本番の Supabase ダッシュボード（SQL Editor）が使う権限では ALTER DATABASE が許可されていない
-- （"permission denied to set parameter" になる）。Vault は Supabase 側がこの用途のために
-- 用意している正式な仕組みで、ダッシュボードからの実行でも使える。

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function secret_or(p_name text, p_default text)
returns text language sql stable security definer set search_path = public, vault as $$
  select coalesce((select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1), p_default);
$$;

select cron.schedule(
  'advance-due-games',
  '* * * * *', -- 1分ごと（pg_cron の最短間隔）
  $$
  select net.http_post(
    url := secret_or('edge_base_url', 'http://kong:8000') || '/functions/v1/advance-due-games',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || secret_or(
        'service_role_key',
        -- ローカル（supabase start）のデモ用 service_role キー。本番の値ではない
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
