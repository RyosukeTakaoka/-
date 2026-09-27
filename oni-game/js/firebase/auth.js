// 匿名ログイン
// ログイン後の uid が、部屋のメンバーの識別子（rooms/{roomId}/members/{uid}）になる。

/** ログイン済みならその uid、まだなら匿名ログインして uid を返す */
export function ensureSignedIn(sdk, auth) {
  return new Promise((resolve, reject) => {
    const stop = sdk.onAuthStateChanged(auth, async (user) => {
      stop();
      try {
        resolve(user ? user.uid : (await sdk.signInAnonymously(auth)).user.uid);
      } catch (err) {
        reject(err);
      }
    }, reject);
  });
}
