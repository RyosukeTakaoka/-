-- リアル鬼ごっこ: テーブル設計（Firebase Realtime Database 版のパス構成を Postgres に置き換えたもの）
--
-- Firebase 版と同じ考え方: 「誰が何を読めるか」ごとに置き場所を分ける。
--   rooms / members / presence            … 部屋の情報（メンバー全員が読める）
--   game_state                            … サーバー専用の状態（実位置・秘密値・目的地を含む）。誰も読めない
--   access                                … 各人の役割・状態。Row Level Security の判定用（サーバーだけが書く）
--   public_doc                            … 全員に見せてよいゲーム情報（buildChannels(state).public と同じ形）
--   channels                              … 鬼の位置・仲間の位置・可能性エリア（読める人はロールで制限）
--   views                                 … 本人だけのデータ（自分の円・目的地・クールダウン）
--   results_public / results_personal     … 結果
--   locations                             … 実位置。読み取りは誰にも許可しない（Edge Function だけが読む）
--   rate_limits                           … 呼び出し回数の制限（サーバー専用）
--
-- ゲームの状態やビューは JSON（jsonb）でそのまま保存する。gameEngine.js の state はネストしたオブジェクトで、
-- テーブルに正規化すると Firebase 版と同じ形を保てなくなるため。

create extension if not exists pgcrypto; -- gen_random_uuid() 用

create table rooms (
  id uuid primary key default gen_random_uuid(),
  host_uid uuid not null references auth.users (id),
  join_code text not null unique,
  phase text not null default 'setup',
  created_at timestamptz not null default now()
);

create table members (
  room_id uuid not null references rooms (id) on delete cascade,
  uid uuid not null references auth.users (id),
  name text not null check (char_length(name) between 1 and 12),
  joined_at timestamptz not null default now(),
  primary key (room_id, uid)
);

create table presence (
  room_id uuid not null references rooms (id) on delete cascade,
  uid uuid not null references auth.users (id),
  online boolean not null,
  last_changed timestamptz not null default now(),
  primary key (room_id, uid)
);

-- Security の判定に使う（buildChannels の access に相当）。役割未定は 'none'
create table access (
  room_id uuid primary key references rooms (id) on delete cascade,
  phase text not null,
  show_hunters boolean not null default true,
  players jsonb not null default '{}'::jsonb -- { [uid]: { role, status } }
);

create table public_doc (
  room_id uuid primary key references rooms (id) on delete cascade,
  doc jsonb not null
);

create table channels (
  room_id uuid not null references rooms (id) on delete cascade,
  name text not null check (name in ('hunterPositions', 'runnerPositions', 'possibleAreas')),
  data jsonb not null,
  primary key (room_id, name)
);

create table views (
  room_id uuid not null references rooms (id) on delete cascade,
  uid uuid not null references auth.users (id),
  data jsonb not null,
  primary key (room_id, uid)
);

create table results_public (
  room_id uuid primary key references rooms (id) on delete cascade,
  data jsonb not null
);

create table results_personal (
  room_id uuid not null references rooms (id) on delete cascade,
  uid uuid not null references auth.users (id),
  data jsonb not null,
  primary key (room_id, uid)
);

-- 実位置。読み取りは誰にも許可しない（Edge Function は service_role で読むのでポリシーの影響を受けない）
create table locations (
  room_id uuid not null references rooms (id) on delete cascade,
  uid uuid not null references auth.users (id),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  acc double precision check (acc between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (room_id, uid)
);

-- サーバー専用のゲーム状態。gameEngine.js の state を丸ごと JSON で持つ
create table game_state (
  room_id uuid primary key references rooms (id) on delete cascade,
  state jsonb not null,
  scheduled_at timestamptz
);

create table rate_limits (
  uid uuid not null,
  action text not null,
  window_start timestamptz not null,
  count int not null,
  primary key (uid, action)
);

-- ---- 参照用の索引 ----
create index members_uid_idx on members (uid);
create index game_state_scheduled_idx on game_state (scheduled_at) where scheduled_at is not null;

-- ---- 共通の判定関数（RLS ポリシーから呼ぶ） ----

-- 自分がその部屋のメンバーか
create or replace function is_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where room_id = p_room_id and uid = auth.uid());
$$;

-- 自分がその部屋で「参加中の鬼」か
create or replace function is_active_hunter(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (players -> auth.uid()::text ->> 'role') = 'hunter'
       and (players -> auth.uid()::text ->> 'status') = 'active'
     from access where room_id = p_room_id),
    false
  );
$$;

-- 自分がその部屋で「参加中の逃走者」か
create or replace function is_active_runner(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (players -> auth.uid()::text ->> 'role') = 'runner'
       and (players -> auth.uid()::text ->> 'status') = 'active'
     from access where room_id = p_room_id),
    false
  );
$$;

comment on table game_state is 'サーバー専用。クライアントからは読み書きとも不可（RLS を有効にしてポリシーを作らない = 既定で拒否）';
comment on table rate_limits is 'サーバー専用。クライアントからは読み書きとも不可';
