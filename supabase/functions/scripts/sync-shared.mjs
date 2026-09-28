// oni-game/js のゲームロジック（ブラウザ・Cloud Functions と共通のコード）を
// supabase/functions/_shared/game にコピーする。
// ソースは oni-game/js の1か所だけに置き、Edge Functions を動かす・デプロイする前にコピーする
// （_shared/game・_shared/utils は .gitignore 済み。手で編集しない）。
//
// Deno は拡張子付きの相対 import（'../utils/distance.js' のような書き方）をそのまま実行できるので、
// このコードは書き換えなしでコピーするだけで Edge Functions から使える。
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../oni-game/js/', import.meta.url));
const dest = fileURLToPath(new URL('../_shared/', import.meta.url));

rmSync(`${dest}game`, { recursive: true, force: true });
rmSync(`${dest}utils`, { recursive: true, force: true });
mkdirSync(`${dest}utils`, { recursive: true });
cpSync(`${root}game`, `${dest}game`, { recursive: true });
for (const file of ['distance.js', 'random.js']) cpSync(`${root}utils/${file}`, `${dest}utils/${file}`);
console.log('supabase/functions/_shared/{game,utils} を更新しました');
