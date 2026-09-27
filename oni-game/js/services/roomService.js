// ルーム（部屋）操作の窓口
//
// 画面はこのインターフェースだけを使う。
// 今は端末内だけで動く LocalRoomService（ダミー）を使い、
// STEP 7 で同じメソッドを持つ FirebaseRoomService（js/firebase/room.js）に差し替える。
//
// インターフェース:
//   createRoom({ hostName }) -> Promise<{ room, selfId, players }>
//   joinRoom({ code, name })  -> Promise<{ room, selfId, players }>
//   addDummyPlayer()           -> Promise<void>   … 開発用
//   onPlayersChanged(cb)       -> 解除関数
//   leaveRoom()                -> Promise<void>

import { createPlayer } from '../game/player.js';
import { randomId, randomRoomCode } from '../utils/random.js';
import { createDummyPlayer } from '../dev/dummyData.js';

export class LocalRoomService {
  constructor() {
    this.room = null;
    this.players = [];
    this.listeners = new Set();
  }

  async createRoom({ hostName }) {
    const selfId = randomId();
    const host = createPlayer({ id: selfId, name: hostName, isHost: true });
    this.room = { code: randomRoomCode(), hostId: selfId };
    this.players = [host];
    this.emit();
    return { room: this.room, selfId, players: this.players };
  }

  async joinRoom() {
    throw new Error('ルーム参加はオンライン対応（Firebase導入）後に使えるようになります');
  }

  async addDummyPlayer() {
    if (!this.room) throw new Error('ルームがありません');
    this.players = [...this.players, createDummyPlayer(this.players.length)];
    this.emit();
  }

  onPlayersChanged(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async leaveRoom() {
    this.room = null;
    this.players = [];
    this.emit();
  }

  emit() {
    for (const cb of this.listeners) cb(this.players);
  }
}

// アプリ全体で使うインスタンス（Firebase導入時はここを差し替える）
export const roomService = new LocalRoomService();
