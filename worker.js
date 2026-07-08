/**
 * worker.js — HK溫度警報系統 Cloudflare Worker版
 * ------------------------------------------------------------
 * 完整移植自 alert.js：雙水喉（CSV+rhrread）、破關/新高/逼近/見頂警報、
 * 惡劣天氣警示、Edge Scanner、Telegram推送。
 *
 * 同Node版嘅分別：
 *   - state存喺Workers KV（binding名: STATE）
 *   - bias.json由你GitHub repo raw URL讀取（每星期日daily_log自動更新嗰份）
 *   - 唔做history.csv記錄（嗰part留返俾GitHub Actions繼續做）
 *
 * 需要設定（部署步驟見對話）：
 *   KV binding:  STATE
 *   Secrets:     TG_BOT_TOKEN, TG_CHAT_ID
 *   Cron:        * * * * *  （每分鐘，真.準時）
 * ------------------------------------------------------------
 */

const LIVE_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv";
const MAXMIN_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const RHRREAD_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc";
const WARNSUM_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=tc";
const BIAS_URL = "https://raw.githubusercontent.com/josephci/hk-weather-dashboard/main/bias.json";

const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const APPROACH_MARGIN = 0.3;
const PULLBACK_MARGIN = 0.8;
const EDGE_THRESHOLD = 10;
const STD_INFLATE_ON_WARNING = 1.8;
const LAT = 22.302, LON = 114.174;
const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const MODEL_RISK_WARNINGS = { WTCSGNL: "熱帶氣旋警告", WTS: "雷暴警告", WRAIN: "暴雨警告" };

// ---------- 工具 ----------
function parseTimestamp(ts) {
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8), h = ts.slice(8, 10), mi = ts.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
}
function toNum(s) {
  if (!s || s.trim().toUpperCase() === "N/A") return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 10) / 10;
}
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

// ---------- 數據源 ----------
async function fetchCsvRow(url) {
  const res = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`CSV錯誤 ${url}: ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (STATION_PATTERN.test(parts[1])) return parts;
  }
  throw new Error(`搵唔到天文台總部行: ${url}`);
}

async function fetchRhrread() {
  try {
    const res = await fetch(RHRREAD_URL, { cf: { cacheTtl: 0 } });
    if (!res.ok) throw new Error(`rhrread ${res.status}`);
    const json = await res.json();
    const station = json.temperature?.data?.find((d) => STATION_PATTERN.test(d.place.trim()));
    if (!station) return null;
    return { value: Number(station.value), recordTime: json.temperature.recordTime ?? null };
  } catch (e) {
    console.log("rhrread快水喉失敗:", e.message);
    return null;
  }
}

async function fetchActiveWarnings() {
  try {
    const res = await fetch(WARNSUM_URL, { cf: { cacheTtl: 0 } });
    if (!res.ok) throw new Error(`warnsum ${res.status}`);
    const json = await res.json();
    const active = [];
    for (const [code, label] of Object.entries(MODEL_RISK_WARNINGS)) {
      const w = json[code];
      if (w && w.actionCode !== "CANCEL") active.push({ code, label, name: w.name || label });
    }
    return active;
  } catch (e) {
    console.log("警告查詢失敗:", e.message);
    return [];
  }
}

async function fetchPolymarketHKTemp(dateStr) {
  try {
    // 直接用slug命中當日market（固定格式），唔好拉100個events返嚟自己搵——
    // 大JSON parse會爆免費版Worker嘅10ms CPU上限
    const [y, m, d] = dateStr.split("-").map(Number);
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const slug = `highest-temperature-in-hong-kong-on-${monthNames[m-1]}-${d}`;
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { cf: { cacheTtl: 0 } });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);
    const events = await res.json();
    const target = Array.isArray(events) ? events[0] : null;
    if (!target) return null;

    const lines = [], buckets = [];
    for (const mkt of target.markets || []) {
      let yesPrice = null;
      try {
        const prices = JSON.parse(mkt.outcomePrices || "[]");
        yesPrice = prices[0] !== undefined ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch { /* ignore */ }
      const label = (mkt.groupItemTitle || mkt.question || "?").trim();
      if (yesPrice !== null) { lines.push(`  ${label}: ${yesPrice}¢`); buckets.push({ label, yesPrice }); }
    }
    return { title: target.title, url: `https://polymarket.com/event/${target.slug}`, priceLines: lines, buckets };
  } catch (e) {
    console.log("Polymarket查詢失敗:", e.message);
    return null;
  }
}

async function loadBias() {
  try {
    const res = await fetch(BIAS_URL, { cf: { cacheTtl: 300 } }); // bias一星期先變一次,cache 5分鐘冇問題
    if (!res.ok) return {};
    return (await res.json()).max || {};
  } catch { return {}; }
}

async function computeModelProbs(todayStr, todayMax, hourHK, hasWarning) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max&timezone=auto&models=${MODELS.join(",")}` +
    `&start_date=${todayStr}&end_date=${todayStr}`;
  const res = await fetch(url, { cf: { cacheTtl: 600 } }); // 模型每幾個鐘先更新,cache 10分鐘慳請求
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const bias = await loadBias();
  const values = [];
  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) values.push(arr[0] + (bias[m] || 0));
  }
  if (values.length < 2) return null;

  const n = values.length;
  const mean = values.reduce((a,b)=>a+b,0)/n;
  let std = Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(n-1,1));
  std = Math.max(std, 0.4);
  if (hasWarning) std *= STD_INFLATE_ON_WARNING;

  let upsideFactor = 1;
  if (todayMax !== null) {
    if (hourHK >= 17 || hourHK < 6) upsideFactor = 0.03;
    else if (hourHK >= 14) upsideFactor = 1 - (hourHK - 14) / 3 * 0.8;
  }

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

function bucketModelProb(label, probs) {
  const t = label.toLowerCase();
  const numMatch = t.match(/(\d+)/);
  if (!numMatch) return null;
  const deg = parseInt(numMatch[1], 10);
  const sum = (from, to) => { let s = 0; for (let b = from; b <= to; b++) s += probs[b] || 0; return s; };
  if (t.includes("higher") || t.includes("above")) return sum(deg, 40);
  if (t.includes("below") || t.includes("lower")) return sum(18, deg);
  return probs[deg] ?? null;
}

async function sendTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) { console.log("未設定Telegram secrets:\n" + text); return; }
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!res.ok) console.log("Telegram推送失敗:", res.status, await res.text());
}

// ---------- METAR監察（上海浦東ZSPD / 北京首都ZBAA） ----------
// 呢兩個城市嘅Polymarket結算源係機場METAR（整數°C），
// 所以整數就係全精度，破新整數高=結算相關事件。
const METAR_AIRPORTS = [
  { icao: "ZSPD", name: "上海浦東", citySlug: "shanghai" },
  { icao: "ZBAA", name: "北京首都", citySlug: "beijing" },
];

async function fetchMetars() {
  try {
    const ids = METAR_AIRPORTS.map((a) => a.icao).join(",");
    const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`, { cf: { cacheTtl: 0 } });
    if (!res.ok) throw new Error(`METAR API ${res.status}`);
    const arr = await res.json();
    const out = {};
    for (const m of Array.isArray(arr) ? arr : []) {
      if (m.icaoId && typeof m.temp === "number") {
        out[m.icaoId] = { temp: Math.round(m.temp), obsTime: m.reportTime || m.obsTime || null };
      }
    }
    return out;
  } catch (e) {
    console.log("METAR查詢失敗（唔影響主流程）:", e.message);
    return {};
  }
}

// 城市當地「今日」日期（上海北京同香港同時區UTC+8，直接用recordTime嘅日期就得）
async function checkMetarBreakouts(state, today, events) {
  const metars = await fetchMetars();
  if (Object.keys(metars).length === 0) return;

  if (!state.metar) state.metar = {};
  for (const ap of METAR_AIRPORTS) {
    const reading = metars[ap.icao];
    if (!reading) continue;

    let st = state.metar[ap.icao];
    // 新一日reset（中國時區=香港時區，用同一個today）
    if (!st || st.date !== today) {
      st = { date: today, maxSoFar: reading.temp, alertedMax: null };
      state.metar[ap.icao] = st;
      continue; // 第一個讀數只建baseline,唔通知
    }

    if (reading.temp > st.maxSoFar) {
      st.maxSoFar = reading.temp;
      if (st.alertedMax !== reading.temp) {
        const [y, m, d] = today.split("-").map(Number);
        const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
        const slug = `highest-temperature-in-${ap.citySlug}-on-${monthNames[m-1]}-${d}`;
        events.push(
          `✈️🚨 <b>${ap.name} METAR新高</b>：${reading.temp}°C（${reading.obsTime?.slice(11, 16) ?? "?"} UTC報文）\n` +
          `→ 結算源就係METAR整數，「&lt;${reading.temp}°C」bucket已死\n` +
          `👉 <a href="https://polymarket.com/event/${slug}">開${ap.citySlug} market</a>`
        );
        st.alertedMax = reading.temp;
      }
    }
  }
}

// ---------- 主邏輯 ----------
async function runCheck(env) {
  const [liveRow, maxMinRow, fast] = await Promise.all([
    fetchCsvRow(LIVE_CSV_URL),
    fetchCsvRow(MAXMIN_CSV_URL),
    fetchRhrread(),
  ]);

  const current = toNum(liveRow[2]);
  const recordTime = parseTimestamp(liveRow[0]);
  const todayMax = toNum(maxMinRow[2]);
  const todayMin = toNum(maxMinRow[3]);

  const state = JSON.parse((await env.STATE.get("alert_state")) || "{}");
  const today = recordTime.slice(0, 10);
  if (state.date !== today) {
    Object.assign(state, { date: today, prevCurrent: null, prevMax: null, alertedFloors: [], approachAlerted: null, pulledBackAlerted: false, edgeAlerted: {}, fastAlerted: [] });
  }

  const events = [];

  // A0: 快水喉搶先破關偵測
  if (fast && !Number.isNaN(fast.value) && todayMax !== null) {
    const fastFloor = Math.floor(fast.value);
    const knownFloor = Math.floor(todayMax);
    const fastAlerted = state.fastAlerted || [];
    if (fastFloor > knownFloor && !fastAlerted.includes(fastFloor)) {
      events.push(
        `⚡🚨 <b>快水喉搶先訊號</b>：rhrread現報 ${fast.value}°C（整數，${fast.recordTime?.slice(11, 16) ?? "?"}讀數）\n` +
        `高過CSV已知今日max ${todayMax.toFixed(1)}°C 嘅整數位 → <b>${fastFloor}.0°C關口大概率已破</b>\n` +
        `→ CSV要遲~4分鐘先確認，呢一刻市場可能未完全重價，判斷後從速`
      );
      fastAlerted.push(fastFloor);
      state.fastAlerted = fastAlerted;
    }
  }

  // A: 今日新高
  if (todayMax !== null && state.prevMax !== null && todayMax > state.prevMax) {
    events.push(`📈 <b>今日新高</b>：${todayMax.toFixed(1)}°C（之前 ${state.prevMax.toFixed(1)}°C）`);
  }

  // B: 破整數關口（連快水喉去重）
  if (todayMax !== null) {
    const floor = Math.floor(todayMax);
    const alerted = state.alertedFloors || [];
    if (state.prevMax !== null && floor > Math.floor(state.prevMax) && !alerted.includes(floor)) {
      const wasFastAlerted = (state.fastAlerted || []).includes(floor);
      events.push(wasFastAlerted
        ? `✅ <b>CSV確認</b>：今日高溫 ${todayMax.toFixed(1)}°C，${floor}.0°C關口正式確認已破（快水喉早前已提示）`
        : `🚨 <b>破關口</b>：今日高溫已升穿 ${floor}.0°C（現報 ${todayMax.toFixed(1)}°C）\n→ Polymarket「&lt;${floor}°C」bucket已死，重價中`);
      alerted.push(floor);
      state.alertedFloors = alerted;
    }
  }

  // C: 逼近關口
  if (current !== null && todayMax !== null) {
    const nextGate = Math.floor(todayMax) + 1;
    const distance = nextGate - todayMax;
    const rising = state.prevCurrent !== null && current > state.prevCurrent;
    if (distance > 0 && distance <= APPROACH_MARGIN && rising && state.approachAlerted !== nextGate) {
      events.push(
        `⚡ <b>逼近關口</b>：今日高溫 ${todayMax.toFixed(1)}°C，距離 ${nextGate}.0°C 僅 ${distance.toFixed(1)}°C，現時溫度上升中（${current.toFixed(1)}°C）\n→ 若判斷會破，宜早過bot部署`
      );
      state.approachAlerted = nextGate;
    }
  }

  // D: 回落確認
  if (current !== null && todayMax !== null && !state.pulledBackAlerted) {
    const hourHK = parseInt(recordTime.slice(11, 13), 10);
    if (hourHK >= 13 && todayMax - current >= PULLBACK_MARGIN) {
      events.push(
        `🌧 <b>可能見頂</b>：現時 ${current.toFixed(1)}°C，比今日高溫 ${todayMax.toFixed(1)}°C 低 ${(todayMax - current).toFixed(1)}°C（下晝${hourHK}點後）\n→ 今日高溫大概率鎖定，高於${Math.floor(todayMax) + 1}°C嘅bucket嘅No值博率上升`
      );
      state.pulledBackAlerted = true;
    }
  }

  // E: 惡劣天氣警告變化
  const warnings = await fetchActiveWarnings();
  const warnCodes = warnings.map((w) => w.code).sort().join(",");
  const hasWarning = warnings.length > 0;
  if (warnCodes !== (state.lastWarnCodes ?? "")) {
    if (hasWarning) {
      events.push(`⚠️ <b>惡劣天氣警告生效</b>：${warnings.map((w) => w.name).join("、")}\n→ 呢啲日子模型可靠度低（可錯3-5σ），edge計算已自動放大不確定性，建議減注`);
    } else if (state.lastWarnCodes) {
      events.push(`✅ <b>天氣警告已解除</b>，模型可靠度回復正常`);
    }
    state.lastWarnCodes = warnCodes;
  }

  // G: METAR監察（上海浦東/北京首都，每5分鐘check——METAR本身每30-60分鐘一報）
  if (new Date().getUTCMinutes() % 5 === 2) {
    await checkMetarBreakouts(state, today, events);
  }

  // F: Edge Scanner（日間07-17，每5分鐘掃一次慳CPU）
  const hourHK = parseInt(recordTime.slice(11, 13), 10);
  const minuteNow = new Date().getUTCMinutes();
  let market = null;
  if (hourHK >= 7 && hourHK < 17 && minuteNow % 5 === 0) {
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
              const last = edgeAlerted[b.label];
              if (last === undefined || Math.abs(edge - last) >= 8) {
                const dir = edge > 0 ? "買Yes（市場低估）" : "買No（市場高估）";
                edgeLines.push(`  ${b.label}: 模型${modelPct}% vs 市場${b.yesPrice}¢ → <b>${edge > 0 ? "+" : ""}${edge}%</b> ${dir}`);
                edgeAlerted[b.label] = edge;
              }
            } else if (edgeAlerted[b.label] !== undefined) {
              delete edgeAlerted[b.label];
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
      console.log("Edge scan失敗:", e.message);
    }
  }

  if (events.length > 0) {
    const fastLine = fast && !Number.isNaN(fast.value) ? ` ｜ 快 ${fast.value}°(${fast.recordTime?.slice(11, 16) ?? "?"})` : "";
    const header = `🌡 <b>HK天文台總部</b>（${recordTime.slice(11, 16)}）\n現時 ${current?.toFixed(1) ?? "N/A"}°C${fastLine} ｜ 今日 ${todayMax?.toFixed(1) ?? "?"}° / ${todayMin?.toFixed(1) ?? "?"}°\n\n`;

    let marketBlock = "";
    if (!market) market = await fetchPolymarketHKTemp(today);
    if (market) {
      marketBlock = `\n\n📊 <b>${market.title}</b>`;
      if (market.priceLines.length > 0) marketBlock += `\n${market.priceLines.join("\n")}`;
      marketBlock += `\n👉 <a href="${market.url}">開market落單</a>`;
    }
    await sendTelegram(env, header + events.join("\n\n") + marketBlock);
  }

  state.prevCurrent = current;
  state.prevMax = todayMax;
  await env.STATE.put("alert_state", JSON.stringify(state));

  return { events: events.length, current, todayMax, todayMin };
}

export default {
  // Cron觸發（主要用途）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env).catch((e) => console.log("❌", e.message)));
  },

  // 瀏覽器訪問Worker網址=手動觸發一次+睇狀態（方便測試）
  async fetch(request, env) {
    try {
      const result = await runCheck(env);
      return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
    }
  },
};
