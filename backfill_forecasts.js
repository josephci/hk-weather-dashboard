/**
 * backfill_forecasts.js
 * ------------------------------------------------------------
 * 補返「有實測但冇模型預測」嘅行。
 *
 * 點解需要:2026-07-16至08-01期間,daily-bias個朝班俾GitHub cron延遲
 * 搞到錯行settle(見README),結果實測日日照記,模型預測一格都冇。
 * 啲行就噉爛喺度,bias永遠計唔出。
 *
 * 做法:Open-Meteo Historical Forecast API存檔咗「當日各模型實際發出
 * 過嘅預報」,直接攞返填入去,唔使由零等7日冷啟動。
 *
 * 用法:
 *   node backfill_forecasts.js            # 補香港+4個城市
 *   node backfill_forecasts.js --dry-run  # 淨睇會改乜,唔寫檔
 *
 * 只會填空格,唔會覆蓋已有數據。
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const MIN_SAMPLES = 7;
const BIAS_FILE = path.join(__dirname, "bias.json");
const HEADER = "date," + MODELS.join(",") + ",realized";

// 同daily_log.js一致(結算站座標)
const TARGETS = {
  _hk:      { file: "forecast_log.csv",          lat: 22.302,  lon: 114.174,  tz: "Asia/Hong_Kong", decimals: 1 },
  shanghai: { file: "forecast_log_shanghai.csv", lat: 31.143,  lon: 121.805,  tz: "Asia/Shanghai",  decimals: 1 },
  beijing:  { file: "forecast_log_beijing.csv",  lat: 40.080,  lon: 116.585,  tz: "Asia/Shanghai",  decimals: 1 },
  london:   { file: "forecast_log_london.csv",   lat: 51.505,  lon: 0.055,    tz: "Europe/London",  decimals: 1 },
  paris:    { file: "forecast_log_paris.csv",    lat: 48.9694, lon: 2.4414,   tz: "Europe/Paris",   decimals: 1 },
};

function hasVal(v) { return v !== undefined && v !== null && v !== ""; }

function loadLog(file) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8").trim().split(/\r?\n/).slice(1).map((line) => {
    const parts = line.split(",");
    const row = { date: parts[0], forecasts: {}, realized: parts[MODELS.length + 1] || "" };
    MODELS.forEach((m, i) => { row.forecasts[m] = parts[i + 1] || ""; });
    return row;
  });
}

function saveLog(file, rows) {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const lines = [HEADER, ...rows.map((r) => [r.date, ...MODELS.map((m) => r.forecasts[m] ?? ""), r.realized ?? ""].join(","))];
  fs.writeFileSync(path.join(__dirname, file), lines.join("\n") + "\n");
}

async function fetchHistoricalForecasts(cfg, startDate, endDate) {
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}` +
    `&daily=temperature_2m_max&timezone=${encodeURIComponent(cfg.tz)}&models=${MODELS.join(",")}` +
    `&start_date=${startDate}&end_date=${endDate}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Historical Forecast API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const dates = data.daily?.time ?? [];
  const out = {};
  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (!arr) continue;
    dates.forEach((d, i) => {
      if (arr[i] != null) (out[d] ||= {})[m] = arr[i];
    });
  }
  return out;
}

function computeBias(rows) {
  const complete = rows.filter((r) => hasVal(r.realized) && MODELS.some((m) => hasVal(r.forecasts[m])));
  const max = {};
  for (const m of MODELS) {
    const diffs = complete
      .filter((r) => hasVal(r.forecasts[m]))
      .map((r) => parseFloat(r.realized) - parseFloat(r.forecasts[m]))
      .filter((d) => !Number.isNaN(d));
    if (diffs.length >= MIN_SAMPLES) {
      max[m] = Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 100) / 100;
    }
  }
  return { sampleDays: complete.length, max };
}

async function backfillOne(key, cfg, dryRun) {
  const rows = loadLog(cfg.file);
  if (!rows) { console.log(`  ${key}: 冇 ${cfg.file},跳過`); return null; }

  const gaps = rows.filter((r) => hasVal(r.realized) && !MODELS.some((m) => hasVal(r.forecasts[m])));
  if (!gaps.length) {
    console.log(`  ${key}: 冇空格要補 (${rows.length}行)`);
    return computeBias(rows);
  }

  const dates = gaps.map((r) => r.date).sort();
  const start = dates[0], end = dates[dates.length - 1];
  console.log(`  ${key}: ${gaps.length}行等緊補 (${start} → ${end})`);

  const hist = await fetchHistoricalForecasts(cfg, start, end);
  let filled = 0;
  for (const r of gaps) {
    const h = hist[r.date];
    if (!h) continue;
    let any = false;
    for (const m of MODELS) {
      if (h[m] != null) { r.forecasts[m] = h[m].toFixed(cfg.decimals); any = true; }
    }
    if (any) filled++;
  }
  console.log(`    → 補到 ${filled}/${gaps.length} 行`);
  if (!dryRun) saveLog(cfg.file, rows);
  return computeBias(rows);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`🔧 補回模型預測${dryRun ? "（dry-run,唔會寫檔）" : ""}\n`);

  const results = {};
  for (const [key, cfg] of Object.entries(TARGETS)) {
    try {
      results[key] = await backfillOne(key, cfg, dryRun);
    } catch (e) {
      console.log(`  ${key}: ❌ ${e.message}`);
    }
  }

  // 重寫bias.json(保留原結構)
  let bias = {};
  try { bias = JSON.parse(fs.readFileSync(BIAS_FILE, "utf-8")); } catch { /* 冇就新建 */ }
  const cities = { ...(bias.cities || {}) };
  for (const [key, r] of Object.entries(results)) {
    if (!r) continue;
    if (key === "_hk") { bias.max = r.max; bias.sampleDays = r.sampleDays; }
    else cities[key] = r;
  }
  bias.cities = cities;
  bias.min = bias.min || {};
  bias.generatedAt = new Date().toISOString();
  bias.note = "bias = mean(實測 - 模型預測)，正數代表模型低估。max=香港(HKO總部);cities=遠程城市(結算口徑=機場METAR整數)。";

  console.log("\n📊 結果:");
  console.log(`  香港: ${bias.sampleDays}日, ${Object.keys(bias.max || {}).length}個模型有bias`);
  for (const [k, v] of Object.entries(cities)) {
    const n = Object.keys(v.max || {}).length;
    console.log(`  ${k}: ${v.sampleDays}日${n ? `, ${n}個模型有bias ✓` : `(未夠${MIN_SAMPLES}日)`}`);
  }

  if (!dryRun) {
    fs.writeFileSync(BIAS_FILE, JSON.stringify(bias, null, 2));
    console.log("\n✅ bias.json已更新");
  } else {
    console.log("\n(dry-run,乜都冇寫)");
  }
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
