/**
 * rounding_probe.js
 * ------------------------------------------------------------
 * 查「rhrread(整數) 究竟係咪 = round(1分鐘CSV嘅0.1°值)」嘅例外個案。
 *
 * 點解重要:worker.js嘅「快水喉搶先破關」訊號完全建基於呢個假設。
 *   四捨五入 → 讀到26即真值∈[25.5,26.5) → 26.0關口得約一半機會破
 *   截去小數 → 讀到26即真值∈[26.0,27.0) → 26.0關口實破
 * 兩者對落注嘅意思差天共地。
 *
 * 你之前跑過200樣本:179吻合、21個例外。呢個script專查嗰21個係乜。
 *
 * 最大嫌疑:兩條水喉觀測時間唔同(rhrread整點~04分出,CSV~08分),
 * 所以要同「CSV喺rhrread嗰個時間點嘅讀數」比,唔係同「CSV最新值」比。
 *
 * 用法:
 *   node rounding_probe.js              # 收集一個樣本
 *   node rounding_probe.js --watch=60   # 每分鐘收集一次,收60分鐘
 * 輸出:rounding_probe.csv(自己append)+ 即時分析
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const LIVE_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv";
const RHRREAD_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc";
const STATION = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const OUT = path.join(__dirname, "rounding_probe.csv");
const HEADER = "sampledAt,csvTime,csvValue,rhrTime,rhrValue,roundMatch,truncMatch,gapMin,decimal";

function parseTs(ts) {
  return `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:00+08:00`;
}

async function fetchCsv() {
  const res = await fetch(LIVE_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV ${res.status}`);
  for (const line of (await res.text()).trim().split(/\r?\n/).slice(1)) {
    const [ts, place, v] = line.split(",").map((s) => s.trim());
    if (STATION.test(place)) return { time: parseTs(ts), value: parseFloat(v) };
  }
  return null;
}

async function fetchRhr() {
  const res = await fetch(RHRREAD_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`rhrread ${res.status}`);
  const j = await res.json();
  const hko = (j.temperature?.data ?? []).find((t) => t.place === "香港天文台");
  return hko ? { time: j.temperature?.recordTime ?? null, value: hko.value } : null;
}

async function sample() {
  const [csv, rhr] = await Promise.all([fetchCsv(), fetchRhr()]);
  if (!csv || !rhr) throw new Error("其中一條水喉攞唔到");

  const gapMin = csv.time && rhr.time
    ? Math.round((new Date(csv.time) - new Date(rhr.time)) / 60000) : null;
  const decimal = Math.round((csv.value - Math.floor(csv.value)) * 10) / 10;
  const row = {
    sampledAt: new Date().toISOString(),
    csvTime: csv.time, csvValue: csv.value,
    rhrTime: rhr.time, rhrValue: rhr.value,
    roundMatch: Math.round(csv.value) === rhr.value ? 1 : 0,
    truncMatch: Math.floor(csv.value) === rhr.value ? 1 : 0,
    gapMin, decimal,
  };

  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEADER + "\n");
  fs.appendFileSync(OUT, Object.values(row).join(",") + "\n");

  const mark = row.roundMatch ? "✓四捨五入" : row.truncMatch ? "⚠只符合截去小數" : "❌兩種都唔符";
  console.log(`${row.sampledAt.slice(11,19)} CSV ${csv.value}°(${csv.time?.slice(11,16)}) vs rhrread ${rhr.value}°(${rhr.time?.slice(11,16)}) 相差${gapMin}分鐘 → ${mark}`);
  return row;
}

function analyse() {
  if (!fs.existsSync(OUT)) return;
  const rows = fs.readFileSync(OUT, "utf-8").trim().split(/\r?\n/).slice(1)
    .map((l) => { const c = l.split(","); return { roundMatch: c[5]==="1", truncMatch: c[6]==="1", gapMin: parseInt(c[7],10), decimal: parseFloat(c[8]) }; });
  if (rows.length < 5) return;

  const round = rows.filter((r) => r.roundMatch).length;
  const trunc = rows.filter((r) => r.truncMatch).length;
  console.log(`\n📊 ${rows.length}個樣本: 四捨五入吻合 ${round} (${(round/rows.length*100).toFixed(0)}%) | 截去小數吻合 ${trunc} (${(trunc/rows.length*100).toFixed(0)}%)`);

  const bad = rows.filter((r) => !r.roundMatch);
  if (!bad.length) { console.log("✅ 冇例外——四捨五入假設成立"); return; }

  // 例外集中喺邊?小數位near .5 = 時間差問題;平均分佈 = 根本另一個量度
  const nearHalf = bad.filter((r) => Math.abs(r.decimal - 0.5) <= 0.1).length;
  const bigGap = bad.filter((r) => Math.abs(r.gapMin) >= 5).length;
  console.log(`\n⚠️ ${bad.length}個例外:`);
  console.log(`   小數位喺.4-.6之間(邊界): ${nearHalf}/${bad.length}`);
  console.log(`   兩條水喉相差>=5分鐘: ${bigGap}/${bad.length}`);
  console.log(bad.length && nearHalf / bad.length >= 0.5
    ? "   → 判斷:例外集中喺捨入邊界,即係時間差搞出嚟(兩邊唔同觀測時刻),四捨五入規則本身冇問題"
    : bigGap / bad.length >= 0.5
      ? "   → 判斷:例外集中喺時間差大嘅樣本,同上——時間差問題"
      : "   → 判斷:例外散開晒,rhrread可能根本唔係CSV嘅捨入(另一個感測器/平均窗)。呢個要小心,快水喉訊號要重新評估");
}

async function main() {
  const watchArg = process.argv.find((a) => a.startsWith("--watch="));
  const minutes = watchArg ? parseInt(watchArg.split("=")[1], 10) : 0;

  await sample().catch((e) => console.error("❌", e.message));
  if (minutes > 0) {
    console.log(`(每分鐘收一次,收${minutes}分鐘…)`);
    for (let i = 1; i < minutes; i++) {
      await new Promise((r) => setTimeout(r, 60000));
      await sample().catch((e) => console.error("❌", e.message));
    }
  }
  analyse();
}

main();
