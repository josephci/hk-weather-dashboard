/**
 * alert.js
 * ------------------------------------------------------------
 * 用途：每次執行（由GitHub Actions每5分鐘排程）會攞天文台總部
 *       嘅即時溫度+今日至今高低溫，偵測以下事件並推送Telegram：
 *
 *   事件A「新高」   ：今日最高溫破咗今日新高
 *   事件B「破關口」 ：今日最高溫升穿咗整數關口（例如 31.9 → 32.0）
 *                     → Polymarket對應bucket即刻變生/變死，bot會秒速重價，
 *                       呢個通知係俾你知「已經發生咗」，作記錄同覆盤用
 *   事件C「逼近關口」：現時溫度距離下一個整數關口 ≤ APPROACH_MARGIN
 *                     而且趨勢向上（比上次讀數高）
 *                     → 呢個先係你嘅落單黃金窗口：喺bot搶到之前提早部署
 *   事件D「回落確認」：現時溫度比今日高溫低 ≥ PULLBACK_MARGIN
 *                     → 提示今日高溫可能已經見頂（例如雷暴殺到），
 *                       「高溫≥X」嘅No變得更值博
 *
 * Telegram設定（GitHub repo Settings → Secrets and variables → Actions）：
 *   TG_BOT_TOKEN : 你個bot嘅token（@BotFather攞）
 *   TG_CHAT_ID   : 你嘅chat id（同bot講句嘢之後用getUpdates攞）
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "alert_state.json");
const HISTORY_FILE = path.join(__dirname, "history.csv");

const LIVE_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv";
const MAXMIN_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;

const APPROACH_MARGIN = 0.3; // °C：現時溫度距離整數關口呢個範圍內 = 逼近
const PULLBACK_MARGIN = 0.8; // °C：現時溫度低過今日高溫呢個幅度 = 可能見頂

// ---------- CSV攞數 ----------
function parseTimestamp(ts) {
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8), h = ts.slice(8, 10), mi = ts.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
}

function toNum(s) {
  if (!s || s.trim().toUpperCase() === "N/A") return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 10) / 10;
}

async function fetchCsvRow(url, expectCols) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV錯誤 ${url}: ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (STATION_PATTERN.test(parts[1])) return parts;
  }
  throw new Error(`搵唔到天文台總部行: ${url}`);
}

// ---------- Telegram ----------
async function sendTelegram(text) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) {
    console.log("（未設定TG_BOT_TOKEN/TG_CHAT_ID，以下訊息只print唔推送）\n" + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) console.error("Telegram推送失敗:", res.status, await res.text());
}

// ---------- State ----------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function appendHistory(recordTime, value, todayMax, todayMin) {
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, "recordTime,current,todayMax,todayMin\n");
  }
  fs.appendFileSync(HISTORY_FILE, `${recordTime},${value ?? ""},${todayMax ?? ""},${todayMin ?? ""}\n`);
}

// ---------- Polymarket 市場數據 ----------
// 用Gamma API（公開、唔使key）搵當日香港最高溫市場，攞返各bucket現價
async function fetchPolymarketHKTemp(dateStr) {
  try {
    const url = "https://gamma-api.polymarket.com/events?closed=false&limit=100&tag_slug=weather";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);
    const events = await res.json();

    const [y, m, d] = dateStr.split("-").map(Number);
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    // 搵標題含 "hong kong" 同當日日期嘅event
    const target = (Array.isArray(events) ? events : []).find((ev) => {
      const t = (ev.title || "").toLowerCase();
      return t.includes("hong kong") && (t.includes(`${monthNames[m-1]} ${d}`) || t.includes(`${m}/${d}`));
    });
    if (!target) return null;

    const lines = [];
    for (const mkt of target.markets || []) {
      // outcomePrices 通常係 '["0.12","0.88"]' 字串
      let yesPrice = null;
      try {
        const prices = JSON.parse(mkt.outcomePrices || "[]");
        yesPrice = prices[0] !== undefined ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch { /* ignore */ }
      const label = (mkt.groupItemTitle || mkt.question || "?").trim();
      if (yesPrice !== null) lines.push(`  ${label}: ${yesPrice}¢`);
    }

    return {
      title: target.title,
      url: `https://polymarket.com/event/${target.slug}`,
      priceLines: lines,
    };
  } catch (e) {
    console.error("Polymarket查詢失敗（唔影響警報）:", e.message);
    return null;
  }
}

// ---------- 主邏輯 ----------
async function main() {
  const [liveRow, maxMinRow] = await Promise.all([
    fetchCsvRow(LIVE_CSV_URL),
    fetchCsvRow(MAXMIN_CSV_URL),
  ]);

  const current = toNum(liveRow[2]);
  const recordTime = parseTimestamp(liveRow[0]);
  const todayMax = toNum(maxMinRow[2]);
  const todayMin = toNum(maxMinRow[3]);

  const state = loadState();
  const today = recordTime.slice(0, 10);
  const isNewDay = state.date !== today;

  // 新一日reset（香港時間過咗午夜，today max/min重新開始）
  if (isNewDay) {
    Object.assign(state, { date: today, prevCurrent: null, prevMax: null, alertedFloors: [], approachAlerted: null, pulledBackAlerted: false });
  }

  const events = [];

  // A: 今日高溫破新高
  if (todayMax !== null && state.prevMax !== null && todayMax > state.prevMax) {
    events.push(`📈 <b>今日新高</b>：${todayMax.toFixed(1)}°C（之前 ${state.prevMax.toFixed(1)}°C）`);
  }

  // B: 破整數關口（用今日高溫判斷，因為Polymarket結算睇max）
  if (todayMax !== null) {
    const floor = Math.floor(todayMax);
    const alerted = state.alertedFloors || [];
    if (state.prevMax !== null && floor > Math.floor(state.prevMax) && !alerted.includes(floor)) {
      events.push(`🚨 <b>破關口</b>：今日高溫已升穿 ${floor}.0°C（現報 ${todayMax.toFixed(1)}°C）\n→ Polymarket「&lt;${floor}°C」bucket已死，重價中`);
      alerted.push(floor);
      state.alertedFloors = alerted;
    }
  }

  // C: 逼近關口（用現時溫度+上升趨勢）
  if (current !== null && todayMax !== null) {
    const nextGate = Math.floor(todayMax) + 1; // 下一個未破嘅關口
    const distance = nextGate - todayMax;
    const rising = state.prevCurrent !== null && current > state.prevCurrent;
    if (distance > 0 && distance <= APPROACH_MARGIN && rising && state.approachAlerted !== nextGate) {
      events.push(
        `⚡ <b>逼近關口</b>：今日高溫 ${todayMax.toFixed(1)}°C，距離 ${nextGate}.0°C 僅 ${distance.toFixed(1)}°C，現時溫度上升中（${current.toFixed(1)}°C）\n→ 若判斷會破，宜早過bot部署`
      );
      state.approachAlerted = nextGate;
    }
  }

  // D: 回落確認（可能見頂）
  if (current !== null && todayMax !== null && !state.pulledBackAlerted) {
    const hourHK = parseInt(recordTime.slice(11, 13), 10);
    if (hourHK >= 13 && todayMax - current >= PULLBACK_MARGIN) {
      events.push(
        `🌧 <b>可能見頂</b>：現時 ${current.toFixed(1)}°C，比今日高溫 ${todayMax.toFixed(1)}°C 低 ${(todayMax - current).toFixed(1)}°C（下晝${hourHK}點後）\n→ 今日高溫大概率鎖定，高於${Math.floor(todayMax) + 1}°C嘅bucket嘅No值博率上升`
      );
      state.pulledBackAlerted = true;
    }
  }

  // 記錄歷史（每次run都記，方便日後覆盤）
  appendHistory(recordTime, current, todayMax, todayMin);

  if (events.length > 0) {
    const header = `🌡 <b>HK天文台總部</b>（${recordTime.slice(11, 16)}）\n現時 ${current?.toFixed(1) ?? "N/A"}°C ｜ 今日 ${todayMax?.toFixed(1) ?? "?"}° / ${todayMin?.toFixed(1) ?? "?"}°\n\n`;

    // 附上當日Polymarket市場連結+現價（一撳直達，慳走搵market嘅時間）
    let marketBlock = "";
    const market = await fetchPolymarketHKTemp(today);
    if (market) {
      marketBlock = `\n\n📊 <b>${market.title}</b>`;
      if (market.priceLines.length > 0) marketBlock += `\n${market.priceLines.join("\n")}`;
      marketBlock += `\n👉 <a href="${market.url}">開market落單</a>`;
    }

    await sendTelegram(header + events.join("\n\n") + marketBlock);
    console.log("已推送事件:\n" + events.join("\n"));
  } else {
    console.log(`[${recordTime}] 冇事件。現時 ${current}°C，今日 ${todayMax}°/${todayMin}°`);
  }

  state.prevCurrent = current;
  state.prevMax = todayMax;
  saveState(state);
}

main().catch((err) => {
  console.error("❌ 執行錯誤:", err.message);
  process.exit(1);
});
