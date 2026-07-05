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
 * 累積夠7日數據就開始出bias，數據越多越準。
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

function hkToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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
  const lines = [HEADER];
  for (const r of rows) {
    lines.push([r.date, ...MODELS.map((m) => r.forecasts[m] ?? ""), r.realized ?? ""].join(","));
  }
  fs.writeFileSync(FORECAST_LOG, lines.join("\n") + "\n");
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
}

// ---------- settle模式 ----------
async function runSettle() {
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

  const rows = loadLog();
  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }
  row.realized = realized.toFixed(1);
  saveLog(rows);
  console.log(`✅ 已記錄 ${today} 實測最高溫: ${realized.toFixed(1)}°C`);

  // ---- 重新計算bias ----
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

  const output = {
    generatedAt: new Date().toISOString(),
    sampleDays: complete.length,
    note: "bias = mean(實測 - 模型預測)，正數代表模型低估。由daily_log.js自動產生。",
    max: biasMax,
    min: {}, // 暫時只做max（Polymarket香港市場以最高溫為主）
  };
  fs.writeFileSync(BIAS_FILE, JSON.stringify(output, null, 2));

  if (Object.keys(biasMax).length === 0) {
    console.log(`ℹ️ 數據仲未夠${MIN_SAMPLES}日，bias.json暫時空（而家有${complete.length}日）。繼續累積。`);
  } else {
    console.log("✅ bias.json已更新:");
    Object.entries(biasMax).forEach(([m, b]) => console.log(`  ${m.padEnd(18)}: ${b >= 0 ? "+" : ""}${b}°C`));
  }
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
