-- 呼び出し回数の制限（4桁コードの総当たり・部屋の乱造を防ぐ）。functions/src/rateLimit.js の Postgres 版。
-- 1つの UPDATE/INSERT で「今の回数を見て、超えていなければ増やす」をアトミックに行う。

create or replace function consume_rate_limit(
  p_uid uuid, p_action text, p_max int, p_window_ms bigint, p_now timestamptz
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window_start timestamptz;
  v_count int;
begin
  select window_start, count into v_window_start, v_count
  from rate_limits where uid = p_uid and action = p_action for update;

  if v_window_start is null or p_now - v_window_start >= (p_window_ms || ' milliseconds')::interval then
    insert into rate_limits (uid, action, window_start, count) values (p_uid, p_action, p_now, 1)
      on conflict (uid, action) do update set window_start = p_now, count = 1;
    return true;
  end if;

  if v_count >= p_max then
    return false;
  end if;

  update rate_limits set count = count + 1 where uid = p_uid and action = p_action;
  return true;
end;
$$;
revoke all on function consume_rate_limit(uuid, text, int, bigint, timestamptz) from public;
