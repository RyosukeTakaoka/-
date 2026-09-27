// エミュレーターテストの共通処理
// FIREBASE_DATABASE_EMULATOR_HOST（firebase emulators:exec が設定する）で RTDB エミュレーターに接続する。
// 本番には接続しない（projectId は demo-）。
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { initializeApp, deleteApp } from 'firebase/app';
import * as databaseSdk from 'firebase/database';

export const PROJECT_ID = 'demo-oni-game';
const [HOST, PORT] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000').split(':');
export const EMULATOR = { host: HOST, port: Number(PORT) };

export async function createTestEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { ...EMULATOR, rules: readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8') },
  });
}

/** サーバー（Admin SDK 相当・ルール無効）として fn(db) を実行する */
export async function asServer(env, fn) {
  let result;
  await env.withSecurityRulesDisabled(async (ctx) => { result = await fn(ctx.database()); });
  return result; // withSecurityRulesDisabled 自体は戻り値を返さないので取り出す
}

/** Cloud Functions のハンドラーを、指定ユーザーの認証情報で呼ぶ（callable の中身と同じ処理） */
export const callAs = (env, handler, uid, data, now = Date.now()) =>
  asServer(env, (db) => handler(db, uid ? { uid } : null, data, now));

let appCount = 0;
/** 指定ユーザーとしてログインした状態のクライアント（npm の Firebase JS SDK・modular API） */
export function clientFor(uid) {
  const app = initializeApp({ projectId: PROJECT_ID, databaseURL: `http://${HOST}:${PORT}?ns=${PROJECT_ID}` }, `client-${uid}-${appCount++}`);
  const db = databaseSdk.getDatabase(app);
  databaseSdk.connectDatabaseEmulator(db, HOST, Number(PORT), { mockUserToken: { sub: uid, user_id: uid } });
  return { db, sdk: databaseSdk, close: () => deleteApp(app) };
}

/** 条件を満たす値が来るまで待つ */
export function waitFor(get, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const v = get();
      if (predicate(v)) {
        clearInterval(timer);
        resolve(v);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`待機がタイムアウトしました: ${JSON.stringify(v)}`));
      }
    }, 20);
  });
}
