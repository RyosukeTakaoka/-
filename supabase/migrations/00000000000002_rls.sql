-- Row Level Security（RTDB 版の database.rules.json に相当）
--
-- 既定はすべて拒否。テーブルごとに「読める人」「書ける人」だけを許可する。
-- game_state・rate_limits は RLS を有効にしてポリシーを作らない = クライアントからは読み書きとも常に拒否
-- （Edge Function は service_role キーで接続するので RLS の対象にならず、そちらだけが読み書きできる）。

alter table rooms enable row level security;
alter table members enable row level security;
alter table presence enable row level security;
alter table access enable row level security;
alter table public_doc enable row level security;
alter table channels enable row level security;
alter table views enable row level security;
alter table results_public enable row level security;
alter table results_personal enable row level security;
alter table locations enable row level security;
alter table game_state enable row level security;
alter table rate_limits enable row level security;

-- ---- rooms / members / presence / access / public_doc: メンバーなら読める ----

create policy "members can read room" on rooms for select using (is_member(id));
create policy "members can read members" on members for select using (is_member(room_id));
create policy "members can read presence" on presence for select using (is_member(room_id));
create policy "members can read access" on access for select using (is_member(room_id));
create policy "members can read public_doc" on public_doc for select using (is_member(room_id));

-- 名前の変更は rename_self()（下）だけを通す。UPDATE ポリシーを作らないので、
-- テーブルへの直接の書き込み（joined_at や他人の名前を含む）はクライアントからは常に拒否される。

-- 在席は本人だけが書ける（表示用の目安。正確さは保証しない）
create policy "member can write own presence" on presence for insert
  with check (uid = auth.uid() and is_member(room_id));
create policy "member can update own presence" on presence for update
  using (uid = auth.uid() and is_member(room_id));

-- ---- channels: 役割・設定に応じて読める人だけ許可（buildChannels の規則） ----

create policy "hunters or shown can read hunterPositions" on channels for select using (
  name = 'hunterPositions' and is_member(room_id) and (
    is_active_hunter(room_id) or
    coalesce((select show_hunters from access where room_id = channels.room_id), false)
  )
);
create policy "active runners can read runnerPositions" on channels for select using (
  name = 'runnerPositions' and is_active_runner(room_id)
);
create policy "active hunters can read possibleAreas" on channels for select using (
  name = 'possibleAreas' and is_active_hunter(room_id)
);

-- ---- views: 本人だけ ----
create policy "self can read own view" on views for select using (uid = auth.uid());

-- ---- 結果: 公開分はメンバー全員、個人分は本人だけ ----
create policy "members can read results_public" on results_public for select using (is_member(room_id));
create policy "self can read results_personal" on results_personal for select using (uid = auth.uid());

-- ---- locations: クライアントからは直接書けない ----
-- Firebase 版は「本人が /locations に書く → DB トリガーが検証」という2段構成だったが、
-- Postgres 版では report-location という呼び出し型の Edge Function に統一する
-- （他の操作 (requestCapture など) と同じ形にして、検証をサーバー側の1か所にまとめるため）。
-- そのため locations には行レベルのポリシーを作らない。書けるのは service_role（Edge Function）だけ。

-- rooms・members・access・game_state などへの insert/update/delete はどのポリシーにも一致しないので、
-- クライアントからはすべて拒否される（サーバー（service_role の Edge Function）だけが書ける）。

-- 本人の名前だけを変更する（他の列は変更できない）。RLS を SECURITY DEFINER で迂回する唯一の入口
create or replace function rename_self(p_room_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_room_id) then
    raise exception 'この部屋のメンバーではありません';
  end if;
  if char_length(p_name) < 1 or char_length(p_name) > 12 then
    raise exception '名前は1〜12文字にしてください';
  end if;
  update members set name = p_name where room_id = p_room_id and uid = auth.uid();
end;
$$;
revoke all on function rename_self(uuid, text) from public;
grant execute on function rename_self(uuid, text) to authenticated;
