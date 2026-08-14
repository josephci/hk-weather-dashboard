/**
 * station_wedge.js
 * ------------------------------------------------------------
 * 量度「赤鱲角VHHH」同「天文台總部HKO」嘅每日最高溫差距。
 *
 * 點解重要:
 *   香港Polymarket結算源 = HKO總部(尖沙咀市區)
 *   但最快嘅公開數據 = VHHH METAR(機場,快6-16分鐘)
 *   如果市場跟住VHHH郁,而結算跟HKO,兩者之間就有個系統性楔子。
 *
 * 呢個楔子代表兩件事:
 *   ⚠️ 陷阱 — VHHH過咗關但HKO冇 → 市場以為鎖咗,其實冇。
 *      跟住市場買 = 買咗個唔存在嘅鎖定。
 *   💰 機會 — HKO過咗關但VHHH冇 → 市場未反應,而你(用緊HKO)已經知。
 *      呢個係「你睇緊結算源、人哋睇緊代理」嘅結構性優勢。
 *
 * 最重要嗰個數:「VHHH過關但HKO冇」發生得幾密。
 * 呢個直接量度「跟市場走會中幾多次伏」。
 *
 * 數據:
 *   HKO — CLMMAXT官方氣候API(有歷史)
 *   VHHH — aviationweather METAR(歷史window有限,所以會由今日開始
 *          自動累積:daily_log每晚settle順手記低,入station_wedge.csv)
 *
 * 用法: node station_wedge.js [--days=60]
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const WEDGE_LOG = path.join(__dirname, "station_wedge.csv");
const WEDGE_HEADER = "date,hkoMax,vhhhMax";

function ymd(d) { return d.toISOString().slice(0, 10); }

// HKO總部官方每日最高(結算源本身)
async function fetchHkoMax(years) {
  const map = {};
  for (const year of years) {
    const res = await fetch(`https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=CLMMAXT&rformat=json&station=HKO&year=${year}`);
    if (!res.ok) { console.warn(`  ⚠️ CLMMAXT ${year}: ${res.status}`); continue; }
    for (const row of (await res.json()).data ?? []) {
      const [y, m, d, v] = row;
      const n = parseFloat(v);
      if (y && m && d && !Number.isNaN(n)) map[`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`] = n;
    }
  }
  return map;
}

// VHHH每日最高(METAR;API歷史window有限)
async function fetchVhhhMax(hours) {
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=VHHH&format=json&hours=${hours}`);
  if (!res.ok) throw new Error(`METAR ${res.status}`);
  const byDay = {};
  for (const m of (await res.json()) ?? []) {
    if (typeof m.temp !== "number") continue;
    const t = m.reportTime || m.obsTime;
    if (!t) continue;
    const s = String(t);
    const iso = /Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year:"numeric", month:"2-digit", day:"2-digit" }).format(d);
    if (byDay[day] === undefined || m.temp > byDay[day]) byDay[day] = m.temp;
  }
  return byDay;
}

function loadWedge() {
  if (!fs.existsSync(WEDGE_LOG)) return {};
  const out = {};
  for (const line of fs.readFileSync(WEDGE_LOG, "utf-8").trim().split(/\r?\n/).slice(1)) {
    const [date, hko, vhhh] = line.split(",");
    if (date) out[date] = { hko: parseFloat(hko), vhhh: parseFloat(vhhh) };
  }
  return out;
}

function saveWedge(map) {
  const lines = [WEDGE_HEADER];
  for (const d of Object.keys(map).sort()) {
    const r = map[d];
    if (Number.isNaN(r.hko) || Number.isNaN(r.vhhh)) continue;
    lines.push(`${d},${r.hko},${r.vhhh}`);
  }
  fs.writeFileSync(WEDGE_LOG, lines.join("\n") + "\n");
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

function analyse(pairs) {
  if (pairs.length < 10) {
    console.log(`\n數據得${pairs.length}日,唔夠分析(要>=10)。`);
    console.log("daily_log每晚settle會自動累積,過幾日再跑。");
    return;
  }

  const diffs = pairs.map((p) => p.vhhh - p.hko);
  const mean = diffs.reduce((a,b)=>a+b,0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a,b)=>a+(b-mean)**2,0) / (diffs.length-1));
  const sorted = [...diffs].sort((a,b)=>a-b);

  console.log(`\n${"═".repeat(56)}`);
  console.log(`📏 VHHH赤鱲角 vs HKO總部(結算源) — ${pairs.length}日`);
  console.log(`${"═".repeat(56)}`);
  console.log(`\n差距(VHHH減HKO): 平均 ${mean>=0?"+":""}${mean.toFixed(2)}°  σ ${sd.toFixed(2)}°`);
  console.log(`   p10 ${quantile(sorted,0.1).toFixed(1)} | p50 ${quantile(sorted,0.5).toFixed(1)} | p90 ${quantile(sorted,0.9).toFixed(1)}`);

  // 落唔落同一個整數bucket
  const sameBucket = pairs.filter((p) => Math.floor(p.hko) === Math.floor(p.vhhh)).length;
  console.log(`   落同一個整數bucket: ${sameBucket}/${pairs.length} (${(sameBucket/pairs.length*100).toFixed(0)}%)`);

  // ⭐ 核心指標:每個整數關口,VHHH過咗但HKO冇(反之亦然)
  console.log("\n⭐ 逐個關口:兩邊會唔會講唔同故事?");
  const lo = Math.floor(Math.min(...pairs.map(p=>Math.min(p.hko,p.vhhh))));
  const hi = Math.ceil(Math.max(...pairs.map(p=>Math.max(p.hko,p.vhhh))));
  let trapTotal = 0, oppTotal = 0, bothTotal = 0;
  for (let th = lo; th <= hi; th++) {
    const trap = pairs.filter((p) => p.vhhh >= th && p.hko < th).length;  // 市場以為過咗,實際冇
    const opp  = pairs.filter((p) => p.hko >= th && p.vhhh < th).length;  // 實際過咗,市場未知
    if (!trap && !opp) continue;
    trapTotal += trap; oppTotal += opp;
    console.log(`   ${th}°: ⚠️假鎖${trap}日  💰早知${opp}日`);
  }
  bothTotal = trapTotal + oppTotal;

  console.log("\n💡 對你嘅意思:");
  if (!bothTotal) {
    console.log("   兩個站喺呢啲關口從來冇分歧——跟邊個都一樣。");
  } else {
    console.log(`   ⚠️ 假鎖 ${trapTotal} 次:VHHH過咗關而HKO冇。`);
    console.log(`      如果市場跟VHHH郁,呢啲時候市場會將bucket推上90¢+,`);
    console.log(`      但結算(HKO)其實唔會中。跟市場買 = 買咗個唔存在嘅鎖定。`);
    console.log(`      → 你嘅系統用HKO判斷,已經避開咗呢個伏。`);
    console.log(`      → 進階玩法:呢啲時候可以反手做NO(但要確認市場真係overpriced)。`);
    console.log(`\n   💰 早知 ${oppTotal} 次:HKO過咗關而VHHH冇。`);
    console.log(`      你(睇HKO)已經知鎖咗,市場(睇VHHH)仲未反應 → 買得平。`);
    console.log(`      呢個就係「你睇結算源、人哋睇代理」嘅結構性優勢。`);
  }
  if (Math.abs(mean) > 0.5) {
    console.log(`\n   ⚠️ 平均差${mean.toFixed(1)}°唔細:VHHH${mean>0?"通常熱過":"通常凍過"}HKO。`);
    console.log(`      dashboard個「✈️赤鱲角METAR」讀數唔可以當香港實測睇。`);
  }
  console.log(`\n   ⚠️ 呢個分析假設「市場跟VHHH」——用market_race.js證實咗先好當真。`);
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--days="));
  const days = arg ? parseInt(arg.split("=")[1], 10) : 60;

  const wedge = loadWedge();
  console.log(`已累積 ${Object.keys(wedge).length} 日配對數據`);

  // 試補歷史:HKO有完整歷史,VHHH睇METAR API俾幾多
  try {
    const end = new Date(Date.now() - 86400e3);
    const years = [...new Set([ymd(end).slice(0,4), ymd(new Date(end - days*86400e3)).slice(0,4)])];
    const [hko, vhhh] = await Promise.all([
      fetchHkoMax(years),
      fetchVhhhMax(Math.min(days * 24, 720)).catch((e) => { console.log(`  METAR歷史: ${e.message}`); return {}; }),
    ]);
    let added = 0;
    for (const [d, v] of Object.entries(vhhh)) {
      if (hko[d] === undefined || wedge[d]) continue;
      wedge[d] = { hko: hko[d], vhhh: v };
      added++;
    }
    if (added) { saveWedge(wedge); console.log(`  由API補到 ${added} 日`); }
    else console.log("  API冇補到新數據(METAR歷史window有限,靠每晚累積)");
  } catch (e) {
    console.log(`  補歷史失敗: ${e.message}`);
  }

  const pairs = Object.entries(wedge)
    .map(([date, r]) => ({ date, ...r }))
    .filter((p) => Number.isFinite(p.hko) && Number.isFinite(p.vhhh));
  analyse(pairs);
}

if (require.main === module) main().catch((e) => { console.error("❌", e.message); process.exit(1); });

module.exports = { loadWedge, saveWedge, WEDGE_LOG };
