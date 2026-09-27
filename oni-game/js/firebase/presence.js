// 在席状態（オンライン / オフライン）
//
// RTDB の .info/connected で接続を監視し、onDisconnect() で「切断されたらオフラインにする」を予約する。
// 表示用の目安であり、正確な現在の状態としては扱わない（切断の検知には数十秒かかることがある）。
// 書けるのは自分の rooms/{roomId}/presence/{uid} だけ（database.rules.json）。

export const presencePath = (roomId, uid) => `rooms/${roomId}/presence/${uid}`;

/**
 * @returns {() => Promise<void>} 在席の追跡を止めてオフラインにする関数
 */
export function trackPresence(sdk, db, roomId, uid) {
  const myRef = sdk.ref(db, presencePath(roomId, uid));
  const offline = () => ({ online: false, lastChanged: sdk.serverTimestamp() });
  const stop = sdk.onValue(sdk.ref(db, '.info/connected'), async (snap) => {
    if (snap.val() !== true) return;
    try {
      await sdk.onDisconnect(myRef).set(offline());
      await sdk.set(myRef, { online: true, lastChanged: sdk.serverTimestamp() });
    } catch {
      /* 部屋から外れた後などは書けない（ルールで拒否）。表示用なので無視する */
    }
  });
  return async () => {
    stop();
    try {
      await sdk.onDisconnect(myRef).cancel();
      await sdk.set(myRef, offline());
    } catch {
      /* 同上 */
    }
  };
}
