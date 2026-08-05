require('dotenv').config();
const TelegramBotRaw = require('node-telegram-bot-api');
const TelegramBot = TelegramBotRaw.default || TelegramBotRaw;
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const requiredEnv = [
  'TELEGRAM_BOT_TOKEN',
  'GEMINI_API_KEY',
  'PEXELS_API_KEY',
  'TELEGRAM_CHANNEL_ID',
  'ARCHIVE_CHANNEL_ID'
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`❌ Ошибка: Переменная окружения ${envVar} не задана!`);
    process.exit(1);
  }
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const HISTORY_FILE = path.join(__dirname, 'history.json');

// 1. Чтение истории тем из JSON-файла
function getUsedTopics() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn('⚠️ Не удалось прочитать history.json, создаем новый список.');
  }
  return [];
}

// 2. Сохранение новой темы в JSON-файл
function saveTopic(topic) {
  try {
    const history = getUsedTopics();
    history.push(topic);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    console.log(`💾 Тема "${topic}" успешно сохранена в history.json`);
  } catch (error) {
    console.error('❌ Ошибка записи в history.json:', error.message);
  }
}

// 3. Поиск фото на Pexels
async function fetchPexelsPhoto(query) {
  try {
    console.log(`🔎 Поиск фото на Pexels: "${query}"...`);
    const response = await axios.get(`https://api.pexels.com/v1/search`, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: query, per_page: 1, orientation: 'square' }
    });

    if (response.data.photos && response.data.photos.length > 0) {
      return response.data.photos[0].src.large;
    }
    
    const fallback = await axios.get(`https://api.pexels.com/v1/search`, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: 'healthy food', per_page: 1 }
    });
    return fallback.data.photos[0]?.src?.large || null;
  } catch (error) {
    console.error('❌ Ошибка Pexels API:', error.message);
    return null;
  }
}

// 4. Основной процесс
async function run() {
  console.log('🤖 ИИ-агент запущен...');

  const usedTopics = getUsedTopics();
  console.log(`📌 База данных тем (${usedTopics.length}): [${usedTopics.join(', ')}]`);

  const avoidPromptPart = usedTopics.length > 0 
    ? `\nCRITICAL CONSTRAINT: You MUST NOT write about any of these previously covered products: ${usedTopics.join(', ')}.`
    : '';

  const systemInstruction = `
You are a direct, concise, and highly informative nutrition expert writing daily posts for a Telegram channel.
Your task is to generate a post in UZBEK language about ONE specific, cheap, locally available product/food.

STRICT CONSTRAINTS & RULES:
1. NO GREETINGS OR INTROS: NEVER start with "Assalomu alaykum", "Salom", or conversational fillers.
2. NO OUTRO: Do not write closing greetings. End directly with hashtags.
3. CONTENT FOCUS: ONLY write about the product itself, its benefits, and consumption tips.
4. SIMPLICITY: Write in ultra simple, clear Uzbek (O'zbek tili).
5. LENGTH: ABSOLUTELY MAX 850 characters.
6. TELEGRAM HTML ONLY: Use <b> and <i> tags. NEVER use <ul>, <li>, <p>, or Markdown (**) tags. Use standard bullet symbols (🔹, •) for lists.
7. HASHTAGS: End with 3-4 hashtags.
${avoidPromptPart}

POST STRUCTURE EXAMPLE:
<b>[EMOJI] [PRODUCT NAME IN UZBEK]</b>

🔹 <b>Benefit 1:</b> Short explanation.
🔹 <b>Benefit 2:</b> Short explanation.
🔹 <b>Benefit 3:</b> Short explanation.

<b>Qanday iste'mol qilish kerak?</b>
Short practical tip.

#Hashtags

OUTPUT FORMAT REQUIREMENT:
Return ONLY a valid JSON object:
{
  "topic_name": "Product Name in Uzbek (e.g. Sabzi)",
  "pexels_query": "English query for Pexels photo (e.g. fresh carrots)",
  "post_text": "The exact post text in Uzbek with HTML tags and hashtags"
}
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Generate today\'s direct nutrition post in Uzbek avoiding past topics. Return ONLY JSON.',
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.7,
      }
    });

    const data = JSON.parse(response.text.trim());
    console.log(`📌 Продукт дня: ${data.topic_name}`);
    console.log(`🔍 Запрос для фото: ${data.pexels_query}`);

    const photoUrl = await fetchPexelsPhoto(data.pexels_query);

    console.log('--- Сгенерированный пост ---');
    console.log(data.post_text);
    console.log('---------------------------');

    // Публикация в основной канал
    if (photoUrl) {
      await bot.sendPhoto(process.env.TELEGRAM_CHANNEL_ID, photoUrl, {
        caption: data.post_text,
        parse_mode: 'HTML'
      });
    } else {
      await bot.sendMessage(process.env.TELEGRAM_CHANNEL_ID, data.post_text, { parse_mode: 'HTML' });
    }
    console.log('🚀 Пост выложен в основной канал!');

    // Отправка в служебный канал и сохранение в локальный JSON
    const archiveRecord = `<b>[БАЗА ДАННЫХ]</b>\nPRODUCT: ${data.topic_name}\n<b>Дата:</b> ${new Date().toLocaleDateString('ru-RU')}`;
    await bot.sendMessage(process.env.ARCHIVE_CHANNEL_ID, archiveRecord, { parse_mode: 'HTML' });

    saveTopic(data.topic_name);

  } catch (error) {
    console.error('❌ Ошибка:', error.message || error);
    process.exit(1);
  }
}

run();