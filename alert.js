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
    const buckets = [];
    for (const mkt of target.markets || []) {
      // outcomePrices 通常係 '["0.12","0.88"]' 字串
      let yesPrice = null;
      try {
        const prices = JSON.parse(mkt.outcomePrices || "[]");
        yesPrice = prices[0] !== undefined ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch { /* ignore */ }
      const label = (mkt.groupItemTitle || mkt.question || "?").trim();
      if (yesPrice !== null) {
        lines.push(`  ${label}: ${yesPrice}¢`);
        buckets.push({ label, yesPrice });
      }
    }

    return {
      title: target.title,
      url: `https://polymarket.com/event/${target.slug}`,
      priceLines: lines,
      buckets,
    };
  } catch (e) {
    console.error("Polymarket查詢失敗（唔影響警報）:", e.message);
    return null;
  }
}

// ---------- 天文台警告（模組2：惡劣天氣=模型不可信） ----------
const WARNSUM_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=tc";
// 影響溫度預測可靠度嘅警告類型
const MODEL_RISK_WARNINGS = {
  WTCSGNL: "熱帶氣旋警告",
  WTS: "雷暴警告",
  WRAIN: "暴雨警告",
};

async function fetchActiveWarnings() {
  try {
    const res = await fetch(WARNSUM_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`warnsum ${res.status}`);
    const json = await res.json();
    const active = [];
    for (const [code, label] of Object.entries(MODEL_RISK_WARNINGS)) {
      const w = json[code];
      if (w && w.actionCode !== "CANCEL") {
        active.push({ code, label, name: w.name || label });
      }
    }
    return active;
  } catch (e) {
    console.error("警告查詢失敗（唔影響主流程）:", e.message);
    return [];
  }
}

// ---------- 模型機率（模組1：Edge Scanner基礎） ----------
const LAT = 22.302, LON = 114.174;
const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const BIAS_FILE = path.join(__dirname, "bias.json");
const EDGE_THRESHOLD = 10; // 百分點：模型機率同市場價差呢個數先算有edge
const STD_INFLATE_ON_WARNING = 1.8; // 有惡劣天氣警告時,std放大倍數（肥尾修正）

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

// 計今日高溫嘅逐度機率分佈（結合bias校正+已實現高溫+時間衰減+警告放大std）
async function computeModelProbs(todayStr, todayMax, hourHK, hasWarning) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max&timezone=auto&models=${MODELS.join(",")}` +
    `&start_date=${todayStr}&end_date=${todayStr}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const bias = loadBias();
  const values = [];
  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) values.push(arr[0] + (bias[m] || 0));
  }
  if (values.length < 2) return null;

  const n = values.length;
  const mean = values.reduce((a,b)=>a+b,0)/n;
  let std = Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(n-1,1));
  std = Math.max(std, 0.4); // std下限:模型過度一致都唔好過份自信
  if (hasWarning) std *= STD_INFLATE_ON_WARNING;

  // 時間衰減：夜晚再破新高機會微
  let upsideFactor = 1;
  if (todayMax !== null) {
    if (hourHK >= 17 || hourHK < 6) upsideFactor = 0.03;
    else if (hourHK >= 14) upsideFactor = 1 - (hourHK - 14) / 3 * 0.8;
  }

  // 建逐度機率map（18°C到40°C，夠涵蓋香港所有情況）
  const probs = {};
  const fb = todayMax !== null ? Math.floor(todayMax) : null;
  for (let b = 18; b <= 40; b++) {
    let p = normalCdf(b+1, mean, std) - normalCdf(b, mean, std);
    if (fb !== null) {
      if (b < fb) p = 0;
      else if (b === fb) p = normalCdf(b+1, mean, std);
      else p = p * upsideFactor;
    }
    probs[b] = p;
  }
  const total = Object.values(probs).reduce((a,b)=>a+b,0);
  if (total > 0) for (const k of Object.keys(probs)) probs[k] /= total;

  return { probs, mean, std };
}

// 將Polymarket bucket標籤（"31°C"/"34°C or higher"/"24°C or below"）map去模型機率
function bucketModelProb(label, probs) {
  const t = label.toLowerCase();
  const numMatch = t.match(/(\d+)/);
  if (!numMatch) return null;
  const deg = parseInt(numMatch[1], 10);
  const sum = (from, to) => {
    let s = 0;
    for (let b = from; b <= to; b++) s += probs[b] || 0;
    return s;
  };
  if (t.includes("higher") || t.includes("above")) return sum(deg, 40);
  if (t.includes("below") || t.includes("lower")) return sum(18, deg);
  return probs[deg] ?? null;
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
    Object.assign(state, { date: today, prevCurrent: null, prevMax: null, alertedFloors: [], approachAlerted: null, pulledBackAlerted: false, edgeAlerted: {} });
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

  // E: 惡劣天氣警告變化（模型可信度警示）
  const warnings = await fetchActiveWarnings();
  const warnCodes = warnings.map((w) => w.code).sort().join(",");
  const hasWarning = warnings.length > 0;
  if (warnCodes !== (state.lastWarnCodes ?? "")) {
    if (hasWarning) {
      events.push(
        `⚠️ <b>惡劣天氣警告生效</b>：${warnings.map((w) => w.name).join("、")}\n→ 呢啲日子模型可靠度低（可錯3-5σ），edge計算已自動放大不確定性，建議減注`
      );
    } else if (state.lastWarnCodes) {
      events.push(`✅ <b>天氣警告已解除</b>，模型可靠度回復正常`);
    }
    state.lastWarnCodes = warnCodes;
  }

  // F: Edge Scanner（模型機率 vs 市場價，日間先掃）
  const hourHK = parseInt(recordTime.slice(11, 13), 10);
  let market = null;
  if (hourHK >= 7 && hourHK < 17) {
    try {
      market = await fetchPolymarketHKTemp(today);
      if (market && market.buckets.length > 0) {
        const model = await computeModelProbs(today, todayMax, hourHK, hasWarning);
        if (model) {
          const edgeAlerted = state.edgeAlerted || {};
          const edgeLines = [];
          for (const b of market.buckets) {
            const mp = bucketModelProb(b.label, model.probs);
            if (mp === null) continue;
            const modelPct = Math.round(mp * 100);
            const edge = modelPct - b.yesPrice;
            if (Math.abs(edge) >= EDGE_THRESHOLD) {
              // 去重：同一bucket，edge變化<8個百分點就唔再嘈
              const last = edgeAlerted[b.label];
              if (last === undefined || Math.abs(edge - last) >= 8) {
                const dir = edge > 0 ? "買Yes（市場低估）" : "買No（市場高估）";
                edgeLines.push(`  ${b.label}: 模型${modelPct}% vs 市場${b.yesPrice}¢ → <b>${edge > 0 ? "+" : ""}${edge}%</b> ${dir}`);
                edgeAlerted[b.label] = edge;
              }
            } else if (edgeAlerted[b.label] !== undefined) {
              delete edgeAlerted[b.label]; // edge消失,重置,下次再現先再通知
            }
          }
          state.edgeAlerted = edgeAlerted;
          if (edgeLines.length > 0) {
            const warnNote = hasWarning ? "（⚠️警告生效中,std已放大,edge打咗折先出現,更可信但仍要小心）" : "";
            events.push(`💰 <b>Edge偵測</b>${warnNote}\n模型: 平均${model.mean.toFixed(1)}° σ${model.std.toFixed(1)}°\n${edgeLines.join("\n")}`);
          }
        }
      }
    } catch (e) {
      console.error("Edge scan失敗（唔影響其他警報）:", e.message);
    }
  }

  // 記錄歷史（每次run都記，方便日後覆盤）
  appendHistory(recordTime, current, todayMax, todayMin);

  if (events.length > 0) {
    const header = `🌡 <b>HK天文台總部</b>（${recordTime.slice(11, 16)}）\n現時 ${current?.toFixed(1) ?? "N/A"}°C ｜ 今日 ${todayMax?.toFixed(1) ?? "?"}° / ${todayMin?.toFixed(1) ?? "?"}°\n\n`;

    // 附上當日Polymarket市場連結+現價（一撳直達，慳走搵market嘅時間）
    let marketBlock = "";
    if (!market) market = await fetchPolymarketHKTemp(today);
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
