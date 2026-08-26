// netlify/functions/temperature.js
// ------------------------------------------------------------
// 用途：喺伺服器端（Netlify Function）攞天文台兩個CSV：
//   1. latest_1min_temperature.csv        → 即時1分鐘平均氣溫（每10分鐘更新一次）
//   2. latest_since_midnight_maxmin.csv   → 今日午夜至今嘅最高/最低氣溫
// 解析出「天文台總部」嗰行，再以JSON形式俾返個網頁，
// 咁樣個瀏覽器就唔使直接跨域fetch天文台，冇CORS問題。
//
// ⚠️ 兩個CSV嘅站名格式可能唔一致（一個可能係中文「香港天文台」，
//    另一個確認咗係英文「HK Observatory」），所以用同一個pattern
//    兩種都匹配，穩陣啲。
// ------------------------------------------------------------

// aviationweather嘅reportTime格式係"2026-07-16 11:00:00"(UTC但冇Z),
// 直接俾new Date()會當本地時間解析——統一喺呢度轉做ISO UTC先俾前端
function metarTimeIso(m) {
  if (typeof m.obsTime === "number") return new Date(m.obsTime * 1000).toISOString();
  const t = m.reportTime || m.obsTime;
  if (!t) return null;
  const s = String(t);
  try {
    return /Z$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s).toISOString() : new Date(s.replace(" ", "T") + "Z").toISOString();
  } catch { return null; }
}

const LIVE_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv";
const MAXMIN_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;

function parseTimestamp(ts) {
  // 格式 YYYYMMDDHHMM（12位數字，例如 202607051220）
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8);
  const h = ts.slice(8, 10), mi = ts.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
}

function toOneDecimal(str) {
  if (str === undefined || str === null || str.trim() === "" || str.trim().toUpperCase() === "N/A") return null;
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : Math.round(n * 10) / 10;
}

async function fetchLive() {
  const res = await fetch(LIVE_CSV_URL);
  if (!res.ok) throw new Error(`latest_1min_temperature CSV 錯誤: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).slice(1);

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
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).slice(1);

  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    const [ts, place, maxStr, minStr] = parts;
    if (STATION_PATTERN.test(place)) {
      return { recordTime: parseTimestamp(ts), max: toOneDecimal(maxStr), min: toOneDecimal(minStr) };
    }
  }
  return null;
}

// METAR（VHHH赤鱲角+ZSPD浦東+ZBAA首都+EGLC倫敦城市+LFPB巴黎布爾歇）
// ⚠️ VHHH做香港平行數據源（機場≠總部，差1-2°C，睇趨勢用）；
//   ZSPD/ZBAA/EGLC/LFPB就係上海北京倫敦巴黎market嘅結算源本身。
async function fetchMetar() {
  const res = await fetch("https://aviationweather.gov/api/data/metar?ids=VHHH,ZSPD,ZBAA,EGLC,LFPB,ZGSZ&format=json");
  if (!res.ok) throw new Error(`METAR API 錯誤: ${res.status}`);
  const arr = await res.json();
  const out = {};
  // ⚠️API可能一個站返多份報文(唔保證順序)。以前係「最後入嘅贏」,
  // 攞到舊報文都唔知——2026-08-06見過朝早8點顯示緊尋日15:00嘅34°。
  for (const m of Array.isArray(arr) ? arr : []) {
    if (!m.icaoId || typeof m.temp !== "number") continue;
    const iso = metarTimeIso(m);
    const prev = out[m.icaoId];
    if (prev && prev.obsTime && iso && Date.parse(iso) <= Date.parse(prev.obsTime)) continue;
    out[m.icaoId] = {
      tempC: m.temp,
      obsTime: iso,
      wx: m.wxString || null, // 現在天氣代碼(RA=雨,SHRA=驟雨,TS=雷暴...),升返風險判斷用
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// rhrread一次過攞雨量+溫度:溫度做「雙水喉」後備(整數°C但快~4分鐘,
// 1分鐘CSV滯後嗰陣頂上)
async function fetchRhrread() {
  const res = await fetch("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc");
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
function pickLive(csvLive, rrTemp) {
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

// 歷史METAR序列：?history=ZSPD&hours=26
// 用aviationweather嘅hours參數攞返成日報文，俾前端畫「讀數變化趨勢」。
// 唔會逐次poll都夾埋（payload會大好多），前端獨立每5分鐘先攞一次。
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

exports.handler = async function (event) {
  const qp = event?.queryStringParameters || {};

  if (qp.history) {
    const icao = String(qp.history).toUpperCase();
    if (!/^[A-Z]{4}$/.test(icao)) {
      return { statusCode: 400, body: JSON.stringify({ error: "history要係4位ICAO代碼" }) };
    }
    const hours = Math.min(Math.max(parseInt(qp.hours, 10) || 26, 1), 48);
    try {
      const history = await fetchMetarHistory(icao, hours);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          // 瀏覽器唔好cache,但Netlify CDN cache 4分鐘:METAR半個鐘先一份,
          // 幾多個tab/device都共用一次function invocation,慳credit
          "Cache-Control": "no-store",
          "Netlify-CDN-Cache-Control": "public, s-maxage=240, stale-while-revalidate=300",
        },
        body: JSON.stringify({ icao, history }),
      };
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: e.message }) };
    }
  }

  const [liveResult, maxMinResult, metarResult, rhrreadResult] = await Promise.allSettled([fetchLive(), fetchMaxMin(), fetchMetar(), fetchRhrread()]);

  const response = {};

  const csvLive = liveResult.status === "fulfilled" ? liveResult.value : null;
  const rrTemp = rhrreadResult.status === "fulfilled" ? rhrreadResult.value?.temp : null;
  const live = pickLive(csvLive, rrTemp);
  if (live && live.value !== null) {
    response.live = live; // { recordTime, value, source }
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
    response.metars = metarResult.value; // { VHHH: {tempC,obsTime}, ZSPD: {...}, ZBAA: {...} }
    response.metar = metarResult.value.VHHH || null; // 向後兼容舊前端
  } else {
    // ⚠️以前METAR/rhrread死咗係完全靜音:個欄唔見咗,dashboard顯示「--」,
    // 睇落似「未有數據」多過「壞咗」。而家一律講返點解死。
    response.metarError = metarResult.status === "rejected" ? metarResult.reason.message : "METAR冇可用報文";
  }

  if (rhrreadResult.status === "fulfilled" && rhrreadResult.value?.rain) {
    response.rain = rhrreadResult.value.rain; // { localMm, maxMm, maxDistrict, endTime }
  } else {
    response.rainError = rhrreadResult.status === "rejected" ? rhrreadResult.reason.message : "rhrread冇雨量數據";
  }

  // ⚠️2026-08-26:以前係 !liveError ? 200 : 502(見functions/api/temperature.js
  // 個長註解)。四條水喉分開跑,唔應該喺HTTP status呢層夾返埋一齊掉——
  // HKO個1分鐘CSV打個乞嚏,就連today.max(結算用嗰個數)都會俾client掉走。
  // 仲有嘢俾得到就200,四條全死先502。
  const ok = !!(response.live || response.today || response.metars || response.rain);
  return {
    statusCode: ok ? 200 : 502,
    headers: {
      "Content-Type": "application/json",
      // 瀏覽器唔好cache,但Netlify CDN cache 30秒(HKO數據本身幾分鐘先更新):
      // 所有tab/device喺30秒window內共用一次function invocation,慳credit
      "Cache-Control": "no-store",
      ...(ok ? { "Netlify-CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } : {}),
    },
    body: JSON.stringify(response),
  };
};
