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
// ⚠️2026-09-10加:dashboard個⚡而家用緊嘅係呢條(9月8日換嘅),唔係rhrread。
// 200樣本嗰個「四捨五入」結論係喺rhrread度驗嘅,呢條**從來冇驗過**。
const WEB_URL = "https://www.hko.gov.hk/json/DYN_DAT_MINDS_RHRREAD.json";
const STATION = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const OUT = path.join(__dirname, "rounding_probe.csv");
const HEADER = "sampledAt,csvTime,csvValue,rhrTime,rhrValue,roundMatch,truncMatch,gapMin,decimal,webTime,webValue";

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

// 天文台網站自己個JSON(dashboard個⚡用緊嗰條)。BulletinTime係裸HHMM。
async function fetchWeb() {
  const res = await fetch(WEB_URL, { cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.hko.gov.hk/" } });
  if (!res.ok) throw new Error(`網站JSON ${res.status}`);
  const root = (await res.json())?.DYN_DAT_MINDS_RHRREAD || {};
  const key = Object.keys(root).find((k) => /observatory|HKO/i.test(k) && /temp/i.test(k));
  if (!key) return null;
  const v = parseFloat(root[key]?.Val_Eng ?? root[key]);
  const t = String(root.BulletinTime?.Val_Eng ?? root.BulletinTime ?? "").trim();
  return Number.isNaN(v) ? null : { time: /^\d{3,4}$/.test(t) ? t.padStart(4, "0") : null, value: v };
}

async function sample() {
  const [csv, rhr, web] = await Promise.all([fetchCsv(), fetchRhr(), fetchWeb().catch(() => null)]);
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
    webTime: web?.time ?? "", webValue: web?.value ?? "",
  };

  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEADER + "\n");
  fs.appendFileSync(OUT, Object.values(row).join(",") + "\n");

  const mark = row.roundMatch ? "✓四捨五入" : row.truncMatch ? "⚠只符合截去小數" : "❌兩種都唔符";
  const webMark = web ? ` | ⚡網站 ${web.value}°(${web.time ?? "?"})` : " | ⚡網站攞唔到";
  console.log(`${row.sampledAt.slice(11,19)} CSV ${csv.value}°(${csv.time?.slice(11,16)}) vs rhrread ${rhr.value}°(${rhr.time?.slice(11,16)}) 相差${gapMin}分鐘 → ${mark}${webMark}`);
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

// ⚠️2026-09-10:呢度先係今次真正嘅教訓。
// 舊個analyse()淨係數「吻合率」,而200樣本89%吻合就當四捨五入成立。
// 但攞market_race真log重跑先發現:溫度平嗰陣,**遲十幾分鐘個讀數
// round出嚟都係同一個整數**——即係嗰啲樣本根本分辨唔到任何嘢,
// 佢哋只係喺度谷高個吻合率。真正有分辨力嘅只有溫度郁緊嗰啲。
//
// 所以呢個analyse要做兩樣舊嗰個做唔到嘅:
//   ① 只計「有分辨力」嘅樣本(唔同觀測時刻round出嚟唔同整數)
//   ② 分開「捨入規則」同「觀測滯後」——如果⚡個值一路對得上
//      十幾分鐘前嘅CSV,咁佢就唔係快,個「快CSV 7分鐘」講法就唔成立
function analyseWeb() {
  if (!fs.existsSync(OUT)) return;
  const rows = fs.readFileSync(OUT, "utf-8").trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(","))
    .filter((c) => c[9] && c[10] !== "" && c[1]);
  if (rows.length < 3) { console.log("\n⚡網站JSON:樣本未夠(要3個以上,而家" + rows.length + "個)"); return; }

  // CSV小數序列:HHMM → 值
  const csvSeries = new Map();
  for (const c of rows) csvSeries.set(String(c[1]).slice(8, 12), parseFloat(c[2]));
  const mm = (s) => +String(s).slice(0, 2) * 60 + +String(s).slice(2, 4);
  const nearest = (targetMin) => {
    let best = null;
    for (const [k, v] of csvSeries) {
      const d = Math.abs(mm(k) - targetMin);
      if (!best || d < best.d) best = { k, v, d };
    }
    return best;
  };

  // 逐個唔同嘅bulletin睇一次
  const bulletins = new Map();
  for (const c of rows) if (!bulletins.has(c[9])) bulletins.set(c[9], parseFloat(c[10]));

  const LAGS = [0, 5, 10, 15, 20];
  console.log(`\n⚡ 天文台網站JSON(dashboard個⚡用緊嗰條) — ${bulletins.size}個bulletin`);
  console.log("bulletin ⚡值  " + LAGS.map((l) => `${l}分前`).join(" ") + "   有冇分辨力");
  const lagHits = LAGS.map(() => 0);
  let discriminating = 0, lag0Hit = 0, truncHit = 0;
  for (const [bt, wv] of bulletins) {
    const marks = LAGS.map((lag, i) => {
      const n = nearest(mm(bt) - lag);
      if (!n || n.d > 12) return " ? ";
      const ok = Math.round(n.v) === wv;
      if (ok) lagHits[i]++;
      return ok ? " ✓ " : " ✗ ";
    });
    // 有分辨力 = 唔同lag唔係全部一樣(即係呢個樣本真係分得開)
    const real = marks.filter((m) => m !== " ? ");
    const power = new Set(real).size > 1;
    if (power) discriminating++;
    const n0 = nearest(mm(bt));
    if (n0 && n0.d <= 12) {
      if (Math.round(n0.v) === wv) lag0Hit++;
      if (Math.floor(n0.v) === wv && Math.round(n0.v) !== wv) truncHit++;
    }
    console.log(`  ${bt}   ${wv}   ${marks.join("  ")}    ${power ? "✓有" : "✗冇(溫度平)"}`);
  }
  console.log(`\n有分辨力嘅樣本: ${discriminating}/${bulletins.size}`);
  // ⚠️門檻要夠高:呢個係落真錢嘅輸入。用3個樣本落結論就係重蹈
  // 「200樣本89%吻合」嗰個覆轍——嗰200個入面真正分得開嘅可能得幾個。
  if (discriminating < 8) {
    console.log(`⚠️ 分得開嘅樣本得${discriminating}個(要8個先講得),呢個run講唔到結論。`);
    console.log("   要揀溫度郁得快嗰段時間再跑(下晝升溫/傍晚回落),平嗰陣幾多樣本都冇用。");
    return;
  }
  console.log("同「當刻」CSV比:  round吻合 " + lag0Hit + " · 只符合截去小數 " + truncHit);
  console.log("各lag吻合次數:   " + LAGS.map((l, i) => `${l}分前=${lagHits[i]}`).join("  "));
  const bestLag = LAGS[lagHits.indexOf(Math.max(...lagHits))];
  const margin = Math.max(...lagHits) - (lagHits.slice().sort((a, b) => b - a)[1] ?? 0);
  if (margin <= 1) {
    console.log(`→ ⚠️各個lag拉唔開(最高同第二高只差${margin}次),分唔到係邊個。唔好落結論,跑耐啲。`);
    return;
  }
  console.log(bestLag === 0
    ? `→ ⚡個讀數就係當刻嘅,而且係四捨五入(${discriminating}個有分辨力樣本)。`
    : `→ ⚠️⚡個讀數最對得上 ${bestLag} 分鐘前嘅CSV。即係佢個BulletinTime新,但入面個數舊。\n` +
      `   噉「⚡快CSV 7分鐘」呢個講法唔成立,個edge窗口要重新量過。`);
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
  analyseWeb();
}

main();
