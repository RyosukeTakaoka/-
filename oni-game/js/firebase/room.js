// Firebase 版のルーム操作（roomService）
//
// 画面からは直接使わず、services/firebaseGameService.js が使う。
// - 部屋の作成・参加・退出は Cloud Functions（createRoom / joinRoom / leaveRoom）に「要求」するだけ。
//   参加コードの発行・ホストの決定・メンバーの追加はサーバーが行う
// - メンバー・在席・ホスト・公開設定は RTDB を購読して受け取る（読めるのは部屋のメンバーだけ）
// - ホストかどうかは meta.hostUid と自分の uid で判断する（自分で名乗らない）
//
// 依存（sdk・db・uid・call）は外から渡す。ブラウザでは firebaseApp.js、テストでは npm の SDK とエミュレーター。

import { trackPresence } from './presence.js';

export function createFirebaseRoomService({ sdk, db, uid, call }) {
  let room = null; // { roomId, joinCode, hostUid }
  let members = {};
  let presence = {};
  let publicState = {};
  let closed = false;
  let unsubscribers = [];
  let stopPresence = null;
  const listeners = new Set();

  function snapshot() {
    if (!room) return { uid, room: null, members: [], settings: null, closed };
    const list = Object.entries(members)
      .map(([id, m]) => ({
        id,
        name: m.name,
        joinedAt: m.joinedAt,
        isHost: id === room.hostUid,
        online: presence[id]?.online === true,
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt);
    return { uid, room: { ...room }, members: list, settings: publicState.settings ?? null, closed };
  }

  const emit = () => {
    for (const l of listeners) l(snapshot());
  };

  function detach() {
    for (const off of unsubscribers) off();
    unsubscribers = [];
  }

  async function attach({ roomId, joinCode, hostUid }) {
    detach();
    room = { roomId, joinCode, hostUid };
    closed = false;
    members = {};
    presence = {};
    publicState = {};
    const watch = (path, onData) => {
      unsubscribers.push(sdk.onValue(sdk.ref(db, path), (snap) => {
        onData(snap.val());
        emit();
      }, () => {
        // 読めなくなった（部屋が解散した・メンバーでなくなった）
        closed = true;
        emit();
      }));
    };
    watch(`rooms/${roomId}/meta`, (meta) => {
      if (!meta) {
        closed = true; // ホストが退出して部屋が解散した
        return;
      }
      room = { ...room, hostUid: meta.hostUid, joinCode: meta.joinCode };
    });
    watch(`rooms/${roomId}/members`, (v) => { members = v ?? {}; });
    watch(`rooms/${roomId}/presence`, (v) => { presence = v ?? {}; });
    // public/doc はサーバーが書く JSON 文字列（buildChannels(state).public）
    watch(`rooms/${roomId}/public`, (v) => { publicState = typeof v?.doc === 'string' ? JSON.parse(v.doc) : {}; });
    stopPresence = trackPresence(sdk, db, roomId, uid);
    emit();
  }

  return {
    uid,
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 部屋を作る（ホストになる）。settings はサーバー側でも検証される */
    async createRoom({ name, settings }) {
      const result = await call('createRoom', { name, settings });
      await attach(result);
      return snapshot();
    },

    /** 4桁の参加コードで参加する */
    async joinRoom({ code, name }) {
      const result = await call('joinRoom', { code, name });
      await attach(result);
      return snapshot();
    },

    async leaveRoom() {
      if (!room) return;
      const { roomId } = room;
      await stopPresence?.();
      stopPresence = null;
      detach();
      room = null;
      members = {};
      presence = {};
      publicState = {};
      emit();
      await call('leaveRoom', { roomId });
    },
  };
}
