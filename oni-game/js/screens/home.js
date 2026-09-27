// ホーム画面

import { fromHtml, storage, toast } from '../utils/dom.js';
import { sanitizeName, MAX_NAME_LENGTH } from '../game/player.js';
import { gameService } from '../services/gameService.js';

const TEMPLATE = `
<div class="screen home">
  <header class="home-hero">
    <div class="home-logo" aria-hidden="true">👹</div>
    <h1>リアル鬼ごっこ</h1>
    <p class="muted">鬼ごっこ × ミッション × 情報戦</p>
  </header>

  <label class="field">
    <span>あなたの名前</span>
    <input id="home-name" maxlength="${MAX_NAME_LENGTH}" autocomplete="nickname" placeholder="例: たろう" />
  </label>

  <button id="home-create" class="btn btn-primary" type="button">ゲームを作成</button>

  <div class="home-join">
    <label class="field">
      <span>ルームコードで参加</span>
      <input id="home-code" maxlength="4" inputmode="numeric" pattern="[0-9]*" placeholder="4桁の数字（例: 1234）" />
    </label>
    <button id="home-join" class="btn" type="button">参加する</button>
  </div>

  <details class="card howto">
    <summary>あそびかた</summary>
    <ol>
      <li>ホストがゲームを作り、開始地点とエリアを決める</li>
      <li>友達をルームに招待し、鬼と逃走者を決める</li>
      <li>鬼には逃走者の正確な位置は見えず「この円のどこかにいる」だけが分かる</li>
      <li>ゲーム中に4回ミッションが発生。成功すると位置がぼやけ、失敗すると絞られる</li>
    </ol>
  </details>

  <div class="card safety">
    <strong>⚠ 安全に遊ぶために</strong>
    <ul>
      <li>道路への飛び出し・歩きスマホはしない</li>
      <li>私有地・立入禁止の場所には入らない</li>
      <li>公園や学校など、許可のある安全な場所で遊ぶ</li>
    </ul>
  </div>
</div>`;

const NAME_KEY = 'oni.playerName';

function readName(input) {
  const name = sanitizeName(input.value);
  if (!name) {
    toast('名前を入力してください');
    input.focus();
    return null;
  }
  storage.set(NAME_KEY, name);
  return name;
}

export const homeScreen = {
  mount(root, { navigate }) {
    root.append(fromHtml(TEMPLATE));
    const nameInput = root.querySelector('#home-name');
    const codeInput = root.querySelector('#home-code');
    nameInput.value = storage.get(NAME_KEY) ?? '';
    const invited = new URLSearchParams(location.search).get('room');
    if (invited) codeInput.value = invited;

    root.querySelector('#home-create').addEventListener('click', () => {
      const name = readName(nameInput);
      if (!name) return;
      gameService.resetGame();
      navigate('create', { hostName: name });
    });

    root.querySelector('#home-join').addEventListener('click', async () => {
      const name = readName(nameInput);
      if (!name) return;
      try {
        await gameService.joinRoom({ code: codeInput.value.trim(), name });
        navigate('lobby');
      } catch (err) {
        toast(err.message, 3500);
      }
    });
  },
};
