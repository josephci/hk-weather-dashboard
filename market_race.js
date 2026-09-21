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
const HEADER = "fetchedAt,csvStamp,csvVal,rhrStamp,rhrVal,webStamp,webVal,metarStamp,metarVal,marketPrices,clobPrices";

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
  const out = {}, tokens = {};
  for (const mkt of ev.markets || []) {
    const label = (mkt.groupItemTitle || mkt.question || "").trim();
    try {
      const p = JSON.parse(mkt.outcomePrices || "[]");
      if (p[0] !== undefined && label) out[label] = Math.round(parseFloat(p[0]) * 100);
    } catch { /* ignore */ }
    // ⚠️2026-09-19加:順手攞YES嗰隻token嘅id,用嚟直接問CLOB要價。
    // 點解要加:用戶問「點解市場成日早一步」。翻09-07個log數返,
    // 市價喺3個鐘入面變咗33次,而**每一次間隔都係4.7–5.5分鐘**
    // (中位4.9),冇一次喺中間。我哋poll係30秒一次兼cache:"no-store",
    // 即係嗰個5分鐘唔係我哋整出嚟——係gamma嗰條線本身就咁。
    // gamma係metadata/aggregation API,真價喺CLOB嗰邊。
    // 我哋成個repo淨係ping過 clob.polymarket.com/time 做健康檢查,
    // 一次都冇攞過佢個價。即係我哋睇住一個**量化到5分鐘**嘅市場,
    // 市場幾時真係郁咗,我哋根本量唔到。
    try {
      const ids = JSON.parse(mkt.clobTokenIds || "[]");
      if (ids[0] && label) tokens[label] = String(ids[0]);
    } catch { /* ignore */ }
  }
  return Object.keys(out).length ? { prices: out, tokens } : null;
}

// CLOB嘅midpoint = (best bid + best ask)/2,即係order book當下個價。
// ⚠️分唔清死因就等於冇log:batch掛咗要講返status同試過幾多隻token,
// 唔好一句「攞唔到價」冚晒(CLAUDE.md:市價班就係咁查咗成日)。
let clobError = null;
async function fetchClobMids(tokens) {
  const entries = Object.entries(tokens || {});
  if (!entries.length) return null;
  // ⚠️2026-09-21 probe實測(run 35559757381),同一刻同一批token:
  //     POST /midpoints  {params:[{token_id}]}  → 400 {"error":"Invalid payload"}
  //     POST /midpoints  [{token_id}] 裸array   → 200 全部有價
  //   即係**個body shape一直都係錯**,要裸array。
  //
  // ⚠️訂正:09-19見到400,我寫低「係市場resolve咗冇order book,唔係shape錯」。
  // **啱啱相反。**嗰晚個市場的確啱啱結咗,兩個解釋同時講得通,
  // 而我揀咗其中一個就收工,冇試第二個shape——典型「搵到一個解釋就當查完」。
  // 09-20跑5個鐘攞到clob數據,唔係因為batch通咗,係**跌咗落逐隻GET**
  // (一個poll 11個request)。嗰組0.6分解析度嘅數係真嘅,但一直行緊慢嗰條路。
  let batchErr = null;
  for (const [shape, body] of [
    ["裸array", entries.map(([, id]) => ({ token_id: id }))],
    ["{params}", { params: entries.map(([, id]) => ({ token_id: id })) }],
  ]) {
    try {
      const res = await fetch("https://clob.polymarket.com/midpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = (await res.text().catch(() => "")).slice(0, 200);
        batchErr = `${shape} HTTP ${res.status} body=${JSON.stringify(txt)}`;
        continue;
      }
      const j = await res.json();
      const out = {};
      for (const [label, id] of entries) {
        const v = j?.[id];
        if (v !== undefined) out[label] = Math.round(parseFloat(v) * 100);
      }
      if (Object.keys(out).length) return out;
      batchErr = `${shape} 回咗${Object.keys(j || {}).length}個key,一個都對唔上我哋${entries.length}隻token id`;
    } catch (e) { batchErr = `${shape} ${e.message}`; }
  }

  // 逐隻試:分得開「個endpoint用錯shape」(全部同一個死法)
  // 同「呢個市場冇book」(通,但冇價)
  const out = {};
  const errs = [];
  for (const [label, id] of entries) {
    try {
      const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!r.ok) { errs.push(`${r.status}`); continue; }
      const j = await r.json();
      const v = j?.mid ?? j?.midpoint;
      if (v !== undefined) out[label] = Math.round(parseFloat(v) * 100);
      else errs.push(`200但冇mid欄(${Object.keys(j || {}).join("/") || "空"})`);
    } catch (e) { errs.push(e.message); }
  }
  if (Object.keys(out).length) {
    clobError = `batch死咗(${batchErr}),但逐隻GET攞到${Object.keys(out).length}/${entries.length}`;
    return out;
  }
  const tally = errs.reduce((m, e) => (m[e] = (m[e] || 0) + 1, m), {});
  clobError = `batch:${batchErr} | 逐隻GET ${entries.length}隻都唔得:` +
    Object.entries(tally).map(([e, n]) => `${e}×${n}`).join(" ");
  return null;
}

// ---------- 收集 ----------
// ⚠️2026-09-19加一欄clobPrices。呢個repo有前科:calibration_log 4欄變5欄,
// 個header冇跟住改,dashboard照讀第4欄,靜咗個feedback loop十日。
// 呢度個HEADER淨係喺「個檔唔存在」嗰陣寫,即係加欄之後舊檔會永遠留住舊header
// ——舊rows個c[10]係undefined(clob=null),完全讀得,所以唔使搬檔,
// 但個header一定要補返,否則下次有人照header讀就會爭一欄。
let headerFixed = false;
function ensureHeader() {
  if (headerFixed) return;
  headerFixed = true;
  const txt = fs.readFileSync(LOG_FILE, "utf-8");
  const nl = txt.indexOf("\n");
  const first = nl < 0 ? txt : txt.slice(0, nl);
  if (first === HEADER) return;
  console.log(`⚠️ 個log仲係舊header(${first.split(",").length}欄),補成新嘅(${HEADER.split(",").length}欄)。舊rows冇clob欄,讀出嚟會係null,正常。`);
  fs.writeFileSync(LOG_FILE, HEADER + (nl < 0 ? "\n" : txt.slice(nl)));
}

async function sample() {
  const results = await Promise.allSettled([
    CHANNELS.csv(), CHANNELS.rhrread(), CHANNELS.hkoWeb(), CHANNELS.metar(), fetchMarket(),
  ]);
  const [csv, rhr, web, metar, mk] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  // fetchMarket而家回 {prices, tokens}(舊版係直接回個prices object)
  const market = mk?.prices ?? null;
  clobError = null;
  const clob = mk?.tokens ? await fetchClobMids(mk.tokens) : null;

  const row = [
    new Date().toISOString(),
    csv?.stamp ?? "", csv?.value ?? "",
    rhr?.stamp ?? "", rhr?.value ?? "",
    web?.stamp ?? "", web?.value ?? "",
    metar?.stamp ?? "", metar?.value ?? "",
    market ? JSON.stringify(market).replace(/,/g, ";") : "", // CSV安全:逗號換分號
    clob ? JSON.stringify(clob).replace(/,/g, ";") : "",
  ].join(",");

  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, HEADER + "\n");
  else ensureHeader();
  fs.appendFileSync(LOG_FILE, row + "\n");

  const t = (c) => (c ? `${c.value}°` : "—");
  const short = (m) => Object.entries(m).map(([k, v]) => `${k.replace(/°C.*/, "")}:${v}`).join(" ");
  console.log(`${new Date().toISOString().slice(11,19)} csv ${t(csv)} rhr ${t(rhr)} web ${t(web)} metar ${t(metar)}` +
    (market ? ` | gamma ${short(market)}` : " | gamma—") +
    (clob ? ` | clob ${short(clob)}` : clobError ? ` | clob✗ ${clobError}` : ""));
  return { csv, rhr, web, metar, market, clob };
}

// ---------- 分析 ----------
function parseLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf-8").trim().split(/\r?\n/).slice(1).map((line) => {
    const c = line.split(",");
    let market = null, clob = null;
    try { market = c[9] ? JSON.parse(c[9].replace(/;/g, ",")) : null; } catch { /* ignore */ }
    try { clob = c[10] ? JSON.parse(c[10].replace(/;/g, ",")) : null; } catch { /* ignore */ }
    return {
      at: new Date(c[0]).getTime(),
      csv: { stamp: c[1], val: parseFloat(c[2]) },
      rhr: { stamp: c[3], val: parseFloat(c[4]) },
      web: { stamp: c[5], val: parseFloat(c[6]) },
      metar: { stamp: c[7], val: parseFloat(c[8]) },
      market,
      clob,
    };
  });
}

// 各渠道嘅「出街延遲」:讀數觀測時間 → 我見到嗰刻
function channelLatency(rows) {
  const out = {};
  for (const ch of ["csv", "rhr", "web", "metar"]) {
    const seen = new Set(), lags = [];
    let first = true;
    for (const r of rows) {
      const s = r[ch]?.stamp;
      if (!s || seen.has(s)) continue;
      seen.add(s);
      // ⚠️2026-09-19:第一個見到嘅戳一定要剔走。我哋啱啱開機嗰陣,嗰份
      // 可能已經出咗街半個鐘——「我幾時見到」唔等於「佢幾時出街」。
      // 今晚21分鐘個run就係咁出咗「rhrread 中位31.4分鐘(n=1)」同
      // 「METAR最慢31.4分」,兩個都係假數。09-07嗰個21.6分METAR一樣係呢個。
      if (first) { first = false; continue; }
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
// ⚠️2026-09-20實測(run 35488286451,874個樣本):
//   gamma 解析度 中位 5.0分 (n=72)
//   clob  解析度 中位 0.6分 (n=207)   ← 幼 4.5 分鐘
// 即係話用gamma數出嚟嘅「市場幾時郁」,誤差本身就有5分鐘,
// 而我哋想量嘅嘢(市場vs天文台)得幾分鐘咁大。用gamma量等於用米尺度頭髮。
// 所以有clob就一定要用clob,gamma淨係做後備。
function priceOf(row) { return row.clob ?? row.market; }
function priceSrcName(rows) {
  return rows.some((r) => r.clob) ? "clob(order book midpoint,0.6分解析度)" : "gamma(5分鐘解析度,唔夠幼)";
}

function analyseMoves(rows) {
  const moves = [];
  for (let i = 1; i < rows.length; i++) {
    // ⚠️2026-09-21:個log跨好多日(每次run append落同一個檔)。
    // 唔隔走session邊界,就會攞「09-20收工嗰格」同「09-21開工嗰格」比,
    // 砌出一個假嘅100→0郁動——而佢仲會排上④「最大幾次郁動」榜首,
    // 睇落似市場崩過盤。隔咗60分鐘以上一律當兩個session,唔比。
    if (rows[i].at - rows[i - 1].at > 60 * 60000) continue;
    const a = priceOf(rows[i - 1]), b = priceOf(rows[i]);
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

// ⚠️2026-09-19加。用戶問「點解市場成日早一步」。翻09-07個log數返,
// 市價3個鐘變咗33次,而每次間隔都係4.7–5.5分(中位4.9),冇一次喺中間。
// 我哋poll係30秒一次、cache:"no-store"——即係嗰5分鐘唔係我哋整出嚟。
//
// 後果好大:如果我哋睇到嘅價本身量化到5分鐘,下面③嗰個「市場行先幾多分鐘」
// **根本分辨唔到5分鐘以下嘅嘢**。市場可能同我哋同一秒知,但因為我哋
// 遲5分鐘先見到佢郁,個報告就會寫「市場行先」——一個由我哋自己個feed
// 整出嚟嘅假結論。呢個正正係CLAUDE.md講嗰種假信心。
// 所以呢一節要行喺③之前,而且③要跟住呢個解析度講嘢。
function feedResolution(rows, key) {
  const gaps = [];
  let prev = null, lastAt = null;
  for (const r of rows) {
    const s = r[key] ? JSON.stringify(r[key]) : null;
    if (s === null) continue;
    if (prev !== null && s !== prev) {
      if (lastAt !== null) gaps.push((r.at - lastAt) / 60000);
      lastAt = r.at;
    } else if (prev === null) lastAt = r.at;
    prev = s;
  }
  if (!gaps.length) return null;
  // ⚠️2026-09-19:個log跨咗12日(09-07嗰批 + 今晚嗰批),中間個「間隔」
  // 出咗 17658.7 分鐘 —— 嗰個唔係「市場幾耐郁一次」,係兩次run之間隔咗12日。
  // 中位數頂得住,但最大值會嚇死人兼誤導。>60分鐘一律當session邊界剔走。
  const real = gaps.filter((g) => g <= 60);
  if (!real.length) return null;
  const s = real.slice().sort((a, b) => a - b);
  return { n: real.length, median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1],
    dropped: gaps.length - real.length };
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
  const fastest = Object.entries(lat)
    // ⚠️2026-09-19:原本呢度冇隔走「唔好信」嗰啲,結果個報告喺
    // 「⚠️負數=時間戳parse錯,呢行唔好信」下面一行,照樣印
    // 「→ 最快係 HKO網站JSON,比你用緊嘅CSV快 17287.3 分鐘」。
    // 自己先標咗唔好信,跟住自己攞嚟做結論——呢種報告比冇報告更差。
    .filter(([, s]) => s.median >= 0 && s.median < 120)
    .sort((a, b) => a[1].median - b[1].median)[0];
  const csvLat = lat.csv?.median;
  if (fastest && csvLat && fastest[0] !== "csv") {
    console.log(`   → 最快係 ${names[fastest[0]].trim()},比你用緊嘅CSV快 ${(csvLat - fastest[1].median).toFixed(1)} 分鐘`);
  }

  const moves = analyseMoves(rows);
  console.log(`\n② 市場顯著郁動(≥${MOVE_THRESHOLD}¢): ${moves.length}次 — 用緊 ${priceSrcName(rows)}`);
  if (!moves.length) { console.log("   (跑耐啲,或者揀高峰時段再跑)"); return; }

  // ②b 我哋睇到嘅市場,解析度有幾粗?呢個決定咗③信唔信得過。
  const gRes = feedResolution(rows, "market"), cRes = feedResolution(rows, "clob");
  console.log("\n②b 我哋個價feed本身嘅解析度(兩次變動之間隔幾耐):");
  if (gRes) console.log(`   gamma(events/outcomePrices) 中位 ${gRes.median.toFixed(1)}分 (${gRes.min.toFixed(1)}–${gRes.max.toFixed(1)}, n=${gRes.n})`);
  if (cRes) console.log(`   clob(midpoint,order book)   中位 ${cRes.median.toFixed(1)}分 (${cRes.min.toFixed(1)}–${cRes.max.toFixed(1)}, n=${cRes.n})`);
  else console.log(`   clob 冇數${clobError ? `:${clobError}` : "(舊log冇呢一欄)"}`);
  const resMin = Math.min(gRes ? gRes.median : Infinity, cRes ? cRes.median : Infinity);
  if (Number.isFinite(resMin) && resMin > 1.5) {
    console.log(`   ⚠️ 我哋最幼只睇得到 ${resMin.toFixed(1)} 分鐘一格。`);
    console.log(`      即係下面③任何細過 ${resMin.toFixed(1)} 分鐘嘅「行先/跟尾」,都係我哋個feed整出嚟,唔係市場行為。`);
  }
  if (gRes && cRes && gRes.median - cRes.median > 1) {
    console.log(`   → clob比gamma幼 ${(gRes.median - cRes.median).toFixed(1)} 分鐘。換去clob即刻贏返呢段。`);
  }

  const ll = leadLag(rows, moves);
  // ⚠️2026-09-19:每條渠道自己幾耐先出一次數,一定要一齊睇。
  // rhrread一個鐘先一份、METAR半個鐘一份——攞佢哋同「市場幾時郁」比,
  // 出嚟個「市場行先41分鐘」根本係嗰條渠道自己嘅cadence,唔係市場快。
  // 原本個報告就係咁寫,而且仲會攞嚟做結論。
  const cadence = {};
  for (const ch of ["csv", "rhr", "web", "metar"]) {
    const seen = new Set(), ts = [];
    for (const r of rows) { const s = r[ch]?.stamp; if (s && !seen.has(s)) { seen.add(s); ts.push(r.at); } }
    const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / 60000).sort((a, b) => a - b);
    if (gaps.length) cadence[ch] = gaps[Math.floor(gaps.length / 2)];
  }
  console.log("\n③ 市場 vs 各渠道:邊個行先?(正數=市場行先)");
  // ⚠️2026-09-21:換咗clob(0.6分解析度)之後,一個下晝有200次≥3¢嘅郁動,
  // 即係平均每1.5分鐘一次——**order book本身喺度跳,唔係資訊事件**。
  // leadLag嘅做法係「揀時間上最接近嗰個渠道更新點」。市場郁得夠密嘅時候,
  // 「最接近」純粹係幾何:任何一個渠道更新點附近都一定有個move,
  // 個中位數就會被扯向0(CSV)或者一個同cadence有關嘅細數(rhrread/METAR)。
  // 換句話講:**呢個統計喺高頻之下量緊幾何,唔係量緊因果。**
  // gamma嗰陣冇露餡,係因為佢5分鐘先出一個價,意外咁過濾走咗雜訊。
  const moveGaps = moves.slice(1).map((m, i) => (m.at - moves[i].at) / 60000)
    .filter((g) => g > 0 && g <= 60).sort((a, b) => a - b);
  const medMoveGap = moveGaps.length ? moveGaps[Math.floor(moveGaps.length / 2)] : Infinity;
  console.log(`   (市場平均 ${medMoveGap === Infinity ? "?" : medMoveGap.toFixed(1)} 分鐘郁一次)`);
  const verdictOf = (ch, s) => {
    const cad = cadence[ch], mag = Math.abs(s.median);
    if (cad && medMoveGap < cad) {
      return { ok: false, sync: false, txt: `⚠️分唔到(市場${medMoveGap.toFixed(1)}分鐘郁一次,呢條渠道${cad.toFixed(0)}分鐘先出一次——「最近一次更新」係幾何,唔係因果)` };
    }
    if (Number.isFinite(resMin) && mag < resMin) return { ok: false, sync: true, txt: `≈同步(差距細過${resMin.toFixed(1)}分,我哋分唔開——即係冇明顯行先)` };
    if (cad && mag > cad / 3) return { ok: false, sync: false, txt: `⚠️分唔到(呢條渠道${cad.toFixed(0)}分鐘先出一次數,呢個差距係佢自己個cadence)` };
    return { ok: true, sync: false, txt: s.median > 0 ? "市場行先" : "市場跟尾" };
  };
  for (const [ch, s] of Object.entries(ll)) {
    console.log(`   ${names[ch]} 中位 ${s.median > 0 ? "+" : ""}${s.median.toFixed(1)}分鐘 → ${verdictOf(ch, s).txt}` +
      `  (${s.led}/${s.total}次市場行先)`);
  }
  const syncCh = Object.entries(ll).filter(([ch, s]) => verdictOf(ch, s).sync);
  const usable = Object.entries(ll).filter(([ch, s]) => verdictOf(ch, s).ok);
  const sorted = usable.sort((a, b) => a[1].median - b[1].median);
  // ⚠️2026-09-21:個結論一定要由**結算源**(HKO 1分鐘CSV)話事。
  // 之前出過:CSV嗰行寫「≈同步」,而結論寫「所有公開渠道都喺市場之後
  // 先更新 → 市場真係行先」——因為≈同步嗰啲被剔出usable,
  // 個結論就淨係睇剩返嗰啲cadence污染嘅渠道。
  // 香港係跟HKO總部結算嘅。CSV講咩就係咩,其餘三條快唔快都唔結算。
  const csvV = ll.csv ? verdictOf("csv", ll.csv) : null;
  if (csvV && !csvV.ok) {
    console.log(`\n💡 結論:`);
    console.log(`   **結算源(HKO 1分鐘CSV)**:${csvV.txt}`);
    if (csvV.sync) {
      console.log(`   → 喺 ${resMin.toFixed(1)} 分鐘解析度之下,市場同結算源**分唔開先後**,即係冇明顯行先。`);
    } else {
      console.log(`   → 呢次量唔到市場對結算源嘅快慢。要量,就要淨係計大郁動(資訊事件),`);
      console.log(`     唔係計order book日常跳動。`);
    }
    const others = Object.entries(ll).filter(([ch]) => ch !== "csv").map(([ch, s]) => `${names[ch].trim()} ${s.median > 0 ? "+" : ""}${s.median.toFixed(1)}分`);
    console.log(`   ⚠️其餘渠道(${others.join(" / ")})唔好攞嚟落結論——`);
    console.log(`     佢哋唔係結算源,而且個數受自己個cadence同市場郁動密度污染。`);
  } else if (!sorted.length && syncCh.length) {
    console.log(`\n💡 結論:`);
    console.log(`   喺 ${resMin.toFixed(1)} 分鐘嘅解析度之下,以下渠道同市場**分唔開先後**:`);
    for (const [ch, s] of syncCh) console.log(`     ${names[ch].trim()}(中位 ${s.median > 0 ? "+" : ""}${s.median.toFixed(1)}分)`);
    console.log(`   → 即係話市場**冇明顯行先**呢啲渠道。你之前覺得「市場早一步」,`);
    console.log(`     好可能係我哋自己個價feed遲(gamma 5分鐘一格)整出嚟嘅錯覺。`);
    console.log(`   ⚠️但「分唔開」唔等於「一定同步」——只係差距細過 ${resMin.toFixed(1)} 分鐘。`);
  } else if (sorted.length) {
    const [followCh, f] = sorted[0];
    console.log(`\n💡 結論:`);
    // ⚠️2026-09-19:個結論一定要跟返②b個解析度。之前會寫
    // 「市場最貼住CSV郁 → 即係市場用緊呢條渠道」,而兩行之後自己就話
    // 「呢個數細過我哋個feed嘅解析度」。自打嘴巴嘅報告等於冇報告。
    const blind = Number.isFinite(resMin) && Math.abs(f.median) <= resMin;
    if (blind) {
      console.log(`   **落唔到結論。** 最貼嗰條(${names[followCh].trim()})個差距係 ${Math.abs(f.median).toFixed(1)}分鐘,`);
      console.log(`   而我哋個價feed最幼只睇得到 ${resMin.toFixed(1)} 分鐘一格 → 分唔開。`);
      console.log(`   要答「市場係咪真係快過天文台」,第一步係攞一條夠幼嘅價feed(clob midpoint),`);
      console.log(`   唔係再跑耐啲——跑幾耐都突破唔到自己個feed嘅解析度。`);
    } else if (f.median < -0.5) {
      console.log(`   市場最貼住 ${names[followCh].trim()} 郁(中位落後佢${Math.abs(f.median).toFixed(1)}分鐘)`);
      console.log(`   → 即係話市場用緊呢條渠道。你想追平,就要換去同一條(或者更快嗰條)。`);
    } else {
      console.log(`   所有公開渠道都喺市場之後先更新 → 市場真係行先。`);
      console.log(`   可能原因:私人氣象站、更快嘅商業feed、或者純粹係order flow(唔係資訊)。`);
    }
    const csvS = ll.csv;
    if (csvS && Math.abs(csvS.median) > 0.5) {
      const side = csvS.median > 0 ? "行先" : "跟尾";
      console.log(`   ⚠️ 你用緊嘅1分鐘CSV:市場中位${side}佢 ${Math.abs(csvS.median).toFixed(1)}分鐘。`);
      if (Number.isFinite(resMin) && Math.abs(csvS.median) <= resMin) {
        console.log(`   ⚠️⚠️ 但呢個數(${Math.abs(csvS.median).toFixed(1)}分)細過或等於我哋個價feed嘅解析度(${resMin.toFixed(1)}分)`);
        console.log(`        → **呢個「${side}」有可能完全係我哋自己遲收到價整出嚟嘅**,證明唔到市場真係快定慢。`);
        console.log(`        先換去clob(或者證實clob一樣咁粗)再落呢個結論。`);
      }
    }
  }

  console.log("\n④ 最大幾次郁動:");
  for (const mv of moves.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5)) {
    const r = rows[mv.idx];
    console.log(`   ${new Date(mv.at).toISOString().slice(11,16)}Z ${mv.bucket}: ${mv.from}→${mv.to}¢ (${mv.delta > 0 ? "+" : ""}${mv.delta})` +
      ` | 當時 csv ${r.csv.val}° rhr ${r.rhr.val}° metar ${r.metar.val}°`);
  }

  bigMoveTiming(rows, moves);
}

// ⑤ ③量唔到,因為order book成日喺度跳(0.8分鐘一次),
// 「最近一次渠道更新」純粹係幾何。要問因果,就要淨係睇**資訊事件**:
// 大郁動。而且唔好問「最近一個更新係幾時」,要問
// **「距離上一次CSV出街幾耐」**——CSV 10分鐘一格,
// 如果市場係跟住CSV郁,大郁動就會擠喺出街之後嗰1-2分鐘。
function bigMoveTiming(rows, moves) {
  console.log("\n⑤ 大郁動 vs CSV出街時刻(呢個先答到「市場係咪行先結算源」)");
  // CSV每個戳第一次見到 = 出街時刻
  const arr = [];
  const seen = new Set();
  for (const r of rows) {
    const s = r.csv?.stamp;
    if (s && !seen.has(s)) { seen.add(s); arr.push(r.at); }
  }
  if (arr.length < 5) { console.log("   CSV到貨次數唔夠,跑耐啲"); return; }
  // 出街間隔:用嚟計「隨機分佈嘅話,頭2分鐘應該佔幾多」
  const gaps = arr.slice(1).map((t, i) => (t - arr[i]) / 60000).filter((g) => g > 0 && g <= 60);
  const medGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 10;
  const expect = Math.min(1, 2 / medGap);

  for (const TH of [10, 20]) {
    const big = moves.filter((m) => Math.abs(m.delta) >= TH);
    const since = big.map((m) => {
      let prev = null;
      for (const t of arr) if (t <= m.at) prev = t; else break;
      return prev === null ? NaN : (m.at - prev) / 60000;
    }).filter((x) => Number.isFinite(x) && x <= 60).sort((a, b) => a - b);
    if (!since.length) { console.log(`   ≥${TH}¢: 0次`); continue; }
    const med = since[Math.floor(since.length / 2)];
    const within2 = since.filter((s) => s <= 2).length;
    const pct = 100 * within2 / since.length;
    console.log(`   ≥${TH}¢: ${since.length}次 · 距上次CSV出街 中位 ${med.toFixed(1)}分 · ` +
      `出街後2分鐘內就郁 ${within2}/${since.length} (${pct.toFixed(0)}%,隨機應該約${(100 * expect).toFixed(0)}%)`);
    // ⚠️唔好見到一個方向就落結論。二項分佈之下,n細嘅時候乜都似有pattern。
    if (since.length < 30) {
      console.log(`      ⚠️n=${since.length},太細,唔好落結論。要儲幾日先講。`);
    } else if (pct > 100 * expect * 1.5) {
      console.log(`      → 大郁動擠喺CSV出街之後 = 市場**跟住結算源**郁,冇行先。`);
    } else if (pct < 100 * expect * 0.5) {
      console.log(`      → 大郁動避開CSV出街之後,反而擠喺出街**之前** = 市場有第二條資訊源。查落去。`);
    } else {
      console.log(`      → 同隨機分唔開,量唔到關係。`);
    }
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
