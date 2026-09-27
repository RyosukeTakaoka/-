'use strict';

// リアル鬼ごっこのゲームロジック（通信層に依存しない純粋なロジック）

const DEFAULT_SETTINGS = Object.freeze({
  durationMin: 15, // 制限時間（分）
  hunterCount: 1, // 鬼の人数
  catchRadiusM: 15, // 捕獲できる距離（メートル）
  revealIntervalSec: 60, // 逃走者の位置が鬼に公開される間隔（秒）
  areaRadiusM: 300, // エリア半径（メートル）
  showHuntersToRunners: true, // 逃走者に鬼の位置を常に見せるか
  mode: 'classic', // classic: 捕まったら牢屋 / zombie: 捕まったら鬼になる（増え鬼）
});

const SETTING_LIMITS = {
  durationMin: [1, 180],
  hunterCount: [1, 20],
  catchRadiusM: [3, 100],
  revealIntervalSec: [10, 600],
  areaRadiusM: [50, 5000],
};

const MAX_PLAYERS = 50;
const MAX_NAME_LENGTH = 16;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// 2地点間の距離（メートル、ハバーサイン公式）
function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isValidPosition(pos) {
  return (
    pos &&
    Number.isFinite(pos.lat) &&
    Number.isFinite(pos.lng) &&
    Math.abs(pos.lat) <= 90 &&
    Math.abs(pos.lng) <= 180
  );
}

function sanitizeName(name) {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function sanitizeSettings(input, current = DEFAULT_SETTINGS) {
  const next = { ...current };
  if (!input || typeof input !== 'object') return next;
  for (const [key, [min, max]] of Object.entries(SETTING_LIMITS)) {
    if (input[key] === undefined) continue;
    const n = Math.round(Number(input[key]));
    if (Number.isFinite(n)) next[key] = Math.min(max, Math.max(min, n));
  }
  if (typeof input.showHuntersToRunners === 'boolean') {
    next.showHuntersToRunners = input.showHuntersToRunners;
  }
  if (input.mode === 'classic' || input.mode === 'zombie') {
    next.mode = input.mode;
  }
  return next;
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class GameError extends Error {}

class Game {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map();
    this.phase = 'lobby'; // lobby | playing | ended
    this.startedAt = null;
    this.endsAt = null;
    this.center = null;
    this.lastRevealAt = null;
    this.revealed = []; // 最後に公開された逃走者の位置のスナップショット
    this.winner = null; // 'runners' | 'hunters'
    this.log = [];
  }

  addPlayer(id, name) {
    const cleanName = sanitizeName(name);
    if (!cleanName) throw new GameError('名前を入力してください');
    const existing = this.players.get(id);
    if (existing) {
      existing.name = cleanName;
      existing.connected = true;
      return existing;
    }
    if (this.phase !== 'lobby') throw new GameError('ゲームはすでに始まっています');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('部屋が満員です');
    const player = {
      id,
      name: cleanName,
      role: null, // 'runner' | 'hunter'
      status: 'alive', // 'alive' | 'caught'
      pos: null,
      connected: true,
      caughtAt: null,
      caughtBy: null,
      catches: 0,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (p) p.connected = connected;
  }

  updateSettings(byId, input) {
    this.assertHost(byId);
    if (this.phase !== 'lobby') throw new GameError('ゲーム中は設定を変更できません');
    this.settings = sanitizeSettings(input, this.settings);
  }

  assertHost(id) {
    if (id !== this.hostId) throw new GameError('ホストだけが操作できます');
  }

  start(byId, now = Date.now(), rng = Math.random) {
    this.assertHost(byId);
    if (this.phase === 'playing') throw new GameError('ゲームはすでに始まっています');
    const ids = [...this.players.keys()];
    if (ids.length < 2) throw new GameError('2人以上必要です');
    const hunterCount = Math.min(this.settings.hunterCount, ids.length - 1);
    const shuffled = shuffle(ids, rng);
    const hunters = new Set(shuffled.slice(0, hunterCount));

    for (const p of this.players.values()) {
      p.role = hunters.has(p.id) ? 'hunter' : 'runner';
      p.status = 'alive';
      p.caughtAt = null;
      p.caughtBy = null;
      p.catches = 0;
    }

    // エリアの中心はホストの現在地（なければ位置の分かる参加者の平均）
    const host = this.players.get(this.hostId);
    if (host && isValidPosition(host.pos)) {
      this.center = { lat: host.pos.lat, lng: host.pos.lng };
    } else {
      const known = [...this.players.values()].filter((p) => isValidPosition(p.pos));
      this.center = known.length
        ? {
            lat: known.reduce((s, p) => s + p.pos.lat, 0) / known.length,
            lng: known.reduce((s, p) => s + p.pos.lng, 0) / known.length,
          }
        : null;
    }

    this.phase = 'playing';
    this.startedAt = now;
    this.endsAt = now + this.settings.durationMin * 60 * 1000;
    this.winner = null;
    this.log = [];
    this.revealed = [];
    this.lastRevealAt = null;
    this.reveal(now);
    this.addLog(now, `ゲーム開始！鬼は ${[...hunters].map((id) => this.players.get(id).name).join('、')}`);
  }

  backToLobby(byId) {
    this.assertHost(byId);
    this.phase = 'lobby';
    this.startedAt = null;
    this.endsAt = null;
    this.center = null;
    this.revealed = [];
    this.lastRevealAt = null;
    this.winner = null;
    this.log = [];
    for (const p of this.players.values()) {
      p.role = null;
      p.status = 'alive';
      p.caughtAt = null;
      p.caughtBy = null;
      p.catches = 0;
    }
  }

  updatePosition(id, pos, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || !isValidPosition(pos)) return;
    const acc = Number.isFinite(pos.acc) ? Math.max(0, pos.acc) : null;
    p.pos = { lat: pos.lat, lng: pos.lng, acc, t: now };
  }

  reveal(now) {
    this.lastRevealAt = now;
    this.revealed = this.runners()
      .filter((p) => p.status === 'alive' && p.pos)
      .map((p) => ({ id: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, t: p.pos.t }));
  }

  runners() {
    return [...this.players.values()].filter((p) => p.role === 'runner');
  }

  aliveRunners() {
    return this.runners().filter((p) => p.status === 'alive');
  }

  // 鬼が逃走者を捕まえる（距離チェックあり）
  tryCatch(hunterId, runnerId, now = Date.now()) {
    if (this.phase !== 'playing') throw new GameError('ゲーム中ではありません');
    const hunter = this.players.get(hunterId);
    const runner = this.players.get(runnerId);
    if (!hunter || hunter.role !== 'hunter') throw new GameError('鬼だけが捕まえられます');
    if (!runner || runner.role !== 'runner' || runner.status !== 'alive') {
      throw new GameError('その人は捕まえられません');
    }
    if (!hunter.pos || !runner.pos) throw new GameError('位置情報がありません');
    const d = distanceM(hunter.pos, runner.pos);
    // GPSの誤差を考慮して、精度の分だけ少し余裕を持たせる（最大+20m）
    const slack = Math.min(20, ((hunter.pos.acc ?? 0) + (runner.pos.acc ?? 0)) / 2);
    if (d > this.settings.catchRadiusM + slack) {
      throw new GameError(`遠すぎます（約${Math.round(d)}m）`);
    }
    this.markCaught(runner, hunter, now);
    return runner;
  }

  // 鬼の一番近くにいる逃走者を捕まえる（鬼には逃走者のリアルタイム位置が見えないため）
  catchNearest(hunterId, now = Date.now()) {
    if (this.phase !== 'playing') throw new GameError('ゲーム中ではありません');
    const hunter = this.players.get(hunterId);
    if (!hunter || hunter.role !== 'hunter') throw new GameError('鬼だけが捕まえられます');
    if (!hunter.pos) throw new GameError('位置情報がありません');
    let nearest = null;
    let nearestD = Infinity;
    for (const r of this.aliveRunners()) {
      if (!r.pos) continue;
      const d = distanceM(hunter.pos, r.pos);
      if (d < nearestD) {
        nearest = r;
        nearestD = d;
      }
    }
    if (!nearest) throw new GameError('近くに逃走者がいません');
    try {
      return this.tryCatch(hunterId, nearest.id, now);
    } catch (err) {
      if (err instanceof GameError) throw new GameError('近くに逃走者がいません');
      throw err;
    }
  }

  // 逃走者が自己申告で捕まったことを報告する（タッチされたときなど）
  surrender(runnerId, now = Date.now()) {
    if (this.phase !== 'playing') throw new GameError('ゲーム中ではありません');
    const runner = this.players.get(runnerId);
    if (!runner || runner.role !== 'runner' || runner.status !== 'alive') {
      throw new GameError('報告できません');
    }
    this.markCaught(runner, null, now);
    return runner;
  }

  markCaught(runner, hunter, now) {
    runner.status = 'caught';
    runner.caughtAt = now;
    runner.caughtBy = hunter ? hunter.id : null;
    if (hunter) hunter.catches += 1;
    this.revealed = this.revealed.filter((r) => r.id !== runner.id);
    const by = hunter ? `${hunter.name} が ${runner.name} を確保！` : `${runner.name} が捕まった！`;
    if (this.settings.mode === 'zombie') {
      runner.role = 'hunter';
      runner.status = 'alive';
      this.addLog(now, `${by} ${runner.name} は鬼になった`);
    } else {
      this.addLog(now, by);
    }
    this.checkEnd(now);
  }

  // 定期処理。発生したイベントの種類を返す
  tick(now = Date.now()) {
    const events = [];
    if (this.phase !== 'playing') return events;
    if (now >= this.endsAt) {
      this.finish('runners', now, '逃げ切り成功！逃走者の勝ち');
      events.push('ended');
      return events;
    }
    if (now - this.lastRevealAt >= this.settings.revealIntervalSec * 1000) {
      this.reveal(now);
      events.push('reveal');
    }
    return events;
  }

  checkEnd(now) {
    if (this.phase !== 'playing') return;
    if (this.aliveRunners().length === 0) {
      this.finish('hunters', now, '全員確保！鬼の勝ち');
    }
  }

  finish(winner, now, message) {
    this.phase = 'ended';
    this.winner = winner;
    this.endsAt = Math.min(this.endsAt ?? now, now);
    this.addLog(now, message);
  }

  addLog(t, text) {
    this.log.push({ t, text });
    if (this.log.length > 100) this.log.shift();
  }

  isOutOfArea(p) {
    if (!this.center || !p.pos) return false;
    return distanceM(this.center, p.pos) > this.settings.areaRadiusM;
  }

  // プレイヤーごとに見せてよい情報だけに絞った状態を返す
  viewFor(viewerId, now = Date.now()) {
    const viewer = this.players.get(viewerId);
    const role = viewer?.role ?? null;
    const ended = this.phase === 'ended';

    const players = [...this.players.values()].map((p) => {
      const isSelf = p.id === viewerId;
      let visiblePos = null;
      if (p.pos) {
        if (isSelf || ended || this.phase === 'lobby') {
          visiblePos = p.pos;
        } else if (p.role === role) {
          visiblePos = p.pos; // 同じ陣営の仲間は常に見える
        } else if (p.role === 'hunter' && this.settings.showHuntersToRunners) {
          visiblePos = p.pos;
        }
      }
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        status: p.status,
        connected: p.connected,
        isHost: p.id === this.hostId,
        catches: p.catches,
        pos: visiblePos && { lat: visiblePos.lat, lng: visiblePos.lng, acc: visiblePos.acc, t: visiblePos.t },
        outOfArea: this.isOutOfArea(p),
      };
    });

    // 鬼には公開タイミングの逃走者の位置を渡す
    const revealed = role === 'hunter' || ended ? this.revealed : [];
    const nextRevealAt =
      this.phase === 'playing' ? this.lastRevealAt + this.settings.revealIntervalSec * 1000 : null;

    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      you: viewerId,
      settings: this.settings,
      now,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      nextRevealAt,
      lastRevealAt: this.lastRevealAt,
      center: this.center,
      winner: this.winner,
      players,
      revealed,
      aliveRunners: this.aliveRunners().length,
      totalRunners: this.runners().length,
      log: this.log.slice(-20),
    };
  }
}

module.exports = {
  Game,
  GameError,
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  distanceM,
  isValidPosition,
  sanitizeName,
  sanitizeSettings,
};
