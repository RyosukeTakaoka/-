// Firebase 版の gameService（STEP 7-B: 部屋の作成・参加・メンバー・在席だけ）
//
// 画面は今までどおり gameService のメソッドだけを使う。Firebase の操作は firebase/ 以下に閉じ込める。
// ゲームの進行（開始・確保・ミッションなど）は 7-C 以降でサーバー側に実装するので、ここではまだ使えない。
// 作成画面の設定・開始地点は、部屋を作るまで端末内の下書きとして持つ（下書きの計算は gameEngine を使う）。

import * as engine from '../game/gameEngine.js';
import { initFirebase } from '../firebase/firebaseApp.js';
import { ensureSignedIn } from '../firebase/auth.js';
import { createFirebaseRoomService } from '../firebase/room.js';

const notYet = (what) => () => {
  throw new Error(`${what}はオンライン対戦ではまだ使えません（STEP 7-C 以降で実装）`);
};

export async function createFirebaseGameService(firebaseConfig) {
  const fb = initFirebase(firebaseConfig);
  const uid = await ensureSignedIn(fb.sdk, fb.auth);
  const rooms = createFirebaseRoomService({ sdk: fb.sdk, db: fb.db, uid, call: fb.call });
  let draft = engine.initialState();
  const listeners = new Set();
  const emit = () => {
    for (const l of listeners) l();
  };
  rooms.subscribe(emit);
  const setDraft = (next) => {
    draft = next;
    emit();
  };

  function getSession() {
    const snap = rooms.getSnapshot();
    const inRoom = Boolean(snap.room);
    return {
      phase: inRoom ? engine.PHASE.LOBBY : draft.phase,
      room: inRoom ? { id: snap.room.roomId, code: snap.room.joinCode, hostId: snap.room.hostUid } : null,
      selfId: uid,
      isHost: inRoom && snap.room.hostUid === uid, // サーバーが決めた meta.hostUid で判定
      settings: (inRoom && snap.settings) || draft.settings,
      startPoint: draft.startPoint,
      area: draft.area,
      exclusionZones: draft.exclusionZones,
      players: snap.members.map((m) => ({ id: m.id, name: m.name, isHost: m.isHost, isDummy: false, online: m.online })),
      hasResult: false,
      closed: snap.closed,
    };
  }

  return {
    mode: 'firebase',
    getSession,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getView: notYet('ゲーム画面'),
    getResultView: () => null,

    // ---- ルーム（Cloud Functions に要求する） ----
    async createRoom({ hostName }) {
      await rooms.createRoom({ name: hostName, settings: draft.settings });
    },
    async joinRoom({ code, name }) {
      await rooms.joinRoom({ code, name });
    },
    addDummyPlayer: notYet('ダミーの友達'),
    async leaveRoom() {
      await rooms.leaveRoom();
      setDraft(engine.initialState());
    },

    // ---- 作成画面の下書き（部屋を作る前だけ） ----
    resetGame: () => setDraft(engine.initialState()),
    updateSettings: (input) => setDraft(engine.updateSettings(draft, input)),
    setStartPoint: (point) => setDraft(engine.setStartPoint(draft, point)),
    addExclusionZone: (point) => setDraft(engine.addExclusionZone(draft, point)),
    clearExclusionZones: () => setDraft(engine.clearExclusionZones(draft)),

    // ---- 7-C 以降 ----
    returnToLobby: notYet('もう一度遊ぶ'),
    prepareRematch: notYet('もう一度遊ぶ'),
    startGame: notYet('ゲーム開始'),
    reportPosition: () => {}, // GPS の送信は 7-D（それまでは何も送らない）
    requestCapture: notYet('確保'),
    requestNewDestination: notYet('目的地の変更'),
    abortGame: notYet('ゲーム終了'),
    tick: () => {}, // 時間を進めるのはサーバーの役目
  };
}
