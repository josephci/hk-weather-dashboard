/**
 * market_race.js
 * ------------------------------------------------------------
 * 答一條問題:「Polymarket香港市場，係咪真係快過天文台公佈?」
 *
 * latency_race.js比較嘅係HKO內部幾條水喉邊條快;呢個再加埋市場本身,
 * 所以答到「市場郁嗰陣,邊條水喉已經知咗、邊條仲未知」。
 *
 * 每30秒同時記低:
 *   市場   — Polymarket各bucket嘅yes價
 *   csv    — HKO 1分鐘CSV(0.1°,10分鐘更新一次,遲~8分鐘出街)
 *   rhrread— HKO開放API(整數,遲~4分鐘)
 *   hkoWeb — 天文台網站內部JSON(佢自己個網頁用,可能快過開放數據)
 *   metar  — VHHH機場報文(:00同:30發,全球1-2分鐘內到)
 *
 * 每條記錄都寫低「讀數本身嘅觀測時間戳」同「我幾時見到」——
 * 兩者相減就係嗰條渠道嘅真實延遲。
 *
 * 跑完會分析:每次市場顯著郁動(任何bucket變≥3¢),
 * 對比嗰一刻各條渠道嘅狀態,計出「市場領先/落後幾多分鐘」。
 *
 * 用法:
 *   node market_race.js --hours=4
 *   node market_race.js --analyse   # 只分析已有log,唔再收集
 *
 * 幾時跑最有用:香港下晝12:00-17:00(高峰時段,溫度郁得最多、
 * 市場最活躍、破關訊號最密)。
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "market_race_log.csv");
const POLL_MS = 30_000;
const MOVE_THRESHOLD = 3; // ¢:市場變幾多先當「顯著郁動」
const STATION = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const HEADER = "fetchedAt,csvStamp,csvVal,rhrStamp,rhrVal,webStamp,webVal,metarStamp,metarVal,marketPrices";

function hkNow() { return new Date(Date.now() + 8 * 3600e3); }
function hkDateStr() { return hkNow().toISOString().slice(0, 10); }

// ---------- 溫度渠道 ----------
const CHANNELS = {
  csv: async () => {
    const res = await fetch("https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const line of (await res.text()).trim().split(/\r?\n/).slice(1)) {
      const [ts, place, v] = line.split(",").map((s) => s.trim());
      if (STATION.test(place)) return { stamp: ts, value: parseFloat(v) };
    }
    return null;
  },

  rhrread: async () => {
    const res = await fetch("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const s = j.temperature?.data?.find((d) => STATION.test(String(d.place).trim()));
    return s ? { stamp: j.temperature.recordTime, value: s.value } : null;
  },

  // 天文台網站自己個JSON——理論上網頁要即時,可能快過開放數據
  hkoWeb: async () => {
    const res = await fetch("https://www.hko.gov.hk/json/DYN_DAT_MINDS_RHRREAD.json", {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.hko.gov.hk/" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const root = (await res.json()).DYN_DAT_MINDS_RHRREAD || {};
    const stamp = root.BulletinTime?.Val_Eng ?? root.BulletinTime ?? null;
    for (const [k, v] of Object.entries(root)) {
      if (/observatory|HKO/i.test(k) && /temp/i.test(k)) {
        const n = parseFloat(v?.Val_Eng ?? v);
        if (!Number.isNaN(n)) return { stamp: String(stamp), value: n };
      }
    }
    return null;
  },

  metar: async () => {
    const res = await fetch("https://aviationweather.gov/api/data/metar?ids=VHHH&format=json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.json())?.[0];
    return m && typeof m.temp === "number" ? { stamp: String(m.reportTime || m.obsTime), value: m.temp } : null;
  },
};

// ---------- 市場 ----------
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

// ⚠️2026-09-07:呢度本來用冇年份嘅slug,即係由頭到尾都命中唔到。
// 2026-08-26喺market班個log查實:Polymarket真正嘅slug尾有年份
//   highest-temperature-in-hong-kong-on-august-26-2026
// 當時修咗daily_log.js同兩個polymarket.js,但漏咗呢份——
// 而呢個script一直未跑過,所以冇人發現。如果照跑落去,
// 會收足4個鐘、一格市場數據都冇,而且冇錯誤訊息。
// (CLAUDE.md:改一個writer = 搵晒所有reader。呢次就係漏咗一個。)
async function fetchMarket() {
  const d = hkNow();
  const slugs = [
    `highest-temperature-in-hong-kong-on-${MONTHS[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}`,
    `highest-temperature-in-hong-kong-on-${MONTHS[d.getUTCMonth()]}-${d.getUTCDate()}`,
  ];
  let ev = null;
  for (const slug of slugs) {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Gamma ${res.status}`);
    const hit = (await res.json())?.[0];
    if (hit) { ev = hit; break; }
  }
  // slug都miss → 掃weather tag配title(個API寫limit=200但實際最多回100,要分頁)
  if (!ev) {
    const all = [];
    for (let offset = 0; offset < 600; offset += 100) {
      const r = await fetch(`https://gamma-api.polymarket.com/events?closed=false&limit=100&offset=${offset}&tag_slug=weather`, { cache: "no-store" });
      if (!r.ok) break;
      const page = await r.json();
      if (!Array.isArray(page) || !page.length) break;
      all.push(...page);
      if (page.length < 100) break;
    }
    const re = new RegExp(`highest temperature in hong kong on ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}\\b`, "i");
    ev = all.find((e) => re.test(e.title || "")) || null;
  }
  if (!ev) return null;
  const out = {};
  for (const mkt of ev.markets || []) {
    const label = (mkt.groupItemTitle || mkt.question || "").trim();
    try {
      const p = JSON.parse(mkt.outcomePrices || "[]");
      if (p[0] !== undefined && label) out[label] = Math.round(parseFloat(p[0]) * 100);
    } catch { /* ignore */ }
  }
  return Object.keys(out).length ? out : null;
}

// ---------- 收集 ----------
async function sample() {
  const results = await Promise.allSettled([
    CHANNELS.csv(), CHANNELS.rhrread(), CHANNELS.hkoWeb(), CHANNELS.metar(), fetchMarket(),
  ]);
  const [csv, rhr, web, metar, market] = results.map((r) => (r.status === "fulfilled" ? r.value : null));

  const row = [
    new Date().toISOString(),
    csv?.stamp ?? "", csv?.value ?? "",
    rhr?.stamp ?? "", rhr?.value ?? "",
    web?.stamp ?? "", web?.value ?? "",
    metar?.stamp ?? "", metar?.value ?? "",
    market ? JSON.stringify(market).replace(/,/g, ";") : "", // CSV安全:逗號換分號
  ].join(",");

  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, HEADER + "\n");
  fs.appendFileSync(LOG_FILE, row + "\n");

  const t = (c) => (c ? `${c.value}°` : "—");
  console.log(`${new Date().toISOString().slice(11,19)} csv ${t(csv)} rhr ${t(rhr)} web ${t(web)} metar ${t(metar)}` +
    (market ? ` | 市場 ${Object.entries(market).map(([k,v])=>`${k.replace(/°C.*/,'')}:${v}`).join(" ")}` : " | 市場—"));
  return { csv, rhr, web, metar, market };
}

// ---------- 分析 ----------
function parseLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf-8").trim().split(/\r?\n/).slice(1).map((line) => {
    const c = line.split(",");
    let market = null;
    try { market = c[9] ? JSON.parse(c[9].replace(/;/g, ",")) : null; } catch { /* ignore */ }
    return {
      at: new Date(c[0]).getTime(),
      csv: { stamp: c[1], val: parseFloat(c[2]) },
      rhr: { stamp: c[3], val: parseFloat(c[4]) },
      web: { stamp: c[5], val: parseFloat(c[6]) },
      metar: { stamp: c[7], val: parseFloat(c[8]) },
      market,
    };
  });
}

// 各渠道嘅「出街延遲」:讀數觀測時間 → 我見到嗰刻
function channelLatency(rows) {
  const out = {};
  for (const ch of ["csv", "rhr", "web", "metar"]) {
    const seen = new Set(), lags = [];
    for (const r of rows) {
      const s = r[ch]?.stamp;
      if (!s || seen.has(s)) continue;
      seen.add(s);
      const obs = parseStamp(s, ch);
      if (obs) lags.push((r.at - obs) / 60000); // 分鐘
    }
    if (lags.length) {
      lags.sort((a, b) => a - b);
      out[ch] = { n: lags.length, median: lags[Math.floor(lags.length / 2)], min: lags[0], max: lags[lags.length - 1] };
    }
  }
  return out;
}

function parseStamp(s, ch) {
  if (!s) return null;
  if (ch === "csv" && /^\d{12}$/.test(s)) {
    // YYYYMMDDHHMM 香港時間
    return Date.parse(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:00+08:00`);
  }
  if (ch === "metar") {
    const t = /Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
    const v = Date.parse(t);
    return Number.isNaN(v) ? null : v;
  }
  // ⚠️2026-09-07:hkoWeb跌到呢度,而佢個BulletinTime係淨HHMM(例如"1300")。
  // Date.parse("1300")當咗做「1300年」,個滯後就變咗3.8億分鐘(726年)。
  // 個log印出嚟係 中位318558622.2分鐘——一眼睇得出係垃圾,但個analysis
  // 照計照排,差啲就當咗真數據睇。呢啲數字唔會throw,只會靜靜哋錯。
  if (/^\d{3,4}$/.test(s)) {
    const hhmm = s.padStart(4, "0");
    const hkToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    return Date.parse(`${hkToday}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00+08:00`);
  }
  const v = Date.parse(s);
  if (Number.isNaN(v)) return null;
  // 最後一道閘:parse到但明顯離譜(超過一日)就當讀唔到,唔好污染個analysis
  if (Math.abs(Date.now() - v) > 86400e3) return null;
  return v;
}

// 市場顯著郁動嗰陣,各渠道知咗未
function analyseMoves(rows) {
  const moves = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].market, b = rows[i].market;
    if (!a || !b) continue;
    for (const k of Object.keys(b)) {
      if (a[k] === undefined) continue;
      const delta = b[k] - a[k];
      if (Math.abs(delta) >= MOVE_THRESHOLD) {
        moves.push({ idx: i, at: rows[i].at, bucket: k, from: a[k], to: b[k], delta });
      }
    }
  }
  return moves;
}

// 每個渠道嘅「讀數改變時刻」清單
function changePoints(rows, ch) {
  const pts = [];
  let prev = null;
  for (const r of rows) {
    const v = r[ch]?.val;
    if (v === undefined || Number.isNaN(v)) continue;
    if (prev !== null && v !== prev) pts.push(r.at);
    prev = v;
  }
  return pts;
}

// 對每次市場郁動,搵最近嘅渠道更新——之前定之後?
//   負數 = 渠道先更新,市場跟尾(即係市場用緊嗰條渠道)
//   正數 = 市場先郁,渠道之後先追上(市場真係行先)
function leadLag(rows, moves) {
  const out = {};
  for (const ch of ["csv", "rhr", "web", "metar"]) {
    const pts = changePoints(rows, ch);
    if (!pts.length) continue;
    const deltas = [];
    for (const mv of moves) {
      // 揀時間上最接近嗰個更新點
      let best = null;
      for (const p of pts) {
        const d = (mv.at - p) / 60000; // >0 = 渠道喺市場之前
        if (best === null || Math.abs(d) < Math.abs(best)) best = d;
      }
      if (best !== null) deltas.push(-best); // 轉做「市場領先幾多分鐘」
    }
    if (deltas.length) {
      deltas.sort((a, b) => a - b);
      const med = deltas[Math.floor(deltas.length / 2)];
      const led = deltas.filter((d) => d > 0.5).length;
      out[ch] = { median: med, led, total: deltas.length };
    }
  }
  return out;
}

function analyse() {
  const rows = parseLog();
  if (rows.length < 10) { console.log(`數據太少(${rows.length}個樣本),繼續收集`); return; }

  console.log(`\n📊 ${rows.length}個樣本 · ${new Date(rows[0].at).toISOString().slice(0,16)} → ${new Date(rows[rows.length-1].at).toISOString().slice(0,16)}\n`);

  console.log("① 各渠道出街延遲(觀測時間 → 我見到):");
  const lat = channelLatency(rows);
  const names = { csv: "HKO 1分鐘CSV", rhr: "HKO rhrread ", web: "HKO網站JSON ", metar: "VHHH METAR  " };
  for (const [ch, s] of Object.entries(lat)) {
    const bad = s.median < 0 ? "  ⚠️負數=時間戳parse錯(時區?),呢行唔好信" : "";
    console.log(`   ${names[ch]} 中位 ${s.median.toFixed(1)}分鐘 (最快${s.min.toFixed(1)} 最慢${s.max.toFixed(1)}, n=${s.n})${bad}`);
  }
  const fastest = Object.entries(lat).sort((a, b) => a[1].median - b[1].median)[0];
  const csvLat = lat.csv?.median;
  if (fastest && csvLat && fastest[0] !== "csv") {
    console.log(`   → 最快係 ${names[fastest[0]].trim()},比你用緊嘅CSV快 ${(csvLat - fastest[1].median).toFixed(1)} 分鐘`);
  }

  const moves = analyseMoves(rows);
  console.log(`\n② 市場顯著郁動(≥${MOVE_THRESHOLD}¢): ${moves.length}次`);
  if (!moves.length) { console.log("   (跑耐啲,或者揀高峰時段再跑)"); return; }

  const ll = leadLag(rows, moves);
  console.log("\n③ 市場 vs 各渠道:邊個行先?(正數=市場行先)");
  for (const [ch, s] of Object.entries(ll)) {
    const dir = s.median > 0.5 ? "市場行先" : s.median < -0.5 ? "市場跟尾" : "同步";
    console.log(`   ${names[ch]} 中位 ${s.median > 0 ? "+" : ""}${s.median.toFixed(1)}分鐘 → ${dir}` +
      `  (${s.led}/${s.total}次市場行先)`);
  }
  const sorted = Object.entries(ll).sort((a, b) => a[1].median - b[1].median);
  if (sorted.length) {
    const [followCh, f] = sorted[0];
    console.log(`\n💡 結論:`);
    if (f.median < -0.5) {
      console.log(`   市場最貼住 ${names[followCh].trim()} 郁(中位落後佢${Math.abs(f.median).toFixed(1)}分鐘)`);
      console.log(`   → 即係話市場用緊呢條渠道。你想追平,就要換去同一條(或者更快嗰條)。`);
    } else {
      console.log(`   所有公開渠道都喺市場之後先更新 → 市場真係行先。`);
      console.log(`   可能原因:私人氣象站、更快嘅商業feed、或者純粹係order flow(唔係資訊)。`);
    }
    const csvS = ll.csv;
    if (csvS && csvS.median > 0.5) {
      console.log(`   ⚠️ 你用緊嘅1分鐘CSV:市場平均行先佢 ${csvS.median.toFixed(1)}分鐘——呢個就係你嘅資訊落後幅度。`);
    }
  }

  console.log("\n④ 最大幾次郁動:");
  for (const mv of moves.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5)) {
    const r = rows[mv.idx];
    console.log(`   ${new Date(mv.at).toISOString().slice(11,16)}Z ${mv.bucket}: ${mv.from}→${mv.to}¢ (${mv.delta > 0 ? "+" : ""}${mv.delta})` +
      ` | 當時 csv ${r.csv.val}° rhr ${r.rhr.val}° metar ${r.metar.val}°`);
  }
}

async function main() {
  if (process.argv.includes("--analyse")) { analyse(); return; }
  const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
  const hours = hoursArg ? parseFloat(hoursArg.split("=")[1]) : 2;
  const until = Date.now() + hours * 3600e3;
  console.log(`🏁 開始收集(每${POLL_MS/1000}秒,跑${hours}個鐘)…香港時間 ${hkNow().toISOString().slice(11,16)}\n`);

  while (Date.now() < until) {
    await sample().catch((e) => console.error("  ❌", e.message));
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  analyse();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
