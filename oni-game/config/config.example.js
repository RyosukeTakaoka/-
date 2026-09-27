// 設定ファイルのひな形
//
// 使い方:
//   1. このファイルをコピーして config/config.js を作る
//        cp config/config.example.js config/config.js
//   2. config.js に自分の Google Maps APIキーを書く
//
// config/config.js は .gitignore 済みなので GitHub には上がりません。
// このファイル（config.example.js）には絶対に本物のキーを書かないでください。
//
// APIキーが空のときは、Google Maps の代わりに簡易マップ（方眼紙）で動きます。

export const CONFIG = {
  // Google Cloud Console で発行したブラウザ用APIキー
  // 必ず「HTTPリファラー制限」と「API制限（Maps JavaScript API のみ）」をかけること
  googleMapsApiKey: '',

  // マーカー表示（AdvancedMarkerElement）に必要な Map ID。
  // 'DEMO_MAP_ID' は Google が用意しているテスト用ID。本番では自分で作成した Map ID に置き換える
  googleMapsMapId: 'DEMO_MAP_ID',
};
