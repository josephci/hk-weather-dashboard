/**
 * daily_log.js
 * ------------------------------------------------------------
 * 用最穩陣嘅方式建立bias校正：自己每日記錄「模型預測 vs 實測結果」。
 *
 * 兩種模式（由GitHub Actions喺唔同時間觸發）：
 *
 *   --mode=forecast   香港時間朝早07:15跑
 *     攞6個模型對「今日」嘅最高溫預測，寫入 forecast_log.csv
 *     （呢個就係你朝早落單嗰陣見到嘅預測，公平比較基準）
 *
 *   --mode=settle     香港時間夜晚23:45跑
 *     攞天文台總部今日實測最高溫，填返落 forecast_log.csv 對應行，
 *     然後用全部已完成嘅記錄重新計算每個模型嘅bias → bias.json
 *
 * 遠程城市擴展（上海ZSPD/北京ZBAA/倫敦EGLC/巴黎LFPB）：
 *   forecast模式順手記埋各城市當地「今日」嘅6模型預測
 *     → forecast_log_{city}.csv（每城市一個檔,唔郁香港個檔）
 *   settle模式結算各城市當地「昨日」：用METAR過去48小時報文搵當日最高
 *     （揀昨日因為倫敦嗰邊HK 23:45先係下晝,當日未完;結算口徑=METAR整數,
 *       同Polymarket結算源一致）
 *   儲夠7日就寫入bias.json嘅cities key,dashboard/scanner自動轉「已校正」
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const FORECAST_LOG = path.join(__dirname, "forecast_log.csv");
const BIAS_FILE = path.join(__dirname, "bias.json");

const LAT = 22.302, LON = 114.174;
const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const MAXMIN_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const MIN_SAMPLES = 7; // 至少幾多日數據先出bias

// 遠程城市（結算站=機場,座標同dashboard/scan_cities一致）
const REMOTE_CITIES = {
  shanghai: { icao: "ZSPD", lat: 31.143,  lon: 121.805, tz: "Asia/Shanghai" },
  beijing:  { icao: "ZBAA", lat: 40.080,  lon: 116.585, tz: "Asia/Shanghai" },
  london:   { icao: "EGLC", lat: 51.505,  lon: 0.055,   tz: "Europe/London" }, // 倫敦城市機場(結算站)
  paris:    { icao: "LFPB", lat: 48.9694, lon: 2.4414,  tz: "Europe/Paris" },  // 巴黎布爾歇(結算站)
};

function hkToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cityLocalDate(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// aviationweather嘅reportTime係"2026-07-16 11:00:00"(UTC但冇Z),
// 直接new Date()會當本地時間——要自己補返個Z
function metarTimeIso(m) {
  if (typeof m.obsTime === "number") return new Date(m.obsTime * 1000).toISOString();
  const t = m.reportTime || m.obsTime;
  if (!t) return null;
  const s = String(t);
  return /Z$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s).toISOString() : new Date(s.replace(" ", "T") + "Z").toISOString();
}

function logFileFor(cityKey) {
  return path.join(__dirname, `forecast_log_${cityKey}.csv`);
}

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v];
    })
  );
  return { mode: args.mode };
}

// CSV欄位: date, gfs, ecmwf, icon, ukmo, gem, jma, realized
const HEADER = "date," + MODELS.join(",") + ",realized";

function loadLog(file = FORECAST_LOG) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    const parts = line.split(",");
    const row = { date: parts[0], forecasts: {}, realized: parts[MODELS.length + 1] || "" };
    MODELS.forEach((m, i) => { row.forecasts[m] = parts[i + 1] || ""; });
    return row;
  });
}

function saveLog(rows, file = FORECAST_LOG) {
  rows.sort((a, b) => a.date.localeCompare(b.date)); // settle昨日+forecast今日可能亂序
  const lines = [HEADER];
  for (const r of rows) {
    lines.push([r.date, ...MODELS.map((m) => r.forecasts[m] ?? ""), r.realized ?? ""].join(","));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// 由已完成記錄計bias(所有城市共用同一條公式)
function computeBias(rows) {
  const complete = rows.filter((r) => r.realized !== "" && MODELS.some((m) => r.forecasts[m] !== ""));
  const biasMax = {};
  for (const m of MODELS) {
    const diffs = complete
      .filter((r) => r.forecasts[m] !== "")
      .map((r) => parseFloat(r.realized) - parseFloat(r.forecasts[m]))
      .filter((d) => !Number.isNaN(d));
    if (diffs.length >= MIN_SAMPLES) {
      biasMax[m] = Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 100) / 100;
    }
  }
  return { sampleDays: complete.length, max: biasMax };
}

// ---------- forecast模式 ----------
async function runForecast() {
  const today = hkToday();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max&timezone=auto&models=${MODELS.join(",")}` +
    `&start_date=${today}&end_date=${today}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const rows = loadLog();
  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }

  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) row.forecasts[m] = arr[0].toFixed(1);
  }

  saveLog(rows);
  console.log(`✅ 已記錄 ${today} 嘅模型預測:`, MODELS.map((m) => `${m}=${row.forecasts[m] || "N/A"}`).join(" "));

  // ---- 遠程城市:記當地「今日」預測(邊個城市fail唔影響其他) ----
  for (const [key, cfg] of Object.entries(REMOTE_CITIES)) {
    try {
      await forecastRemoteCity(key, cfg);
    } catch (e) {
      console.log(`⚠️ ${key} forecast失敗(照繼續): ${e.message}`);
    }
  }
}

async function forecastRemoteCity(key, cfg) {
  const today = cityLocalDate(cfg.tz);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}` +
    `&daily=temperature_2m_max&timezone=${encodeURIComponent(cfg.tz)}&models=${MODELS.join(",")}` +
    `&start_date=${today}&end_date=${today}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const file = logFileFor(key);
  const rows = loadLog(file);
  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }
  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) row.forecasts[m] = arr[0].toFixed(1);
  }
  saveLog(rows, file);
  console.log(`✅ ${key}(${cfg.icao}) 已記錄 ${today} 預測`);
}

// ---------- settle模式 ----------
async function runSettle() {
  const rows = loadLog();

  // ⚠️保險:GitHub cron延遲可以成80分鐘,22:15排程都可能拖過香港午夜。
  // 過咗午夜嘅話,maxmin CSV已經係「新一日至今」(得凌晨個零鐘嘅假max),
  // 尋日真max已攞唔返——寧願skip香港settle,都唔好寫錯數(2026-07-23實例)
  const hkHour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hkHour >= 12) {
    await settleHk(rows);
  } else {
    console.log(`⚠️ 延遲跨咗香港午夜(HK ${hkHour}點),maxmin CSV得新一日凌晨數據,skip香港settle`);
  }

  await settleAndWriteBias(rows);
}

async function settleHk(rows) {
  const today = hkToday();
  const res = await fetch(MAXMIN_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`maxmin CSV ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);

  let realized = null;
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (STATION_PATTERN.test(parts[1])) { realized = parseFloat(parts[2]); break; }
  }
  if (realized === null || Number.isNaN(realized)) throw new Error("攞唔到今日實測最高溫");

  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }
  row.realized = realized.toFixed(1);
  saveLog(rows);
  console.log(`✅ 已記錄 ${today} 實測最高溫: ${realized.toFixed(1)}°C`);
}

// 遠程城市settle+寫bias.json——就算香港嗰part被skip都照做
// (遠程城市結算「當地昨日」用METAR 48hr報文,延遲跨午夜都攞得返正確數據)
async function settleAndWriteBias(rows) {
  // ---- 遠程城市:結算當地「昨日」+計bias ----
  // 讀返舊bias.json,邊個城市今次fail就保留佢上次嘅值
  let oldBias = {};
  try { oldBias = JSON.parse(fs.readFileSync(BIAS_FILE, "utf-8")); } catch { /* 冇就算 */ }
  const cities = { ...(oldBias.cities || {}) };
  for (const [key, cfg] of Object.entries(REMOTE_CITIES)) {
    try {
      cities[key] = await settleRemoteCity(key, cfg);
    } catch (e) {
      console.log(`⚠️ ${key} settle失敗(保留舊bias): ${e.message}`);
    }
  }

  // ---- 重新計算香港bias ----
  const hk = computeBias(rows);

  const output = {
    generatedAt: new Date().toISOString(),
    sampleDays: hk.sampleDays,
    note: "bias = mean(實測 - 模型預測)，正數代表模型低估。由daily_log.js自動產生。max=香港(HKO總部);cities=遠程城市(結算口徑=機場METAR整數)。",
    max: hk.max,
    min: {}, // 暫時只做max（Polymarket香港市場以最高溫為主）
    cities,
  };
  fs.writeFileSync(BIAS_FILE, JSON.stringify(output, null, 2));

  if (Object.keys(hk.max).length === 0) {
    console.log(`ℹ️ 香港數據仲未夠${MIN_SAMPLES}日，bias暫時空（而家有${hk.sampleDays}日）。繼續累積。`);
  } else {
    console.log("✅ bias.json已更新(香港):");
    Object.entries(hk.max).forEach(([m, b]) => console.log(`  ${m.padEnd(18)}: ${b >= 0 ? "+" : ""}${b}°C`));
  }
  for (const [key, c] of Object.entries(cities)) {
    const n = Object.keys(c.max || {}).length;
    console.log(`  ${key}: ${c.sampleDays}日數據${n ? `,${n}個模型有bias` : `(未夠${MIN_SAMPLES}日,未出bias)`}`);
  }
}

// 結算一個遠程城市當地「昨日」嘅METAR最高溫,回傳最新bias
async function settleRemoteCity(key, cfg) {
  const target = cityLocalDate(cfg.tz, new Date(Date.now() - 24 * 3600 * 1000));
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${cfg.icao}&format=json&hours=48`);
  if (!res.ok) throw new Error(`METAR API ${res.status}`);
  const arr = await res.json();

  let maxT = null;
  for (const m of Array.isArray(arr) ? arr : []) {
    if (typeof m.temp !== "number") continue;
    const iso = metarTimeIso(m);
    if (!iso || cityLocalDate(cfg.tz, new Date(iso)) !== target) continue;
    if (maxT === null || m.temp > maxT) maxT = m.temp;
  }
  if (maxT === null) throw new Error(`搵唔到${target}嘅${cfg.icao} METAR`);

  const file = logFileFor(key);
  const rows = loadLog(file);
  let row = rows.find((r) => r.date === target);
  if (!row) { row = { date: target, forecasts: {}, realized: "" }; rows.push(row); }
  row.realized = String(maxT);
  saveLog(rows, file);
  console.log(`✅ ${key}(${cfg.icao}) 已結算 ${target} 實測最高: ${maxT}°C`);

  return computeBias(rows);
}

async function main() {
  const { mode } = parseArgs();
  if (mode === "forecast") await runForecast();
  else if (mode === "settle") await runSettle();
  else throw new Error("要指定 --mode=forecast 或 --mode=settle");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
