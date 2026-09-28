-- 本番の Supabase プロジェクトへ最初にデプロイしたあと、1回だけ実行する SQL。
-- pg_cron が advance-due-games を呼ぶときの URL と鍵を、ローカルの既定値から本番の値に差し替える。
--
-- 使い方:
--   1. <PROJECT_REF> をプロジェクトの参照ID（Project Settings → General → Reference ID）に置き換える
--   2. <SERVICE_ROLE_KEY> を Project Settings → API → service_role キーに置き換える
--      （この鍵は「秘密」です。Git には絶対に入れないでください）
--   3. Supabase ダッシュボードの SQL Editor に貼って実行する（`supabase db push` の後、1回だけでよい）
--
-- 実行しないと、pg_cron はローカル用の URL・デモの鍵のまま呼び出そうとして失敗し続けます
-- （ゲームは動きますが、時間経過で自動的に進む部分（位置の公開・ミッションの開始終了・時間切れ）が
--  「誰かが操作したとき」にしか進まなくなります。誰も操作しなければ最後まで進みません）。

alter database postgres set app.settings.edge_base_url = 'https://<PROJECT_REF>.supabase.co';
alter database postgres set app.settings.service_role_key = '<SERVICE_ROLE_KEY>';

-- 設定を反映させるため、実行中の接続をいったん切る（pg_cron の次回実行から新しい設定が使われる）
select pg_reload_conf();
