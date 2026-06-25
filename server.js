require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
  fs.appendFileSync('C:/Users/June/軍團專案/sfbt-demo/crash.log',
    `\n[${new Date().toISOString()}] uncaughtException: ${err.stack}\n`);
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  fs.appendFileSync('C:/Users/June/軍團專案/sfbt-demo/crash.log',
    `\n[${new Date().toISOString()}] unhandledRejection: ${reason}\n`);
  console.error('unhandledRejection:', reason);
});

const app = express();
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AZURE_TTS_KEY    = process.env.AZURE_TTS_KEY;
const AZURE_TTS_REGION = process.env.AZURE_TTS_REGION || 'southeastasia';

const PROMPT_PATH    = path.join(__dirname, 'sfbt_prompt.md');
const KNOWLEDGE_PATH = path.join(__dirname, 'sfbt_knowledge.md');
const SYSTEM_PROMPT  = fs.readFileSync(PROMPT_PATH, 'utf8') + '\n\n' + fs.readFileSync(KNOWLEDGE_PATH, 'utf8');
console.log(`✅ 指令已載入：${PROMPT_PATH}`);
console.log(`✅ 知識庫已載入：${KNOWLEDGE_PATH}（合計 ${SYSTEM_PROMPT.length} 字）`);
console.log(`✅ Azure TTS：region=${AZURE_TTS_REGION}，key=${AZURE_TTS_KEY ? '已設定' : '❌ 未設定'}`);

const OPENINGS = [
  '嗨，很高興你來！\n\n你今天來，帶著什麼期待呢？想要有什麼收穫？',
  '嗨！歡迎你來試試這個對話。\n\n如果今天談完，你覺得有點不一樣了——那個「不一樣」，你猜會是什麼？還是說，身邊的人可能從哪裡發現你變了？',
  '嗨，很高興你來。\n\n你今天來，是有什麼想改變的嗎？還是有個方向你想試試看的？',
  '嗨！想像一下，今天談完要走出去的時候——你希望心裡是什麼感覺？',
  '嗨，很高興你來！\n\n如果今天這個對話可以幫你前進一小步，你最想前進的是哪裡？',
  '嗨！你今天來，有沒有什麼特別想往前走的方向？',
];

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanForTts(text) {
  return text
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/〔[^〕]*〕/g, '')
    .trim() || text;
}

async function azureTts(text) {
  if (!AZURE_TTS_KEY) return null;
  const cleaned = cleanForTts(text);
  const escaped = escapeXml(cleaned)
    .replace(/睡覺/g, '<phoneme alphabet="bpmf" ph="ㄕㄨㄟˋ ㄐㄧㄠˋ">睡覺</phoneme>')
    .replace(/覺得/g, '<phoneme alphabet="bpmf" ph="ㄐㄩㄝˊ ㄉㄜ˙">覺得</phoneme>')
    .replace(/感覺/g, '<phoneme alphabet="bpmf" ph="ㄍㄢˇ ㄐㄩㄝˊ">感覺</phoneme>');
  const ssml = `<speak version='1.0' xml:lang='zh-TW' xmlns:mstts='http://www.w3.org/2001/mstts'>
    <voice name='zh-TW-HsiaoChenNeural'>
      <prosody rate='-3%' pitch='-8%'>${escaped}</prosody>
    </voice>
  </speak>`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(
      `https://${AZURE_TTS_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_TTS_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        },
        body: ssml,
      }
    );
    if (res.ok) {
      const buf = await res.arrayBuffer();
      console.log(`Azure TTS ok, bytes=${buf.byteLength}, text="${text.slice(0,30)}"`);
      return Buffer.from(buf).toString('base64');
    }
    const errText = await res.text();
    console.error(`Azure TTS error (attempt ${attempt}): status=${res.status} body=${errText.slice(0, 300)}`);
    console.error(`Azure TTS ssml snippet: ${ssml.slice(0, 200)}`);
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
  }
  console.error('Azure TTS failed all attempts, returning null');
  return null;
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '無效的訊息格式' });
  }

  // 開場白：隨機靜態回應，不走 Claude API
  if (
    messages.length === 1 &&
    messages[0].role === 'user' &&
    messages[0].content === '（開始對話）'
  ) {
    const opening = OPENINGS[Math.floor(Math.random() * OPENINGS.length)];
    const audio = await azureTts(opening);
    return res.json({ content: opening, audio });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const content = response.content[0].text;
    const audio = await azureTts(content);
    res.json({ content, audio });
  } catch (error) {
    console.error('API 錯誤：', error.message);
    res.status(500).json({ error: '伺服器發生錯誤，請稍後再試。' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ SFBT 對話伺服器已啟動`);
  console.log(`   本機測試：http://localhost:${PORT}`);
  console.log(`   讓學生連線：http://[你的IP]:${PORT}\n`);
});
