// RTDB のパス（サーバー側）。クライアントがどこを読み書きできるかは database.rules.json で決める。
//
// /joinCodes/{code}              { roomId, createdAt }         … 4桁コード → 内部の部屋ID（クライアントは読めない）
// /rooms/{roomId}/meta           { hostUid, joinCode, phase, createdAt }（サーバーだけが書く）
// /rooms/{roomId}/members/{uid}  { name, joinedAt }            （作成・削除はサーバー。本人は name だけ変更可）
// /rooms/{roomId}/presence/{uid} { online, lastChanged }       （本人が書く。表示用で、正確さは保証しない）
// /rooms/{roomId}/public         { settings }                  （サーバーだけが書く。7-C でゲーム情報を追加）
// /private/...                    サーバー専用（クライアントは読み書きとも不可）
// /locations/...                  7-D まではクライアントから読み書きとも不可

export const joinCodePath = (code) => `joinCodes/${code}`;
export const roomPath = (roomId) => `rooms/${roomId}`;
export const metaPath = (roomId) => `rooms/${roomId}/meta`;
export const membersPath = (roomId) => `rooms/${roomId}/members`;
export const memberPath = (roomId, uid) => `rooms/${roomId}/members/${uid}`;
export const presencePath = (roomId, uid) => `rooms/${roomId}/presence/${uid}`;
export const rateLimitPath = (uid, action) => `private/rateLimits/${uid}/${action}`;
