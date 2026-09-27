// oni-game/js のゲームロジック（ブラウザと共通のコード）を functions/shared にコピーする。
// ソースは oni-game/js の1か所だけに置き、Cloud Functions にはデプロイ・エミュレーター起動の前にコピーする
// （functions/shared は .gitignore 済み。手で編集しない）。
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../oni-game/js/', import.meta.url));
const dest = fileURLToPath(new URL('../shared/', import.meta.url));

rmSync(dest, { recursive: true, force: true });
mkdirSync(`${dest}utils`, { recursive: true });
cpSync(`${root}game`, `${dest}game`, { recursive: true });
for (const file of ['distance.js', 'random.js']) cpSync(`${root}utils/${file}`, `${dest}utils/${file}`);
console.log('functions/shared を更新しました');
