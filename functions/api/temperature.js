// functions/api/temperature.js — Cloudflare Pages Function版
// ------------------------------------------------------------
// 同netlify/functions/temperature.js功能一致,行Workers runtime:
// HKO兩個CSV+METAR(即時/歷史)+rhrread雨量,解決CORS。
// CF免費額度=10萬request/日(每日reset),dashboard優化後用量~3千/日。
// ------------------------------------------------------------

const LIVE_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv";
const MAXMIN_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;

function parseTimestamp(ts) {
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8);
  const h = ts.slice(8, 10), mi = ts.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
}

function toOneDecimal(str) {
  if (str === undefined || str === null || str.trim() === "" || str.trim().toUpperCase() === "N/A") return null;
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : Math.round(n * 10) / 10;
}

// aviationweather嘅reportTime係"YYYY-MM-DD HH:MM:SS"UTC但冇Z,要自己補
function metarTimeIso(m) {
  if (typeof m.obsTime === "number") return new Date(m.obsTime * 1000).toISOString();
  const t = m.reportTime || m.obsTime;
  if (!t) return null;
  const s = String(t);
  try {
    return /Z$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s).toISOString() : new Date(s.replace(" ", "T") + "Z").toISOString();
  } catch { return null; }
}

// ⚠️所有上游fetch都要cache:"no-store"——Workers嘅fetch()預設經Cloudflare
// edge cache,HKO嘅CSV試過俾佢食住舊版個零鐘,dashboard以為讀數唔更新
async function fetchLive() {
  const res = await fetch(LIVE_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`latest_1min_temperature CSV 錯誤: ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [ts, place, tempStr] = line.split(",").map((s) => s.trim());
    if (STATION_PATTERN.test(place)) {
      return { recordTime: parseTimestamp(ts), value: toOneDecimal(tempStr) };
    }
  }
  return null;
}

async function fetchMaxMin() {
  const res = await fetch(MAXMIN_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`latest_since_midnight_maxmin CSV 錯誤: ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    const [ts, place, maxStr, minStr] = parts;
    if (STATION_PATTERN.test(place)) {
      return { recordTime: parseTimestamp(ts), max: toOneDecimal(maxStr), min: toOneDecimal(minStr) };
    }
  }
  return null;
}

async function fetchMetar() {
  const res = await fetch("https://aviationweather.gov/api/data/metar?ids=VHHH,ZSPD,ZBAA,EGLC,LFPB,ZGSZ&format=json", { cache: "no-store" });
  if (!res.ok) throw new Error(`METAR API 錯誤: ${res.status}`);
  const arr = await res.json();
  const out = {};
  // ⚠️API可能一個站返多份報文(唔保證順序)。以前係「最後入嘅贏」,
  // 攞到舊報文都唔知——2026-08-06見過朝早8點顯示緊尋日15:00嘅34°。
  // 一律揀obsTime最新嗰份。
  for (const m of Array.isArray(arr) ? arr : []) {
    if (!m.icaoId || typeof m.temp !== "number") continue;
    const iso = metarTimeIso(m);
    const prev = out[m.icaoId];
    if (prev && prev.obsTime && iso && Date.parse(iso) <= Date.parse(prev.obsTime)) continue;
    out[m.icaoId] = { tempC: m.temp, obsTime: iso, wx: m.wxString || null };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// rhrread一次過攞雨量+溫度:溫度做「雙水喉」後備(整數°C但快~4分鐘,
// 1分鐘CSV滯後嗰陣頂上——worker.js一早係咁設計,dashboard跟隊)
async function fetchRhrread() {
  const res = await fetch("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc", { cache: "no-store" });
  if (!res.ok) throw new Error(`rhrread ${res.status}`);
  const json = await res.json();

  let rain = null;
  const data = json.rainfall?.data;
  if (Array.isArray(data)) {
    let local = null, maxMm = 0, maxDistrict = null;
    for (const d of data) {
      const mm = typeof d.max === "number" ? d.max : 0;
      if (d.place === "油尖旺") local = mm;
      if (mm > maxMm) { maxMm = mm; maxDistrict = d.place; }
    }
    rain = { localMm: local, maxMm, maxDistrict, endTime: json.rainfall?.endTime ?? null };
  }

  let temp = null;
  const tArr = json.temperature?.data;
  if (Array.isArray(tArr)) {
    const hko = tArr.find((t) => t.place === "香港天文台" && typeof t.value === "number");
    if (hko) temp = { value: hko.value, recordTime: json.temperature?.recordTime ?? null };
  }

  return { rain, temp };
}

// 揀邊條水喉:CSV有0.1°精度優先;但CSV滯後>20分鐘而rhrread更新鮮就轉用
export function pickLive(csvLive, rrTemp) {
  const age = (t) => t ? Date.now() - new Date(t).getTime() : Infinity;
  const csvAge = age(csvLive?.recordTime);
  const rrAge = age(rrTemp?.recordTime);
  if (csvLive && csvLive.value !== null && (csvAge <= 20 * 60e3 || rrAge >= csvAge)) {
    return { ...csvLive, source: "csv" };
  }
  if (rrTemp && rrTemp.recordTime) {
    return { recordTime: rrTemp.recordTime, value: rrTemp.value, source: "rhrread" };
  }
  return csvLive ? { ...csvLive, source: "csv" } : null;
}

async function fetchMetarHistory(icao, hours) {
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=${hours}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`METAR history API 錯誤: ${res.status}`);
  const arr = await res.json();
  const out = [];
  for (const m of Array.isArray(arr) ? arr : []) {
    const iso = metarTimeIso(m);
    if (typeof m.temp === "number" && iso) {
      out.push({ tempC: m.temp, obsTime: iso });
    }
  }
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const history = url.searchParams.get("history");

  if (history) {
    const icao = history.toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao)) return json({ error: "history要係4位ICAO代碼" }, 400);
    const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours"), 10) || 26, 1), 48);
    try {
      return json({ icao, history: await fetchMetarHistory(icao, hours) });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  const [liveResult, maxMinResult, metarResult, rhrreadResult] = await Promise.allSettled([
    fetchLive(), fetchMaxMin(), fetchMetar(), fetchRhrread(),
  ]);

  const response = {};
  const csvLive = liveResult.status === "fulfilled" ? liveResult.value : null;
  const rrTemp = rhrreadResult.status === "fulfilled" ? rhrreadResult.value?.temp : null;
  const live = pickLive(csvLive, rrTemp);
  if (live && live.value !== null) {
    response.live = live;
  } else {
    response.liveError = liveResult.status === "rejected" ? liveResult.reason.message : "搵唔到即時溫度站資料";
  }
  if (maxMinResult.status === "fulfilled" && maxMinResult.value) {
    response.today = { max: maxMinResult.value.max, min: maxMinResult.value.min };
    response.todayRecordTime = maxMinResult.value.recordTime;
  } else {
    response.todayError = maxMinResult.status === "rejected" ? maxMinResult.reason.message : "搵唔到今日高低溫資料";
  }
  if (metarResult.status === "fulfilled" && metarResult.value) {
    response.metars = metarResult.value;
    response.metar = metarResult.value.VHHH || null;
  } else {
    // ⚠️以前METAR/rhrread死咗係完全靜音:個欄唔見咗,dashboard就顯示「--」,
    // 睇落似「未有數據」多過「壞咗」。而家一律講返點解死。
    response.metarError = metarResult.status === "rejected" ? metarResult.reason.message : "METAR冇可用報文";
  }
  if (rhrreadResult.status === "fulfilled" && rhrreadResult.value?.rain) {
    response.rain = rhrreadResult.value.rain;
  } else {
    response.rainError = rhrreadResult.status === "rejected" ? rhrreadResult.reason.message : "rhrread冇雨量數據";
  }

  // ⚠️2026-08-26:以前係 liveError ? 502 : 200。
  // 但四條水喉係 Promise.allSettled 分開跑嘅——內部好努力做到「一條死唔拖冧其餘」,
  // 去到HTTP status呢層又夾返埋一齊掉。client第一句 if(!res.ok) throw,
  // 結果HKO個1分鐘CSV打個乞嚏,就連 today.max(結算用嗰個數)、METAR、雨量
  // 一齊掉埋——🔒鎖定panel同今日階梯凍住,而嗰啲數其實明明攞到咗。
  // 而個1分鐘CSV正正係四條入面最唔穩嗰條。
  // 依家:仲有嘢俾得到就回200,由client逐格自己決定畫唔畫;
  //       四條全死先回502(嗰陣真係乜都冇)。
  const anyUseful = response.live || response.today || response.metars || response.rain;
  return json(response, anyUseful ? 200 : 502);
}
