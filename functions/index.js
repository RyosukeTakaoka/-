// Cloud Functions（第2世代）の入口
// STEP 7-B: 部屋の作成・参加・退出だけ。ゲーム進行（7-C 以降）はまだ無い。
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import * as rooms from './src/rooms.js';

setGlobalOptions({ region: 'asia-northeast1', maxInstances: 10 });
initializeApp();

const call = (handler) => onCall(async (request) => handler(getDatabase(), request.auth, request.data, Date.now()));

export const createRoom = call(rooms.createRoom);
export const joinRoom = call(rooms.joinRoom);
export const leaveRoom = call(rooms.leaveRoom);
