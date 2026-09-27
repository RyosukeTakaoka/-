'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../src/server');

function call(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextState(socket, pred = () => true) {
  return new Promise((resolve) => {
    const h = (s) => {
      if (pred(s)) {
        socket.off('state', h);
        resolve(s);
      }
    };
    socket.on('state', h);
  });
}

test('部屋作成→参加→開始→確保までの流れ', async (t) => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const a = connect(url);
  const b = connect(url);
  t.after(() => {
    a.close();
    b.close();
    server.close();
  });

  const created = await call(a, 'create', { name: 'ホスト', playerId: 'host-00001' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^\d{4}$/);

  const bad = await call(b, 'join', { code: '0000x', name: 'B', playerId: 'guest-00001' });
  assert.equal(bad.ok, false);

  const joined = await call(b, 'join', { code: created.code, name: 'ゲスト', playerId: 'guest-00001' });
  assert.equal(joined.ok, true);

  await call(a, 'pos', { lat: 35.681, lng: 139.767, acc: 0 });
  await call(b, 'pos', { lat: 35.68105, lng: 139.767, acc: 0 });
  await call(a, 'settings', { hunterCount: 1, catchRadiusM: 20 });

  assert.equal((await call(b, 'start')).ok, false, 'ホスト以外は開始できない');

  const playing = nextState(a, (s) => s.phase === 'playing');
  assert.equal((await call(a, 'start')).ok, true);
  const s = await playing;
  const hunter = s.players.find((p) => p.role === 'hunter');
  const hunterSocket = hunter.id === 'host-00001' ? a : b;

  const ended = nextState(a, (st) => st.phase === 'ended');
  const res = await call(hunterSocket, 'catch', {});
  assert.equal(res.ok, true, res.error);
  const final = await ended;
  assert.equal(final.winner, 'hunters');
});
