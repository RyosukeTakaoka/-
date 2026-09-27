// STEP 7-B: Firebase の接続設定（エミュレーター用と本番用の分離）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFirebaseConfig } from '../oni-game/js/firebase/firebaseConfig.js';
import { CONFIG } from '../oni-game/config/config.example.js';

test('ひな形はエミュレーター用（demo- プロジェクト）で、本番の設定を含まない', () => {
  assert.equal(CONFIG.backend, 'local');
  assert.equal(CONFIG.firebase.mode, 'emulator');
  assert.equal(CONFIG.firebase.production, null);
  const r = resolveFirebaseConfig(CONFIG.firebase);
  assert.equal(r.mode, 'emulator');
  assert.equal(r.options.projectId, 'demo-oni-game');
  assert.equal(r.options.databaseURL, 'http://127.0.0.1:9000?ns=demo-oni-game-default-rtdb');
  assert.deepEqual(r.emulator.ports, { auth: 9099, database: 9000, functions: 5001 });
});

test('エミュレーターモードで本番の projectId は使えない', () => {
  assert.throws(() => resolveFirebaseConfig({ mode: 'emulator', emulator: { projectId: 'my-real-project' } }), /demo-/);
});

test('本番モードは本番の設定が必要で、demo- プロジェクトやエミュレーター接続は使わない', () => {
  assert.throws(() => resolveFirebaseConfig({ mode: 'production', production: null }), /production/);
  assert.throws(() => resolveFirebaseConfig({
    mode: 'production', production: { apiKey: 'k', projectId: 'demo-x', databaseURL: 'https://x' },
  }), /demo-/);
  const r = resolveFirebaseConfig({
    mode: 'production', production: { apiKey: 'k', projectId: 'real', databaseURL: 'https://real.firebaseio.com' },
  });
  assert.equal(r.emulator, null);
  assert.equal(r.options.projectId, 'real');
});

test('mode の指定ミスはエラー', () => {
  assert.throws(() => resolveFirebaseConfig({ mode: 'prod' }), /mode/);
  assert.throws(() => resolveFirebaseConfig(undefined));
});
