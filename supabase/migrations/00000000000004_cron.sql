-- 定期実行（pg_cron）: 1分ごとに advance-due-games を呼ぶ
--
-- Cloud Tasks の「1ゲームに1件、正確な時刻に予約する」方式ではなく、pg_cron の最短間隔（1分）で
-- 全部屋をポーリングする方式にした（Supabase には Cloud Tasks に相当するサービスがないため）。
-- 正しさには影響しない（advance-due-games/index.ts のコメント参照）。
--
-- pg_net で Edge Function を HTTP 呼び出しする。呼び出し先の URL と認証キーは、
-- 本番では下の値をプロジェクトの実際の値に置き換える必要がある（README の「本番のSupabaseを使うとき」参照）。
-- ローカル（supabase start）では、この既定値（Kong ゲートウェイのコンテナ名・デモの service_role キー）で動く。

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 呼び出し先の設定。本番デプロイ後に「本番用の設定」の SQL で上書きする
select cron.schedule(
  'advance-due-games',
  '* * * * *', -- 1分ごと（pg_cron の最短間隔）
  $$
  select net.http_post(
    url := coalesce(current_setting('app.settings.edge_base_url', true), 'http://kong:8000') || '/functions/v1/advance-due-games',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        current_setting('app.settings.service_role_key', true),
        -- ローカル（supabase start）のデモ用 service_role キー。本番の値ではない
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
