-- 本番の Supabase プロジェクトへ最初にデプロイしたあと、1回だけ実行する SQL。
-- pg_cron が advance-due-games を呼ぶときの URL と鍵を、Supabase Vault（秘密の値を暗号化して
-- 保存する仕組み）に登録する。
--
-- 使い方:
--   1. <PROJECT_REF> をプロジェクトの参照ID（Project Settings → General → Reference ID）に置き換える
--   2. <SECRET_KEY> を Project Settings → API Keys → Secret key に置き換える
--      （新しい呼び方。以前の service_role キーと同じ役割。この鍵は「秘密」です。
--       Git には絶対に入れないでください）
--   3. Supabase ダッシュボードの SQL Editor に貼って実行する（`supabase db push` の後、1回だけでよい）
--
-- 実行しないと、pg_cron はローカル用の URL・デモの鍵のまま呼び出そうとして失敗し続けます
-- （ゲームは動きますが、時間経過で自動的に進む部分（位置の公開・ミッションの開始終了・時間切れ）が
--  「誰かが操作したとき」にしか進まなくなります。誰も操作しなければ最後まで進みません）。
--
-- 2回目以降に実行するとき（キーを作り直した等）は、先に古い値を消してから実行してください:
--   select vault.delete_secret(id) from vault.secrets where name in ('edge_base_url', 'service_role_key');

select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'edge_base_url', 'advance-due-games を呼ぶ URL');
select vault.create_secret('<SECRET_KEY>', 'service_role_key', 'advance-due-games を呼ぶときの認証キー');
