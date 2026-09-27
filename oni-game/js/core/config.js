// 設定ファイルの読み込み
// config/config.js（Git管理外・APIキー入り）があればそれを、なければ config.example.js を使う。

let cached = null;

export async function loadConfig() {
  if (cached) return cached;
  let mod;
  try {
    mod = await import('../../config/config.js');
  } catch {
    mod = await import('../../config/config.example.js');
    console.info('config/config.js が無いため、APIキーなしの開発モードで起動します');
  }
  cached = Object.freeze({ ...mod.CONFIG });
  return cached;
}
