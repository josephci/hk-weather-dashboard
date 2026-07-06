/**
 * backfill_bias.js
 * ------------------------------------------------------------
 * 用途：一次過回填過去N日嘅「模型預報 vs 實測最高溫」數據，
 *       即刻產生有統計意義嘅 bias.json，唔使等7日冷啟動。
 *
 * 數據來源（兩邊都係已驗證嘅公開API）：
 *   實測：HKO氣候API CLMMAXT（天文台總部每日最高溫官方紀錄，有小數位）
 *   預報：Open-Meteo Historical Forecast API（各模型當日發佈嘅歷史預報存檔）
 *
 * 用法（本機或GitHub Actions都得，跑一次就夠）：
 *   node backfill_bias.js
 *   node backfill_bias.js --days=90
 *
 * 產出：
 *   forecast_log.csv  （會合併，唔會覆蓋已有記錄）
 *   bias.json         （即刻生效，daily_log.js之後會持續更新佢）
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const FORECAST_LOG = path.join(__dirname, "forecast_log.csv");
const BIAS_FILE = path.join(__dirname, "bias.json");

const LAT = 22.302, LON = 114.174;
const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const MIN_SAMPLES = 7;

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v];
    })
  );
  return { days: parseInt(args.days ?? "60", 10) };
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// ---------- 實測：HKO CLMTEMP氣候API（官方每日最高溫，小數1位） ----------
async function fetchRealizedMap(years) {
  const map = {}; // "YYYY-MM-DD" -> maxTemp
  for (const year of years) {
    const url = `https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=CLMMAXT&rformat=json&station=HKO&year=${year}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`⚠️ CLMMAXT ${year}: HTTP ${res.status}`); continue; }
    const json = await res.json();
    // 回應格式: { fields: [...], data: [[year, month, day, value, completeness], ...] }
    for (const row of json.data ?? []) {
      const [y, m, d, v] = row;
      const val = parseFloat(v);
      if (!y || !m || !d || Number.isNaN(val)) continue;
      map[`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`] = val;
    }
  }
  return map;
}

// ---------- 預報：Open-Meteo Historical Forecast API ----------
// 呢個API專門存檔「當日模型實際發出過嘅預報」，正正係我哋要嘅嘢。
// 佢同一般forecast API結構一樣，只係endpoint唔同。
async function fetchHistoricalForecasts(startDate, endDate) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max&timezone=Asia%2FHong_Kong&models=${MODELS.join(",")}` +
    `&start_date=${startDate}&end_date=${endDate}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Historical Forecast API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();

  const dates = data.daily?.time ?? [];
  const result = {}; // "YYYY-MM-DD" -> { model: value }
  for (const model of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${model}`];
    if (!arr) { console.warn(`⚠️ 冇 ${model} 嘅歷史預報欄位`); continue; }
    dates.forEach((date, i) => {
      if (arr[i] != null) {
        if (!result[date]) result[date] = {};
        result[date][model] = arr[i];
      }
    });
  }
  return result;
}

// ---------- forecast_log.csv 合併 ----------
const HEADER = "date," + MODELS.join(",") + ",realized";

function loadLog() {
  if (!fs.existsSync(FORECAST_LOG)) return [];
  const lines = fs.readFileSync(FORECAST_LOG, "utf-8").trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    const parts = line.split(",");
    const row = { date: parts[0], forecasts: {}, realized: parts[MODELS.length + 1] || "" };
    MODELS.forEach((m, i) => { row.forecasts[m] = parts[i + 1] || ""; });
    return row;
  });
}

function saveLog(rows) {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const lines = [HEADER];
  for (const r of rows) {
    lines.push([r.date, ...MODELS.map((m) => r.forecasts[m] ?? ""), r.realized ?? ""].join(","));
  }
  fs.writeFileSync(FORECAST_LOG, lines.join("\n") + "\n");
}

// ---------- 主程式 ----------
async function main() {
  const { days } = parseArgs();
  const end = new Date(Date.now() - 24 * 3600 * 1000); // 至昨日
  const start = new Date(end.getTime() - (days - 1) * 24 * 3600 * 1000);
  const startDate = ymd(start), endDate = ymd(end);
  const years = [...new Set([start.getFullYear(), end.getFullYear()])];

  console.log(`\n📥 回填 ${startDate} 至 ${endDate}（${days}日）...\n`);

  const [realizedMap, forecastMap] = await Promise.all([
    fetchRealizedMap(years),
    fetchHistoricalForecasts(startDate, endDate),
  ]);

  console.log(`實測數據: ${Object.keys(realizedMap).length}日  |  歷史預報: ${Object.keys(forecastMap).length}日`);

  // 合併入forecast_log（已有嘅日子唔覆蓋，保留daily_log.js記錄嘅「當日07:15版本」，嗰個更真實）
  const rows = loadLog();
  const existing = new Set(rows.map((r) => r.date));
  let added = 0;

  for (const [date, forecasts] of Object.entries(forecastMap)) {
    if (existing.has(date)) continue;
    const realized = realizedMap[date];
    if (realized === undefined) continue;
    const row = { date, forecasts: {}, realized: realized.toFixed(1) };
    for (const m of MODELS) {
      if (forecasts[m] !== undefined) row.forecasts[m] = forecasts[m].toFixed(1);
    }
    rows.push(row);
    added++;
  }
  saveLog(rows);
  console.log(`✅ forecast_log.csv: 新增${added}日（合共${rows.length}日）`);

  // 計bias
  const complete = rows.filter((r) => r.realized !== "");
  const biasMax = {};
  console.log(`\n── Bias結果（正數=模型低估） ──`);
  for (const m of MODELS) {
    const diffs = complete
      .filter((r) => r.forecasts[m] !== "" && r.forecasts[m] !== undefined)
      .map((r) => parseFloat(r.realized) - parseFloat(r.forecasts[m]))
      .filter((d) => !Number.isNaN(d));
    if (diffs.length >= MIN_SAMPLES) {
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(diffs.length - 1, 1));
      biasMax[m] = Math.round(mean * 100) / 100;
      console.log(`  ${m.padEnd(18)}: ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}°C  (n=${diffs.length}, 誤差sd=${sd.toFixed(2)})`);
    } else {
      console.log(`  ${m.padEnd(18)}: 樣本不足 (n=${diffs.length})`);
    }
  }

  fs.writeFileSync(BIAS_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sampleDays: complete.length,
    source: "backfill (HKO CLMMAXT + Open-Meteo Historical Forecast)",
    note: "bias = mean(實測 - 模型預測)，正數代表模型低估。daily_log.js之後會持續更新。",
    max: biasMax,
    min: {},
  }, null, 2));
  console.log(`\n✅ bias.json 已產生（${Object.keys(biasMax).length}個模型有效）`);

  if (Object.keys(biasMax).length === 0) {
    console.log("\n⚠️ 冇任何模型計到bias——多數係Historical Forecast API欄位名同預期唔同。請將上面嘅warning貼返俾Claude debug。");
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
