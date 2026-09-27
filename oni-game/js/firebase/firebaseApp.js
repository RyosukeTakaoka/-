// Firebase の初期化（ブラウザ用）
// エミュレーターモードでは、すべてのサービスをローカルのエミュレーターに接続する（本番へは接続しない）。

import * as sdk from './sdk.js';
import { resolveFirebaseConfig } from './firebaseConfig.js';

export function initFirebase(firebaseConfig) {
  const resolved = resolveFirebaseConfig(firebaseConfig);
  const app = sdk.initializeApp(resolved.options);
  const auth = sdk.getAuth(app);
  const db = sdk.getDatabase(app);
  const functions = sdk.getFunctions(app, resolved.region);
  if (resolved.emulator) {
    const { host, ports } = resolved.emulator;
    sdk.connectAuthEmulator(auth, `http://${host}:${ports.auth}`, { disableWarnings: true });
    sdk.connectDatabaseEmulator(db, host, ports.database);
    sdk.connectFunctionsEmulator(functions, host, ports.functions);
  }
  const call = async (name, data) => (await sdk.httpsCallable(functions, name)(data)).data;
  return { sdk, app, auth, db, call, mode: resolved.mode };
}
