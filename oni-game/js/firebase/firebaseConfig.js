// Firebase の接続設定の解決
//
// config/config.js（Git 管理外）の CONFIG.firebase から、エミュレーター用か本番用かを決める。
// - mode: 'emulator' … projectId は必ず "demo-" で始まる（Firebase の仕様で本番には接続されない）
// - mode: 'production' … CONFIG.firebase.production に本番の設定を書く（config.js にだけ書き、GitHub に上げない）
// 本番の設定をエミュレーター用に使ったり、その逆をしたりしないよう、ここで確認する。

export function resolveFirebaseConfig(firebase) {
  if (!firebase) throw new Error('config の firebase 設定がありません');
  const region = firebase.region ?? 'asia-northeast1';
  if (firebase.mode === 'emulator') {
    const e = firebase.emulator ?? {};
    const projectId = e.projectId ?? 'demo-oni-game';
    if (!projectId.startsWith('demo-')) {
      throw new Error('エミュレーター用の projectId は "demo-" で始めてください（本番に接続しないため）');
    }
    const host = e.host ?? '127.0.0.1';
    const ports = { auth: e.authPort ?? 9099, database: e.databasePort ?? 9000, functions: e.functionsPort ?? 5001 };
    return {
      mode: 'emulator',
      region,
      options: {
        apiKey: 'demo-api-key', // エミュレーターでは使われない仮の値
        projectId,
        databaseURL: `http://${host}:${ports.database}?ns=${projectId}-default-rtdb`,
      },
      emulator: { host, ports },
    };
  }
  if (firebase.mode === 'production') {
    const p = firebase.production;
    if (!p?.projectId || !p.apiKey || !p.databaseURL) {
      throw new Error('本番用の firebase.production（apiKey・projectId・databaseURL など）を config.js に設定してください');
    }
    if (p.projectId.startsWith('demo-')) throw new Error('本番用の projectId に "demo-" は使えません');
    return { mode: 'production', region, options: { ...p }, emulator: null };
  }
  throw new Error(`firebase.mode は 'emulator' か 'production' にしてください（今は ${firebase.mode}）`);
}
