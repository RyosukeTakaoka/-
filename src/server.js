'use strict';

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');

const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
const TICK_MS = 1000;

function createServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  const io = new Server(server);

  /** @type {Map<string, Game>} */
  const games = new Map();
  const lastActivity = new Map();

  function newCode() {
    let code;
    do {
      code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    } while (games.has(code));
    return code;
  }

  function touch(code) {
    lastActivity.set(code, Date.now());
  }

  // 各プレイヤーに、その人が見てよい情報だけを送る
  function broadcast(game) {
    const now = Date.now();
    for (const [, socket] of io.sockets.sockets) {
      const { code, playerId } = socket.data;
      if (code === game.code && playerId) {
        socket.emit('state', game.viewFor(playerId, now));
      }
    }
  }

  function notify(game, payload) {
    io.to(game.code).emit('event', payload);
  }

  // ハンドラ内のエラーを利用者向けメッセージに変換する
  function handle(socket, fn) {
    return (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const result = fn(payload ?? {});
        reply({ ok: true, ...result });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        reply({ ok: false, error: err instanceof GameError ? err.message : 'エラーが発生しました' });
      }
    };
  }

  function currentGame(socket) {
    const game = games.get(socket.data.code);
    if (!game) throw new GameError('部屋が見つかりません');
    return game;
  }

  function validPlayerId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      throw new GameError('不正なプレイヤーIDです');
    }
    return id;
  }

  function enter(socket, game, playerId) {
    if (socket.data.code && socket.data.code !== game.code) socket.leave(socket.data.code);
    socket.data.code = game.code;
    socket.data.playerId = playerId;
    socket.join(game.code);
    touch(game.code);
    broadcast(game);
  }

  io.on('connection', (socket) => {
    socket.on(
      'create',
      handle(socket, ({ name, playerId }) => {
        const id = validPlayerId(playerId);
        const code = newCode();
        const game = new Game(code, id);
        game.addPlayer(id, name);
        games.set(code, game);
        enter(socket, game, id);
        return { code };
      }),
    );

    socket.on(
      'join',
      handle(socket, ({ code, name, playerId }) => {
        const id = validPlayerId(playerId);
        const game = games.get(String(code ?? '').trim());
        if (!game) throw new GameError('部屋が見つかりません');
        game.addPlayer(id, name);
        enter(socket, game, id);
        return { code: game.code };
      }),
    );

    socket.on(
      'settings',
      handle(socket, (settings) => {
        const game = currentGame(socket);
        game.updateSettings(socket.data.playerId, settings);
        broadcast(game);
      }),
    );

    socket.on(
      'start',
      handle(socket, () => {
        const game = currentGame(socket);
        game.start(socket.data.playerId);
        touch(game.code);
        notify(game, { type: 'start' });
        broadcast(game);
      }),
    );

    socket.on(
      'lobby',
      handle(socket, () => {
        const game = currentGame(socket);
        game.backToLobby(socket.data.playerId);
        broadcast(game);
      }),
    );

    socket.on(
      'pos',
      handle(socket, (pos) => {
        const game = currentGame(socket);
        const hadPos = !!game.players.get(socket.data.playerId)?.pos;
        game.updatePosition(socket.data.playerId, {
          lat: Number(pos.lat),
          lng: Number(pos.lng),
          acc: Number(pos.acc),
        });
        touch(game.code);
        // ロビーでは「位置情報OK」表示を更新するため、初回だけ全員に配信
        if (game.phase === 'lobby' && !hadPos) broadcast(game);
      }),
    );

    socket.on(
      'catch',
      handle(socket, ({ targetId }) => {
        const game = currentGame(socket);
        const runner = targetId
          ? game.tryCatch(socket.data.playerId, targetId)
          : game.catchNearest(socket.data.playerId);
        notify(game, { type: 'caught', id: runner.id, name: runner.name });
        if (game.phase === 'ended') notify(game, { type: 'ended', winner: game.winner });
        broadcast(game);
      }),
    );

    socket.on(
      'surrender',
      handle(socket, () => {
        const game = currentGame(socket);
        const runner = game.surrender(socket.data.playerId);
        notify(game, { type: 'caught', id: runner.id, name: runner.name });
        if (game.phase === 'ended') notify(game, { type: 'ended', winner: game.winner });
        broadcast(game);
      }),
    );

    socket.on(
      'leave',
      handle(socket, () => {
        const game = games.get(socket.data.code);
        if (game) {
          if (game.phase === 'lobby') game.removePlayer(socket.data.playerId);
          else game.setConnected(socket.data.playerId, false);
          socket.leave(game.code);
          if (game.players.size === 0) games.delete(game.code);
          else broadcast(game);
        }
        socket.data.code = null;
        socket.data.playerId = null;
      }),
    );

    socket.on('disconnect', () => {
      const game = games.get(socket.data.code);
      if (!game) return;
      const stillConnected = [...io.sockets.sockets.values()].some(
        (s) => s.id !== socket.id && s.data.code === game.code && s.data.playerId === socket.data.playerId,
      );
      if (!stillConnected) {
        game.setConnected(socket.data.playerId, false);
        broadcast(game);
      }
    });
  });

  // 毎秒: 時間切れ判定・位置公開・状態配信
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [code, game] of games) {
      const events = game.tick(now);
      if (events.includes('reveal')) notify(game, { type: 'reveal' });
      if (events.includes('ended')) notify(game, { type: 'ended', winner: game.winner });
      if (game.phase === 'playing' || events.length) broadcast(game);

      const noOneConnected = ![...game.players.values()].some((p) => p.connected);
      if (noOneConnected && now - (lastActivity.get(code) ?? 0) > ROOM_IDLE_TTL_MS) {
        games.delete(code);
        lastActivity.delete(code);
      }
    }
  }, TICK_MS);
  server.on('close', () => clearInterval(interval));

  return { app, server, io, games };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`リアル鬼ごっこ サーバー起動: http://localhost:${port}`);
  });
}

module.exports = { createServer };
