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

async function fetchLive() {
  const res = await fetch(LIVE_CSV_URL);
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
  const res = await fetch(MAXMIN_CSV_URL);
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
  const res = await fetch("https://aviationweather.gov/api/data/metar?ids=VHHH,ZSPD,ZBAA,EGLC,LFPB&format=json");
  if (!res.ok) throw new Error(`METAR API 錯誤: ${res.status}`);
  const arr = await res.json();
  const out = {};
  for (const m of Array.isArray(arr) ? arr : []) {
    if (m.icaoId && typeof m.temp === "number") {
      out[m.icaoId] = { tempC: m.temp, obsTime: metarTimeIso(m), wx: m.wxString || null };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function fetchRain() {
  const res = await fetch("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc");
  if (!res.ok) throw new Error(`rhrread ${res.status}`);
  const json = await res.json();
  const data = json.rainfall?.data;
  if (!Array.isArray(data)) return null;
  let local = null, maxMm = 0, maxDistrict = null;
  for (const d of data) {
    const mm = typeof d.max === "number" ? d.max : 0;
    if (d.place === "油尖旺") local = mm;
    if (mm > maxMm) { maxMm = mm; maxDistrict = d.place; }
  }
  return { localMm: local, maxMm, maxDistrict, endTime: json.rainfall?.endTime ?? null };
}

async function fetchMetarHistory(icao, hours) {
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=${hours}`);
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

  const [liveResult, maxMinResult, metarResult, rainResult] = await Promise.allSettled([
    fetchLive(), fetchMaxMin(), fetchMetar(), fetchRain(),
  ]);

  const response = {};
  if (liveResult.status === "fulfilled" && liveResult.value) {
    response.live = liveResult.value;
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
  }
  if (rainResult.status === "fulfilled" && rainResult.value) {
    response.rain = rainResult.value;
  }

  return json(response, response.liveError ? 502 : 200);
}
