'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug'); // ?debug で地図タップにより位置を手動設定できる

  // ---- 保存データ ----
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch { /* 保存できなくても動作は続ける */ }
    },
  };

  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // DEBUG時はタブごとに別プレイヤーとして扱う
  let playerId = DEBUG ? null : store.get('playerId');
  if (!playerId) {
    playerId = randomId();
    if (!DEBUG) store.set('playerId', playerId);
  }
  $('name').value = store.get('name') || '';
  if (params.get('room')) $('join-code').value = params.get('room');

  const socket = io();
  let state = null;
  let myPos = null;
  let clockOffset = 0; // サーバー時刻 - 端末時刻

  // ---- 画面切り替え ----
  let viewingMap = false;
  function show(name) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    $(`screen-${name}`).classList.add('active');
    if (name === 'game') setTimeout(() => map && map.invalidateSize(), 50);
  }

  let toastTimer = null;
  function toast(text, ms = 2500) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function emit(event, payload) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res) => {
        if (!res || !res.ok) toast(res?.error || '通信エラー');
        resolve(res || { ok: false });
      });
    });
  }

  // ---- ホーム ----
  function nameValue() {
    const name = $('name').value.trim();
    if (!name) {
      toast('名前を入力してください');
      $('name').focus();
      return null;
    }
    store.set('name', name);
    return name;
  }

  $('btn-create').onclick = async () => {
    const name = nameValue();
    if (!name) return;
    const res = await emit('create', { name, playerId });
    if (res.ok) joined(res.code);
  };

  $('btn-join').onclick = async () => {
    const name = nameValue();
    if (!name) return;
    const code = $('join-code').value.trim();
    if (!/^\d{4}$/.test(code)) return toast('4桁の部屋コードを入力してください');
    const res = await emit('join', { code, name, playerId });
    if (res.ok) joined(res.code);
  };

  // 入室したらすぐに現在地を送る（入室前に送った位置はサーバーに届いていないため）
  function joined(code) {
    store.set('room', code);
    sendPos(true);
  }

  async function leave() {
    if (!confirm('部屋を出ますか？')) return;
    await emit('leave');
    store.set('room', null);
    state = null;
    viewingMap = false;
    clearMap();
    show('home');
  }
  $('btn-leave').onclick = leave;
  $('btn-leave2').onclick = leave;

  $('btn-share').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${state.code}`;
    const text = `リアル鬼ごっこに参加しよう！部屋コード: ${state.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'リアル鬼ごっこ', text, url }); } catch { /* キャンセル */ }
    } else {
      try {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast('コピーしました');
      } catch {
        toast(url, 5000);
      }
    }
  };

  // ---- ロビー ----
  const settingsForm = $('settings');
  settingsForm.addEventListener('change', () => {
    const fd = new FormData(settingsForm);
    const settings = {};
    for (const [k, v] of fd.entries()) settings[k] = k === 'mode' ? v : Number(v);
    settings.showHuntersToRunners = settingsForm.elements.showHuntersToRunners.checked;
    emit('settings', settings);
  });

  $('btn-start').onclick = async () => {
    if (!myPos) {
      if (!confirm('位置情報がまだ取得できていません。このまま開始しますか？')) return;
    }
    await emit('start');
  };
  $('btn-again').onclick = () => emit('lobby');
  $('btn-view-map').onclick = () => {
    viewingMap = true;
    render();
  };

  function renderPlayerList(ul, players, showRole) {
    ul.replaceChildren();
    for (const p of players) {
      const li = document.createElement('li');
      if (!p.connected) li.classList.add('off');
      const name = document.createElement('span');
      name.textContent = `${p.isHost ? '👑 ' : ''}${p.name}${p.id === state.you ? '（あなた）' : ''}`;
      const tag = document.createElement('span');
      tag.className = 'tag';
      const parts = [];
      if (showRole && p.role) parts.push(p.role === 'hunter' ? `👹 鬼（確保${p.catches}）` : p.status === 'caught' ? '⛓ 確保' : '🏃 逃げ切り');
      if (!showRole) parts.push(p.pos ? '📡 OK' : '📡 待機');
      if (!p.connected) parts.push('オフライン');
      tag.textContent = parts.join(' ');
      li.append(name, tag);
      ul.append(li);
    }
  }

  function renderLobby() {
    const isHost = state.hostId === state.you;
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = `(${state.players.length})`;
    renderPlayerList($('lobby-players'), state.players, false);
    for (const el of settingsForm.elements) {
      el.disabled = !isHost;
      if (document.activeElement === el) continue;
      if (el.type === 'checkbox') el.checked = !!state.settings[el.name];
      else if (el.name in state.settings) el.value = state.settings[el.name];
    }
    $('btn-start').classList.toggle('hidden', !isHost);
    $('btn-start').disabled = state.players.length < 2;
    $('wait-host').classList.toggle('hidden', isHost);
    $('gps-status').textContent = myPos
      ? `📡 位置情報OK（誤差 約${Math.round(myPos.acc)}m）${isHost ? ' ・ あなたの現在地がエリアの中心になります' : ''}`
      : '📡 位置情報を取得中…（許可してください）';
  }

  // ---- 地図 ----
  let map = null;
  const markers = new Map();
  let areaCircle = null;
  let catchCircle = null;
  let followMe = true;

  function ensureMap() {
    if (map) return;
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    map.setView(myPos ? [myPos.lat, myPos.lng] : [35.681, 139.767], 17);
    map.on('dragstart', () => { followMe = false; });
    if (DEBUG) {
      map.on('click', (e) => setMyPos({ lat: e.latlng.lat, lng: e.latlng.lng, acc: 5 }));
    }
  }

  function clearMap() {
    for (const m of markers.values()) m.remove();
    markers.clear();
    areaCircle?.remove();
    areaCircle = null;
    catchCircle?.remove();
    catchCircle = null;
  }

  function pinIcon(cls, emoji) {
    return L.divIcon({
      className: '',
      html: `<div class="pin ${cls}">${emoji}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  function upsertMarker(key, latlng, cls, emoji, label) {
    let m = markers.get(key);
    if (!m) {
      m = L.marker(latlng).addTo(map);
      m.bindTooltip('', { permanent: true, direction: 'bottom', offset: [0, 14], className: 'pin-label' });
      markers.set(key, m);
    }
    m.setLatLng(latlng);
    const iconKey = `${cls}|${emoji}`;
    if (m._iconKey !== iconKey) {
      m.setIcon(pinIcon(cls, emoji));
      m._iconKey = iconKey;
    }
    m.setTooltipContent(escapeHtml(label));
    return m;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function ago(t) {
    const sec = Math.max(0, Math.round((serverNow() - t) / 1000));
    return sec < 60 ? `${sec}秒前` : `${Math.floor(sec / 60)}分前`;
  }

  function renderMap() {
    ensureMap();
    const seen = new Set();
    const me = state.players.find((p) => p.id === state.you);

    if (state.center) {
      const c = [state.center.lat, state.center.lng];
      if (!areaCircle) {
        areaCircle = L.circle(c, { radius: state.settings.areaRadiusM, color: '#ef4444', weight: 2, fillOpacity: 0.04, interactive: false }).addTo(map);
      }
      areaCircle.setLatLng(c).setRadius(state.settings.areaRadiusM);
    }

    for (const p of state.players) {
      if (!p.pos) continue;
      const isSelf = p.id === state.you;
      const cls = `${p.status === 'caught' ? 'caught' : p.role || 'runner'}${isSelf ? ' self' : ''}`;
      const emoji = p.role === 'hunter' ? '👹' : p.status === 'caught' ? '⛓' : '🏃';
      upsertMarker(`p:${p.id}`, [p.pos.lat, p.pos.lng], cls, emoji, isSelf ? 'あなた' : p.name);
      seen.add(`p:${p.id}`);
    }

    // 鬼にだけ届く「公開された逃走者の位置」
    for (const r of state.revealed) {
      if (seen.has(`p:${r.id}`)) continue;
      upsertMarker(`r:${r.id}`, [r.lat, r.lng], 'revealed', '❓', `${r.name}（${ago(r.t)}）`);
      seen.add(`r:${r.id}`);
    }

    for (const [key, m] of markers) {
      if (!seen.has(key)) {
        m.remove();
        markers.delete(key);
      }
    }

    // 鬼は確保範囲を表示
    if (me?.role === 'hunter' && me.pos && state.phase === 'playing') {
      const c = [me.pos.lat, me.pos.lng];
      if (!catchCircle) {
        catchCircle = L.circle(c, { radius: state.settings.catchRadiusM, color: '#f87171', weight: 1, dashArray: '4', fillOpacity: 0.1, interactive: false }).addTo(map);
      }
      catchCircle.setLatLng(c).setRadius(state.settings.catchRadiusM);
    } else if (catchCircle) {
      catchCircle.remove();
      catchCircle = null;
    }

    if (followMe && myPos) map.panTo([myPos.lat, myPos.lng], { animate: true });
  }

  $('btn-center').onclick = () => {
    followMe = true;
    if (myPos && map) map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 17));
  };
  $('btn-log').onclick = () => $('log-panel').classList.toggle('hidden');

  // ---- ゲーム ----
  function serverNow() {
    return Date.now() + clockOffset;
  }

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderClock() {
    if (!state || state.phase === 'lobby') return;
    const now = serverNow();
    const left = state.endsAt - now;
    $('timer').textContent = fmt(left);
    $('timer').classList.toggle('danger', state.phase === 'playing' && left < 60000);
    $('reveal').textContent =
      state.phase === 'playing' && state.nextRevealAt ? `位置公開まで ${fmt(state.nextRevealAt - now)}` : '';
  }
  setInterval(renderClock, 250);

  function renderGame() {
    const me = state.players.find((p) => p.id === state.you);
    const badge = $('role-badge');
    badge.className = 'badge';
    if (me?.role === 'hunter') {
      badge.textContent = '👹 鬼';
      badge.classList.add('hunter');
    } else if (me?.status === 'caught') {
      badge.textContent = '⛓ 確保';
      badge.classList.add('caught');
    } else {
      badge.textContent = '🏃 逃走者';
      badge.classList.add('runner');
    }
    $('alive').textContent = `逃走者 残り ${state.aliveRunners}/${state.totalRunners}`;
    const playing = state.phase === 'playing';
    $('btn-catch').classList.toggle('hidden', !(playing && me?.role === 'hunter'));
    $('btn-surrender').classList.toggle('hidden', !(playing && me?.role === 'runner' && me.status === 'alive'));
    $('area-warning').classList.toggle('hidden', !(playing && me?.outOfArea));

    const log = $('log');
    log.replaceChildren();
    for (const entry of [...state.log].reverse()) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(entry.t - clockOffset).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      li.append(time, document.createTextNode(entry.text));
      log.append(li);
    }
    renderClock();
    renderMap();
  }

  $('btn-catch').onclick = async () => {
    const res = await emit('catch', {});
    if (res.ok) vibrate([100, 50, 100]);
  };

  $('btn-surrender').onclick = async () => {
    if (!confirm('鬼にタッチされましたか？確保されたことを報告します。')) return;
    await emit('surrender');
  };

  function renderResult() {
    const isHost = state.hostId === state.you;
    const me = state.players.find((p) => p.id === state.you);
    const won = me && ((state.winner === 'hunters') === (me.role === 'hunter'));
    $('result-title').textContent = state.winner === 'hunters' ? '👹 鬼の勝ち！' : '🏃 逃走者の勝ち！';
    $('result-sub').textContent = me?.role ? (won ? 'あなたの陣営の勝利！' : '残念…あなたの陣営の負け') : '';
    const sorted = [...state.players].sort((a, b) => (a.role === b.role ? b.catches - a.catches : a.role === 'hunter' ? -1 : 1));
    renderPlayerList($('result-players'), sorted, true);
    $('btn-again').classList.toggle('hidden', !isHost);
    $('wait-host-again').classList.toggle('hidden', isHost);
  }

  function render() {
    if (!state) return show('home');
    if (state.phase === 'lobby') {
      viewingMap = false;
      clearMap();
      renderLobby();
      show('lobby');
    } else if (state.phase === 'playing' || viewingMap) {
      show('game');
      renderGame();
    } else {
      renderResult();
      show('result');
    }
  }

  // ---- 通信イベント ----
  socket.on('state', (s) => {
    clockOffset = s.now - Date.now();
    const prevPhase = state?.phase;
    state = s;
    if (prevPhase === 'lobby' && s.phase === 'playing') {
      followMe = true;
      viewingMap = false;
    }
    render();
  });

  socket.on('event', (e) => {
    if (!state) return;
    const me = state.players.find((p) => p.id === state.you);
    if (e.type === 'start') {
      toast('ゲーム開始！', 3000);
      vibrate([300, 100, 300]);
    } else if (e.type === 'caught') {
      if (e.id === state.you) {
        toast('あなたは確保された…', 4000);
        vibrate([500, 200, 500]);
      } else {
        toast(`${e.name} が確保された！`);
        vibrate(200);
      }
    } else if (e.type === 'reveal') {
      if (me?.role === 'hunter') toast('🔔 逃走者の位置が公開された！');
      else toast('⚠ あなたの位置が鬼に公開された！');
      vibrate([100, 100, 100]);
    } else if (e.type === 'ended') {
      toast('ゲーム終了！', 3000);
      vibrate([800]);
    }
  });

  // 再接続したら自動で部屋に戻る
  socket.on('connect', () => {
    const room = store.get('room');
    const name = store.get('name');
    if (room && name && !DEBUG) {
      socket.emit('join', { code: room, name, playerId }, (res) => {
        if (res?.ok) sendPos(true);
        else {
          store.set('room', null);
          if (!state) show('home');
        }
      });
    }
  });

  // ---- 位置情報 ----
  let lastSent = 0;
  function sendPos(force = false) {
    if (!myPos || !store.get('room')) return;
    const now = Date.now();
    if (force || now - lastSent > 2000) {
      lastSent = now;
      socket.emit('pos', myPos);
    }
  }
  function setMyPos(pos) {
    myPos = pos;
    sendPos();
    if (state?.phase === 'lobby') renderLobby();
  }
  // 止まっていてGPSの更新が来なくても、定期的に位置を送り続ける
  setInterval(() => sendPos(true), 5000);

  if (DEBUG) {
    // デバッグ: 東京駅付近にランダム配置
    setMyPos({ lat: 35.681 + (Math.random() - 0.5) * 0.002, lng: 139.767 + (Math.random() - 0.5) * 0.002, acc: 5 });
  } else if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      (p) => setMyPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (err) => {
        $('gps-status').textContent = `📡 位置情報エラー: ${err.message}（HTTPSで開き、位置情報を許可してください）`;
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  } else {
    $('gps-status').textContent = '📡 この端末は位置情報に対応していません';
  }

  // ---- 画面を消灯させない ----
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* 非対応端末では無視 */ }
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('click', keepAwake, { once: true });

  show('home');
})();
