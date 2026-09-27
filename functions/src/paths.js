// RTDB のパス（サーバー側）。クライアントがどこを読み書きできるかは database.rules.json で決める。
//
// /joinCodes/{code}                     { roomId, createdAt }        … 4桁コード → 内部の部屋ID（クライアントは読めない）
// /rooms/{roomId}/meta                  { hostUid, joinCode, phase, createdAt }（サーバーだけが書く）
// /rooms/{roomId}/members/{uid}         { name, joinedAt }           （作成・削除はサーバー。本人は name だけ変更可）
// /rooms/{roomId}/presence/{uid}        { online, lastChanged }      （本人が書く。表示用で、正確さは保証しない）
// /rooms/{roomId}/access                { phase, showHunters, players: { uid: { role, status } } }
//                                        … Security Rules が「誰が何を読めるか」の判定に使う（サーバーだけが書く）
// /rooms/{roomId}/public/doc            JSON文字列: buildChannels(state).public（メンバー全員が読める）
// /rooms/{roomId}/channels/{name}       JSON文字列: hunterPositions / runnerPositions / possibleAreas（読める人はルールで制限）
// /rooms/{roomId}/views/{uid}           JSON文字列: 本人だけのデータ（自分の円・目的地・クールダウンなど）
// /rooms/{roomId}/results/public        JSON文字列: 結果（personal を除く）
// /rooms/{roomId}/results/personal/{uid} JSON文字列: 本人のミッション結果
// /locations/{roomId}/{uid}             { lat, lng, acc, t }          … 本人だけが書ける・クライアントは誰も読めない
// /private/games/{roomId}               { state: JSON文字列, scheduledAt } … サーバー専用のゲーム状態（実位置・秘密値・目的地を含む）
// /private/rateLimits/{uid}/{action}    { windowStart, count }
//
// JSON文字列で保存する理由: RTDB は null・空の配列・空のオブジェクトを保存できず、配列も番号付きのオブジェクトになる。
// ゲームの状態やビューは null や空配列を多く含むので、形を崩さずにそのまま渡せるよう文字列にする。
// ルールの判定に使う値（access）だけは、ルールから読めるように通常のデータで保存する。

export const joinCodePath = (code) => `joinCodes/${code}`;
export const roomPath = (roomId) => `rooms/${roomId}`;
export const metaPath = (roomId) => `rooms/${roomId}/meta`;
export const membersPath = (roomId) => `rooms/${roomId}/members`;
export const memberPath = (roomId, uid) => `rooms/${roomId}/members/${uid}`;
export const presencePath = (roomId, uid) => `rooms/${roomId}/presence/${uid}`;
export const accessPath = (roomId) => `rooms/${roomId}/access`;
export const publicDocPath = (roomId) => `rooms/${roomId}/public/doc`;
export const channelPath = (roomId, name) => `rooms/${roomId}/channels/${name}`;
export const viewPath = (roomId, uid) => `rooms/${roomId}/views/${uid}`;
export const viewsPath = (roomId) => `rooms/${roomId}/views`;
export const resultsPath = (roomId) => `rooms/${roomId}/results`;
export const publicResultPath = (roomId) => `rooms/${roomId}/results/public`;
export const personalResultPath = (roomId, uid) => `rooms/${roomId}/results/personal/${uid}`;
export const roomLocationsPath = (roomId) => `locations/${roomId}`;
export const locationPath = (roomId, uid) => `locations/${roomId}/${uid}`;
export const gamePath = (roomId) => `private/games/${roomId}`;
export const gameStatePath = (roomId) => `private/games/${roomId}/state`;
export const scheduledAtPath = (roomId) => `private/games/${roomId}/scheduledAt`;
export const gamesPath = () => 'private/games';
export const rateLimitPath = (uid, action) => `private/rateLimits/${uid}/${action}`;

export const CHANNEL_NAMES = Object.freeze(['hunterPositions', 'runnerPositions', 'possibleAreas']);
