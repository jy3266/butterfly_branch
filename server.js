const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8001;
// 관객이 글을 쓰는 원래 웹사이트(種間水話 서버) 주소 — QR이 가리키는 곳
const SOURCE_URL = (process.env.SOURCE_URL || 'https://lobster-app-984xv.ondigitalocean.app').replace(/\/+$/, '');
const POLL_MS = Number(process.env.POLL_MS) || 1500;

const DATA_DIR = path.join(__dirname, 'data');
const WORDS_FILE = path.join(DATA_DIR, 'words.json');
const STATE_FILE = path.join(DATA_DIR, 'source-state.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

// 지금까지 모인 모든 글: [{ id, text, createdAt }]
const words = readJson(WORDS_FILE, []);
// 원래 서버의 칸(score)마다 마지막으로 본 글. 원래 서버는 같은 칸을 덮어쓰기 때문에
// 칸의 글이 바뀌는 순간을 새 글로 보고 여기에 따로 모아 둔다.
let slots = readJson(STATE_FILE, null);

// 파일이 깨지지 않도록 저장을 한 줄로 세운다.
let saving = Promise.resolve();
function writeJson(file, value) {
  const snapshot = JSON.stringify(value, null, 2);
  const tmp = file + '.tmp';
  saving = saving
    .then(() => fs.promises.mkdir(DATA_DIR, { recursive: true }))
    .then(() => fs.promises.writeFile(tmp, snapshot))
    .then(() => fs.promises.rename(tmp, file))
    .catch((err) => console.error('저장 실패:', err));
}

function addWord(text) {
  const last = words[words.length - 1];
  const entry = { id: (last ? last.id : 0) + 1, text, createdAt: new Date().toISOString() };
  words.push(entry);
  writeJson(WORDS_FILE, words);
  console.log(`새 글 #${entry.id}: ${text}`);
}

// 원래 서버 응답 안에서 { word, score } 모양을 모두 찾아낸다 (원래 사이트와 같은 방식).
// 원래 서버는 저장할 때마다 예전 글을 한 겹 더 깊이 넣어 두므로,
// 같은 칸이 여러 번 나오면 가장 얕은 곳에 있는 것이 지금 글이다.
function collect(node, out, depth = 0) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.word === 'string') {
    const slot = String(node.score);
    if (!out.has(slot) || out.get(slot).depth > depth) {
      out.set(slot, { depth, text: node.word.replace(/\s+/g, ' ').trim() });
    }
    return out;
  }
  Object.keys(node).forEach((k) => collect(node[k], out, depth + 1));
  return out;
}

let live = false;
async function pullSource() {
  try {
    const res = await fetch(`${SOURCE_URL}/all`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const found = collect(await res.json(), new Map());

    const firstSync = slots === null;
    if (firstSync) slots = {};
    let changed = false;
    for (const [slot, { text }] of found) {
      if (!text || slots[slot] === text) continue;
      slots[slot] = text;
      changed = true;
      // 처음 연결할 때 이미 떠 있던 글은, 모아 둔 글에 없을 때만 담는다.
      if (firstSync && words.some((w) => w.text === text)) continue;
      addWord(text);
    }
    if (changed || firstSync) writeJson(STATE_FILE, slots);

    if (!live) console.log(`원래 서버와 연결됨: ${SOURCE_URL}`);
    live = true;
  } catch (err) {
    if (live) console.warn(`원래 서버와 연결이 끊겼어요 (${err.message}). 다시 시도합니다.`);
    live = false;
  } finally {
    setTimeout(pullSource, POLL_MS);
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ?since=<id> 보다 새 글만 돌려준다 (화면이 주기적으로 물어본다).
app.get('/api/words', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.set('Cache-Control', 'no-store');
  res.json({ live, words: words.filter((w) => w.id > since) });
});

app.listen(PORT, () => {
  console.log(`나비의 가지: http://localhost:${PORT}`);
  console.log(`글을 가져오는 곳: ${SOURCE_URL}/all`);
  pullSource();
});
