/**
 * scan_cities.js
 * ------------------------------------------------------------
 * 多城市Edge掃描器：
 *   1. 由Polymarket Gamma API自動發現所有「Highest temperature in X」市場
 *   2. 每個城市攞6模型預測（自動用返城市當地時區+市場所用嘅°C/°F單位）
 *   3. 計每個bucket嘅模型機率 vs 市場價 → 搵edge
 *   4. Telegram推送全球top edges排行榜
 *
 * 設計原則：
 *   - 香港有bias校正（bias.json）；其他城市冇，會自動放大std做補償
 *     並喺報告標明「未校正」——呢啲城市嘅edge要打折看待
 *   - 唔識嘅城市會skip並印log，你見到可以叫Claude加落CITIES表
 *
 * 用法：node scan_cities.js
 * 環境變數：TG_BOT_TOKEN, TG_CHAT_ID（冇就淨print唔推送）
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const BIAS_FILE = path.join(__dirname, "bias.json");
const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const EDGE_THRESHOLD = 12;     // 百分點：跨城市掃描門檻設高少少，減noise
const STD_FLOOR = 0.5;
const NO_BIAS_STD_INFLATE = 1.4; // 冇bias校正嘅城市，std放大補償
const MAX_REPORT = 8;          // 最多報幾多個edge

// 城市座標+時區表（key用細楷方便match市場標題）
const CITIES = {
  "hong kong":     { lat: 22.302,  lon: 114.174,  tz: "Asia/Hong_Kong",     hasBias: true },
  "new york":      { lat: 40.7789, lon: -73.9692, tz: "America/New_York" },   // Central Park
  "nyc":           { lat: 40.7789, lon: -73.9692, tz: "America/New_York" },
  "london":        { lat: 51.4787, lon: -0.4497,  tz: "Europe/London" },      // Heathrow
  "paris":         { lat: 48.8566, lon: 2.3522,   tz: "Europe/Paris" },
  "seoul":         { lat: 37.5665, lon: 126.978,  tz: "Asia/Seoul" },
  "tokyo":         { lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo" },
  "los angeles":   { lat: 34.0522, lon: -118.2437,tz: "America/Los_Angeles" },
  "chicago":       { lat: 41.9803, lon: -87.9090, tz: "America/Chicago" },    // O'Hare
  "miami":         { lat: 25.7617, lon: -80.1918, tz: "America/New_York" },
  "atlanta":       { lat: 33.6407, lon: -84.4277, tz: "America/New_York" },
  "dallas":        { lat: 32.8998, lon: -97.0403, tz: "America/Chicago" },
  "philadelphia":  { lat: 39.9526, lon: -75.1652, tz: "America/New_York" },
  "toronto":       { lat: 43.6532, lon: -79.3832, tz: "America/Toronto" },
  "singapore":     { lat: 1.3521,  lon: 103.8198, tz: "Asia/Singapore" },
  "sydney":        { lat: -33.8688,lon: 151.2093, tz: "Australia/Sydney" },
  // ---- 美洲 ----
  "seattle":       { lat: 47.4502, lon: -122.3088,tz: "America/Los_Angeles" }, // SeaTac
  "austin":        { lat: 30.1945, lon: -97.6699, tz: "America/Chicago" },     // Bergstrom
  "denver":        { lat: 39.8561, lon: -104.6737,tz: "America/Denver" },      // DEN
  "houston":       { lat: 29.9902, lon: -95.3368, tz: "America/Chicago" },     // IAH
  "san francisco": { lat: 37.6213, lon: -122.379, tz: "America/Los_Angeles" }, // SFO
  "mexico city":   { lat: 19.4363, lon: -99.0721, tz: "America/Mexico_City" },
  "panama city":   { lat: 8.9824,  lon: -79.5199, tz: "America/Panama" },
  "sao paulo":     { lat: -23.5505,lon: -46.6333, tz: "America/Sao_Paulo" },
  "são paulo":     { lat: -23.5505,lon: -46.6333, tz: "America/Sao_Paulo" },
  "buenos aires":  { lat: -34.6037,lon: -58.3816, tz: "America/Argentina/Buenos_Aires" },
  // ---- 歐洲 ----
  "munich":        { lat: 48.1351, lon: 11.5820,  tz: "Europe/Berlin" },
  "milan":         { lat: 45.4642, lon: 9.1900,   tz: "Europe/Rome" },
  "madrid":        { lat: 40.4168, lon: -3.7038,  tz: "Europe/Madrid" },
  "warsaw":        { lat: 52.2297, lon: 21.0122,  tz: "Europe/Warsaw" },
  "amsterdam":     { lat: 52.3105, lon: 4.7683,   tz: "Europe/Amsterdam" },    // Schiphol
  "helsinki":      { lat: 60.1699, lon: 24.9384,  tz: "Europe/Helsinki" },
  "moscow":        { lat: 55.7558, lon: 37.6173,  tz: "Europe/Moscow" },
  "istanbul":      { lat: 41.0082, lon: 28.9784,  tz: "Europe/Istanbul" },
  "ankara":        { lat: 39.9334, lon: 32.8597,  tz: "Europe/Istanbul" },
  // ---- 中東/非洲 ----
  "tel aviv":      { lat: 32.0853, lon: 34.7818,  tz: "Asia/Jerusalem" },
  "jeddah":        { lat: 21.4858, lon: 39.1925,  tz: "Asia/Riyadh" },
  "cape town":     { lat: -33.9249,lon: 18.4241,  tz: "Africa/Johannesburg" },
  // ---- 亞太 ----
  "beijing":       { lat: 39.9042, lon: 116.4074, tz: "Asia/Shanghai" },
  "shanghai":      { lat: 31.2304, lon: 121.4737, tz: "Asia/Shanghai" },
  "shenzhen":      { lat: 22.5431, lon: 114.0579, tz: "Asia/Shanghai" },
  "guangzhou":     { lat: 23.1291, lon: 113.2644, tz: "Asia/Shanghai" },
  "chengdu":       { lat: 30.5728, lon: 104.0668, tz: "Asia/Shanghai" },
  "chongqing":     { lat: 29.5630, lon: 106.5516, tz: "Asia/Shanghai" },
  "wuhan":         { lat: 30.5928, lon: 114.3055, tz: "Asia/Shanghai" },
  "jinan":         { lat: 36.6512, lon: 117.1201, tz: "Asia/Shanghai" },
  "zhengzhou":     { lat: 34.7466, lon: 113.6254, tz: "Asia/Shanghai" },
  "qingdao":       { lat: 36.0671, lon: 120.3826, tz: "Asia/Shanghai" },
  "taipei":        { lat: 25.0330, lon: 121.5654, tz: "Asia/Taipei" },
  "busan":         { lat: 35.1796, lon: 129.0756, tz: "Asia/Seoul" },
  "manila":        { lat: 14.5995, lon: 120.9842, tz: "Asia/Manila" },
  "kuala lumpur":  { lat: 3.1390,  lon: 101.6869, tz: "Asia/Kuala_Lumpur" },
  "lucknow":       { lat: 26.8467, lon: 80.9462,  tz: "Asia/Kolkata" },
  "wellington":    { lat: -41.2866,lon: 174.7756, tz: "Pacific/Auckland" },
};

function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t = 1/(1+p*x);
  return sign * (1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}
function normalCdf(x, mean, std) {
  if (std === 0) return x >= mean ? 1 : 0;
  return 0.5*(1+erf((x-mean)/(std*Math.SQRT2)));
}

function loadBias() {
  if (!fs.existsSync(BIAS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BIAS_FILE, "utf-8")).max || {}; } catch { return {}; }
}

function cityLocalDate(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ---------- 發現Polymarket溫度市場 ----------
async function discoverMarkets() {
  const url = "https://gamma-api.polymarket.com/events?closed=false&limit=200&tag_slug=weather";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const events = await res.json();

  const found = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const title = (ev.title || "");
    const m = title.match(/highest temperature in (.+?) on (.+)\?/i);
    if (!m) continue;
    const cityRaw = m[1].trim().toLowerCase();
    const cityKey = Object.keys(CITIES).find((k) => cityRaw.includes(k) || k.includes(cityRaw));
    if (!cityKey) {
      console.log(`  ℹ️ 未識別城市，skip: "${m[1]}"（想加就話俾Claude聽）`);
      continue;
    }

    const buckets = [];
    let unit = "C";
    for (const mkt of ev.markets || []) {
      let yesPrice = null;
      try {
        const prices = JSON.parse(mkt.outcomePrices || "[]");
        yesPrice = prices[0] !== undefined ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch { /* ignore */ }
      const label = (mkt.groupItemTitle || mkt.question || "").trim();
      if (/°f|fahrenheit/i.test(label)) unit = "F";
      if (yesPrice !== null && label) buckets.push({ label, yesPrice });
    }
    if (buckets.length === 0) continue;

    found.push({ title, slug: ev.slug, cityKey, city: CITIES[cityKey], buckets, unit });
  }
  return found;
}

// ---------- 城市模型機率 ----------
async function cityModelProbs(city, cityKey, unit) {
  const date = cityLocalDate(city.tz);
  const unitParam = unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    `&daily=temperature_2m_max&timezone=${encodeURIComponent(city.tz)}&models=${MODELS.join(",")}` +
    `&start_date=${date}&end_date=${date}${unitParam}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const bias = city.hasBias ? loadBias() : {};
  const values = [];
  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) {
      // bias係°C計嘅，°F市場要×1.8
      const b = (bias[m] || 0) * (unit === "F" ? 1.8 : 1);
      values.push(arr[0] + b);
    }
  }
  if (values.length < 2) return null;

  const n = values.length;
  const mean = values.reduce((a,b)=>a+b,0)/n;
  let std = Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(n-1,1));
  std = Math.max(std, unit === "F" ? STD_FLOOR * 1.8 : STD_FLOOR);
  if (!city.hasBias) std *= NO_BIAS_STD_INFLATE;

  // 逐度機率map（範圍闊啲，°F可以去到110+）
  const lo = Math.floor(mean - 6 * std) - 2, hi = Math.ceil(mean + 6 * std) + 2;
  const probs = {};
  for (let b = lo; b <= hi; b++) {
    probs[b] = normalCdf(b+1, mean, std) - normalCdf(b, mean, std);
  }
  return { probs, mean, std, lo, hi };
}

function bucketModelProb(label, model) {
  const t = label.toLowerCase();
  const numMatch = t.match(/(-?\d+)/);
  if (!numMatch) return null;
  const deg = parseInt(numMatch[1], 10);
  const sum = (from, to) => {
    let s = 0;
    for (let b = from; b <= to; b++) s += model.probs[b] || 0;
    return s;
  };
  if (t.includes("higher") || t.includes("above")) return sum(deg, model.hi);
  if (t.includes("below") || t.includes("lower")) return sum(model.lo, deg);
  return model.probs[deg] ?? 0;
}

async function sendTelegram(text) {
  const token = process.env.TG_BOT_TOKEN, chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) { console.log("（未設定Telegram，只print）\n" + text.replace(/<[^>]+>/g, "")); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) console.error("Telegram失敗:", res.status, await res.text());
}

// ---------- 主程式 ----------
async function main() {
  console.log("🌍 掃描Polymarket溫度市場中...\n");
  const markets = await discoverMarkets();
  console.log(`發現 ${markets.length} 個可分析市場\n`);

  const allEdges = [];
  for (const mkt of markets) {
    try {
      const model = await cityModelProbs(mkt.city, mkt.cityKey, mkt.unit);
      if (!model) { console.log(`  ⚠️ ${mkt.cityKey}: 模型數據不足`); continue; }

      for (const b of mkt.buckets) {
        const mp = bucketModelProb(b.label, model);
        if (mp === null) continue;
        const modelPct = Math.round(mp * 100);
        const edge = modelPct - b.yesPrice;
        // 排除極端價位（<3¢/>97¢嘅bucket，流動性差+費用食晒edge）
        if (Math.abs(edge) >= EDGE_THRESHOLD && b.yesPrice >= 3 && b.yesPrice <= 97) {
          allEdges.push({
            city: mkt.cityKey, title: mkt.title, slug: mkt.slug,
            label: b.label, market: b.yesPrice, model: modelPct, edge,
            corrected: !!mkt.city.hasBias, unit: mkt.unit,
            meanStr: `${model.mean.toFixed(1)}°${mkt.unit} σ${model.std.toFixed(1)}`,
          });
        }
      }
      console.log(`  ✅ ${mkt.cityKey}: 平均${model.mean.toFixed(1)}°${mkt.unit} σ${model.std.toFixed(1)}（${mkt.buckets.length} buckets）`);
    } catch (e) {
      console.log(`  ❌ ${mkt.cityKey}: ${e.message}`);
    }
  }

  allEdges.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  const top = allEdges.slice(0, MAX_REPORT);

  if (top.length === 0) {
    console.log("\n今次掃描冇發現顯著edge。");
    return;
  }

  const lines = top.map((e) => {
    const dir = e.edge > 0 ? "→ Yes低估" : "→ No（市場高估）";
    const tag = e.corrected ? "✓已校正" : "⚠未校正";
    return `<b>${e.city.toUpperCase()}</b> ${e.label}\n` +
      `  模型${e.model}% vs 市場${e.market}¢ = <b>${e.edge > 0 ? "+" : ""}${e.edge}%</b> ${dir}\n` +
      `  （${e.meanStr} · ${tag}）\n` +
      `  <a href="https://polymarket.com/event/${e.slug}">開market</a>`;
  });

  const msg = `🌍 <b>全球溫度市場Edge掃描</b>（${new Date().toISOString().slice(0,16).replace("T"," ")} UTC）\n` +
    `掃描${markets.length}個市場，發現${allEdges.length}個edge，Top ${top.length}：\n\n` +
    lines.join("\n\n") +
    `\n\n⚠️ 「未校正」城市冇本地bias數據，edge可信度打七折；只有香港係經26日實測校正。`;

  await sendTelegram(msg);
  console.log(`\n✅ 已推送 ${top.length} 個top edges`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
