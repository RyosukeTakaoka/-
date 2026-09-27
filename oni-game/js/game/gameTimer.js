// ゲームの残り時間

/** 残りミリ秒（0未満にはならない） */
export function remainingMs(endsAt, now = Date.now()) {
  return Math.max(0, endsAt - now);
}

/** 「09:58」形式 */
export function formatClock(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 終了時刻までカウントダウンし、毎回 onTick(残りms)、0 になったら onEnd() を呼ぶ。
 * @returns {() => void} 停止する関数
 */
export function startCountdown({ endsAt, onTick, onEnd, intervalMs = 250, now = () => Date.now() }) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const left = remainingMs(endsAt, now());
    onTick?.(left);
    if (left === 0) {
      stop();
      onEnd?.();
    }
  };
  const id = setInterval(tick, intervalMs);
  function stop() {
    stopped = true;
    clearInterval(id);
  }
  tick();
  return stop;
}
