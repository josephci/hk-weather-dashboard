/**
 * spread_probe.js
 * ------------------------------------------------------------
 * 量度兩個地點嘅每日最高溫實際差幾多——用歷史數據答,唔靠估。
 *
 * 由來:深圳同香港只係相隔~27km,但Polymarket兩邊定價唔同。
 * 究竟係(a)兩地溫度真係唔同,定係(b)結算源唔同造成?
 * 呢個script答(a)嗰半:兩個座標嘅實際溫度差嘅分佈。
 *
 * ⚠️(b)嗰半要你自己去market描述度確認結算站——呢個script答唔到,
 * 而且係最容易蝕錢嘅位(倫敦嗰次用錯Heathrow就係例子)。
 *
 * 用法:
 *   node spread_probe.js                    # 預設HK vs 深圳,過去60日
 *   node spread_probe.js --days=90
 *   node spread_probe.js --b=shenzhen-airport
 *
 * 讀法:
 *   平均差 = 系統性偏差(可以直接搬去對方嘅模型預測度)
 *   標準差 = 每日波動,細=兩地郁得好貼(價差有得捉),大=各有各行
 * ------------------------------------------------------------
 */

const PLACES = {
  "hk":                { name: "香港天文台總部",       lat: 22.302,  lon: 114.174,  tz: "Asia/Hong_Kong" },
  "shenzhen":          { name: "深圳市中心(福田)",     lat: 22.5431, lon: 114.0579, tz: "Asia/Shanghai" },
  "shenzhen-airport":  { name: "深圳寶安機場(ZGSZ)",   lat: 22.639,  lon: 113.811,  tz: "Asia/Shanghai" },
  "hk-airport":        { name: "香港赤鱲角(VHHH)",     lat: 22.309,  lon: 113.915,  tz: "Asia/Hong_Kong" },
  "guangzhou":         { name: "廣州",                 lat: 23.1291, lon: 113.2644, tz: "Asia/Shanghai" },
};

function parseArgs() {
  const a = Object.fromEntries(process.argv.slice(2).map((x) => {
    const [k, v] = x.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }));
  return { days: parseInt(a.days ?? "60", 10), a: a.a ?? "hk", b: a.b ?? "shenzhen" };
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// ERA5 reanalysis存檔:兩個座標用同一套模型同化,係最公平嘅apples-to-apples比較
async function fetchDailyMax(place, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${place.lat}&longitude=${place.lon}` +
    `&start_date=${start}&end_date=${end}&daily=temperature_2m_max&timezone=${encodeURIComponent(place.tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Archive API ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = await res.json();
  const out = {};
  (j.daily?.time ?? []).forEach((d, i) => {
    const v = j.daily.temperature_2m_max?.[i];
    if (v != null) out[d] = v;
  });
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

async function main() {
  const { days, a, b } = parseArgs();
  const A = PLACES[a], B = PLACES[b];
  if (!A || !B) {
    console.error(`地點要係: ${Object.keys(PLACES).join(" / ")}`);
    process.exit(1);
  }

  // ERA5存檔通常落後5日左右
  const end = new Date(Date.now() - 6 * 86400e3);
  const start = new Date(end.getTime() - days * 86400e3);
  console.log(`📏 ${A.name} vs ${B.name}`);
  console.log(`   ${ymd(start)} → ${ymd(end)}\n`);

  const [ma, mb] = await Promise.all([
    fetchDailyMax(A, ymd(start), ymd(end)),
    fetchDailyMax(B, ymd(start), ymd(end)),
  ]);

  const diffs = [];
  for (const d of Object.keys(ma)) {
    if (mb[d] != null) diffs.push({ date: d, a: ma[d], b: mb[d], diff: mb[d] - ma[d] });
  }
  if (diffs.length < 10) { console.log("數據太少,無法分析"); return; }

  const vals = diffs.map((x) => x.diff).sort((x, y) => x - y);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1));
  const hotter = diffs.filter((x) => x.diff > 0).length;
  const sameBucket = diffs.filter((x) => Math.floor(x.a) === Math.floor(x.b)).length;

  console.log(`📊 ${diffs.length}日數據 · 差值 = ${B.name} 減 ${A.name}`);
  console.log(`   平均差   : ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}°C  ← 系統性偏差`);
  console.log(`   標準差   : ${std.toFixed(2)}°C  ← 每日波動`);
  console.log(`   ${B.name}較熱: ${hotter}/${diffs.length}日 (${(hotter/diffs.length*100).toFixed(0)}%)`);
  console.log(`   分位數   : p10 ${quantile(vals,0.1).toFixed(1)} | p50 ${quantile(vals,0.5).toFixed(1)} | p90 ${quantile(vals,0.9).toFixed(1)}`);
  console.log(`   同一個整數bucket: ${sameBucket}/${diffs.length}日 (${(sameBucket/diffs.length*100).toFixed(0)}%)`);

  console.log(`\n💡 點解讀:`);
  if (Math.abs(mean) >= 0.8) {
    console.log(`   平均差${mean.toFixed(1)}°夠大——兩邊market定價唔同係合理嘅,唔係執到平嘢。`);
    console.log(`   想借用一邊嘅模型去另一邊,要先減返呢個offset。`);
  } else {
    console.log(`   平均差細(${mean.toFixed(1)}°),兩地溫度水平接近。`);
  }
  if (std >= 1.2) {
    console.log(`   但標準差${std.toFixed(1)}°偏大:唔係日日跟得咁貼,某日差3-4度好平常,`);
    console.log(`   所以「香港咁熱深圳實一樣」呢個直覺唔可靠。`);
  } else {
    console.log(`   標準差細(${std.toFixed(1)}°),兩地郁得幾貼,價差有得捉。`);
  }
  console.log(`   得${(sameBucket/diffs.length*100).toFixed(0)}%日子落喺同一個整數bucket → 即使溫度相近,`);
  console.log(`   結算bucket都經常唔同,兩邊market本質上係兩注唔同嘅嘢。`);

  console.log(`\n⚠️ 呢個script答唔到嘅嘢:兩邊market嘅結算站係邊個。`);
  console.log(`   香港=天文台總部(市區,0.1°);深圳=?(市區站定寶安機場METAR整數?)`);
  console.log(`   落注前一定要開market描述對清楚——倫敦嗰次用錯Heathrow就係教訓。`);

  const extreme = diffs.slice().sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 5);
  console.log(`\n   差得最犀利嘅5日:`);
  for (const e of extreme) {
    console.log(`     ${e.date}: ${A.name.slice(0,4)} ${e.a.toFixed(1)}° vs ${B.name.slice(0,4)} ${e.b.toFixed(1)}° = ${e.diff >= 0 ? "+" : ""}${e.diff.toFixed(1)}°`);
  }
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
