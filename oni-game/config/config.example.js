// 設定ファイルのひな形
//
// 使い方:
//   1. このファイルをコピーして config/config.js を作る
//        cp config/config.example.js config/config.js
//   2. config.js に自分の値を書く
//
// config/config.js は .gitignore 済みなので GitHub には上がりません。
// このファイル（config.example.js）には絶対に本物のキーや本番の設定を書かないでください。

export const CONFIG = {
  // ---- Google Maps ----
  // 空のときは Google Maps の代わりに簡易マップ（方眼紙）で動きます。
  // Google Cloud Console で発行したブラウザ用APIキー。
  // 必ず「HTTPリファラー制限」と「API制限（Maps JavaScript API のみ）」をかけること
  googleMapsApiKey: '',
  // マーカー表示（AdvancedMarkerElement）に必要な Map ID。'DEMO_MAP_ID' は Google が用意しているテスト用ID
  googleMapsMapId: 'DEMO_MAP_ID',

  // ---- バックエンド ----
  // 'local'   … 端末内だけで動く（ダミーの友達で動作確認。Firebase は使わない）
  // 'firebase' … Firebase でオンライン対戦（STEP 7-B 時点では部屋の作成・参加・メンバー・在席のみ）
  // URL に ?backend=firebase / ?backend=local を付けると一時的に切り替えられます。?dev は常に 'local'。
  backend: 'local',

  firebase: {
    // 'emulator'   … ローカルの Firebase Emulator に接続（本番には接続しない）。projectId は必ず "demo-" で始める
    // 'production' … 本番の Firebase プロジェクトに接続（下の production を config.js にだけ書く）
    mode: 'emulator',
    region: 'asia-northeast1',
    emulator: {
      projectId: 'demo-oni-game',
      host: '127.0.0.1',
      authPort: 9099,
      databasePort: 9000,
      functionsPort: 5001,
    },
    // 本番用（Firebase コンソールの「ウェブアプリの設定」の値）。ここには書かず config.js にだけ書く。
    // production: { apiKey: '...', authDomain: '...', projectId: '...', databaseURL: '...', appId: '...' },
    production: null,
  },
};
