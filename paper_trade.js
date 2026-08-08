/**
 * paper_trade.js
 * ------------------------------------------------------------
 * 紙上交易:用真實市價、真實訊號行策略,但唔使真錢。
 * 目的係答「呢啲訊號到底有冇數為」——喺放錢落去之前。
 *
 * 點解一定要做呢步:
 *   2026-08-06發現METAR會攞到18個鐘前嘅舊報文,即係鎖定訊號會用錯咗嘅
 *   「已實現max」計。如果嗰陣已經自動化,佢會真金白銀買入假訊號。
 *   機器唔會貪心,但機器同樣唔會覺得「8點幾34度好似唔對路」。
 *   所以:先用紙上交易證明訊號賺錢,先至講自動化。
 *
 * 交易嘅訊號(全部係現有dashboard邏輯):
 *   LOCK_YES  — 「N or higher」而實測max已經>=N → 結果已定,買YES
 *   LOCK_NO   — bucket已經死咗(實測max升穿咗) → 買NO
 *   (model edge訊號分開記,方便比較邊種訊號真係賺錢)
 *
 * 保守假設(寧願低估自己):
 *   - 成交價 = 現價 + SLIPPAGE(買賣差價,溫度market通常2-5¢)
 *   - 唔計市場衝擊(注細,影響微)
 *   - 每注固定注碼,唔用Kelly(避免「後見之明」放大回報)
 *
 * 用法:
 *   node paper_trade.js --scan     # 掃訊號,記低模擬入場
 *   node paper_trade.js --settle   # 結算尋日嘅倉
 *   node paper_trade.js --report   # 睇成績表
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const LEDGER = path.join(__dirname, "paper_trades.csv");
const HEADER = "openedAt,date,city,bucket,side,signal,marketPrice,fillPrice,stake,realizedMax,result,pnl";

const SLIPPAGE = 2;      // ¢:成交比現價差幾多(保守)
const STAKE = 10;        // 每注$10(模擬,方便計%)
const MIN_PRICE = 3;     // 太極端嘅價唔掂(流動性差)
const MAX_PRICE = 97;

// 結算站(同dashboard一致)
const CITIES = {
  "hong-kong": { icao: null,   tz: "Asia/Hong_Kong" }, // 香港用HKO總部,唔用機場
  shanghai:    { icao: "ZSPD", tz: "Asia/Shanghai" },
  beijing:     { icao: "ZBAA", tz: "Asia/Shanghai" },
  london:      { icao: "EGLC", tz: "Europe/London" },
  paris:       { icao: "LFPB", tz: "Europe/Paris" },
  shenzhen:    { icao: "ZGSZ", tz: "Asia/Shanghai" },
};
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const HKO_MAXMIN = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const HKO_STATION = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;

function cityDate(tz, offsetMs = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetMs));
}

function metarTimeIso(m) {
  if (typeof m.obsTime === "number") return new Date(m.obsTime * 1000).toISOString();
  const t = m.reportTime || m.obsTime;
  if (!t) return null;
  const s = String(t);
  try {
    return /Z$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s).toISOString() : new Date(s.replace(" ", "T") + "Z").toISOString();
  } catch { return null; }
}

// ---------- 帳簿 ----------
function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, "utf-8").trim().split(/\r?\n/).slice(1)
    .filter(Boolean)
    .map((l) => {
      const c = l.split(",");
      return {
        openedAt: c[0], date: c[1], city: c[2], bucket: c[3], side: c[4], signal: c[5],
        marketPrice: +c[6], fillPrice: +c[7], stake: +c[8],
        realizedMax: c[9], result: c[10], pnl: c[11],
      };
    });
}

function saveLedger(rows) {
  const lines = [HEADER, ...rows.map((r) => [
    r.openedAt, r.date, r.city, r.bucket, r.side, r.signal,
    r.marketPrice, r.fillPrice, r.stake, r.realizedMax ?? "", r.result ?? "", r.pnl ?? "",
  ].join(","))];
  fs.writeFileSync(LEDGER, lines.join("\n") + "\n");
}

// ---------- 數據 ----------
async function fetchMarket(city, dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  const slug = `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}`;
  const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  if (!res.ok) return null;
  const ev = (await res.json())?.[0];
  if (!ev) return null;
  const buckets = [];
  let unit = "C";
  for (const mkt of ev.markets || []) {
    const label = (mkt.groupItemTitle || mkt.question || "").trim();
    if (/°f|fahrenheit/i.test(label)) unit = "F";
    try {
      const p = JSON.parse(mkt.outcomePrices || "[]");
      if (p[0] !== undefined && label) buckets.push({ label, yesPrice: Math.round(parseFloat(p[0]) * 100) });
    } catch { /* ignore */ }
  }
  return buckets.length ? { buckets, unit, slug } : null;
}

// 攞當地「今日至今」實測最高(=鎖定判斷嘅事實基礎)
async function fetchRealizedMax(cityKey, cfg, dateStr) {
  if (!cfg.icao) {
    // 香港:HKO總部maxmin CSV
    const res = await fetch(HKO_MAXMIN, { cache: "no-store" });
    if (!res.ok) return null;
    for (const line of (await res.text()).trim().split(/\r?\n/).slice(1)) {
      const p = line.split(",").map((s) => s.trim());
      if (HKO_STATION.test(p[1])) {
        const v = parseFloat(p[2]);
        return Number.isNaN(v) ? null : v;
      }
    }
    return null;
  }
  // 其他:METAR 26小時報文,篩當地今日,攞最高
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${cfg.icao}&format=json&hours=26`, { cache: "no-store" });
  if (!res.ok) return null;
  const arr = await res.json();
  let max = null;
  for (const m of Array.isArray(arr) ? arr : []) {
    if (typeof m.temp !== "number") continue;
    const iso = metarTimeIso(m);
    if (!iso) continue;
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(iso));
    if (d !== dateStr) continue;
    if (max === null || m.temp > max) max = m.temp;
  }
  return max;
}

// ---------- 訊號(同dashboard嘅computeLocks一致) ----------
function findLocks(buckets, realizedMax, unit) {
  const rm = unit === "F" ? realizedMax * 9 / 5 + 32 : realizedMax;
  const fb = Math.floor(rm);
  const out = [];
  for (const b of buckets) {
    const t = b.label.toLowerCase();
    const num = t.match(/(-?\d+)/);
    if (!num) continue;
    const deg = parseInt(num[1], 10);
    const range = t.match(/(-?\d+)\s*[-–—]\s*(-?\d+)/);
    const hiDeg = range ? parseInt(range[2], 10) : deg;
    if (b.yesPrice < MIN_PRICE || b.yesPrice > MAX_PRICE) continue; // 假價/冇流動性

    if (t.includes("higher") || t.includes("above")) {
      if (rm >= deg) out.push({ bucket: b.label, side: "YES", price: b.yesPrice, signal: "LOCK_YES" });
    } else if (t.includes("below") || t.includes("lower")) {
      if (fb > hiDeg) out.push({ bucket: b.label, side: "NO", price: 100 - b.yesPrice, signal: "LOCK_NO" });
    } else if (fb > hiDeg) {
      out.push({ bucket: b.label, side: "NO", price: 100 - b.yesPrice, signal: "LOCK_NO" });
    }
  }
  return out;
}

// ---------- scan ----------
async function scan() {
  const ledger = loadLedger();
  let opened = 0;

  for (const [cityKey, cfg] of Object.entries(CITIES)) {
    const dateStr = cityDate(cfg.tz);
    try {
      const [mkt, realizedMax] = await Promise.all([
        fetchMarket(cityKey, dateStr),
        fetchRealizedMax(cityKey, cfg, dateStr),
      ]);
      if (!mkt) { console.log(`  ${cityKey}: 今日冇market`); continue; }
      if (realizedMax === null) { console.log(`  ${cityKey}: 攞唔到實測max`); continue; }

      const locks = findLocks(mkt.buckets, realizedMax, mkt.unit);
      if (!locks.length) { console.log(`  ${cityKey}: 實測${realizedMax}° — 冇鎖定機會`); continue; }

      for (const lk of locks) {
        // 同一日同一bucket唔重複開倉
        if (ledger.some((r) => r.date === dateStr && r.city === cityKey && r.bucket === lk.bucket)) continue;
        const fill = Math.min(99, lk.price + SLIPPAGE); // 保守:食差價
        if (fill > MAX_PRICE) continue;                  // 差價食晒個edge就唔做
        ledger.push({
          openedAt: new Date().toISOString(), date: dateStr, city: cityKey,
          bucket: lk.bucket, side: lk.side, signal: lk.signal,
          marketPrice: lk.price, fillPrice: fill, stake: STAKE,
        });
        opened++;
        const profit = ((100 - fill) / fill * 100).toFixed(1);
        console.log(`  ✅ ${cityKey} ${lk.bucket} 買${lk.side}@${fill}¢ (現價${lk.price}+${SLIPPAGE}差價) 潛在+${profit}% [實測${realizedMax}°]`);
      }
    } catch (e) {
      console.log(`  ${cityKey}: ❌ ${e.message}`);
    }
  }

  if (opened) saveLedger(ledger);
  console.log(`\n開咗 ${opened} 個模擬倉`);
}

// ---------- settle ----------
async function settle() {
  const ledger = loadLedger();
  const open = ledger.filter((r) => !r.result);
  if (!open.length) { console.log("冇未結算嘅倉"); return; }

  let settled = 0;
  for (const r of open) {
    const cfg = CITIES[r.city];
    if (!cfg) continue;
    const todayLocal = cityDate(cfg.tz);
    if (r.date >= todayLocal) continue; // 當日未完,唔結算

    try {
      const rm = await fetchRealizedMaxForDate(r.city, cfg, r.date);
      if (rm === null) { console.log(`  ${r.city} ${r.date}: 攞唔到結算數據,下次再試`); continue; }

      const won = judgeOutcome(r, rm);
      r.realizedMax = rm;
      r.result = won ? "WIN" : "LOSS";
      r.pnl = won ? (r.stake * (100 - r.fillPrice) / r.fillPrice).toFixed(2) : (-r.stake).toFixed(2);
      settled++;
      console.log(`  ${won ? "✅" : "❌"} ${r.city} ${r.date} ${r.bucket} ${r.side}@${r.fillPrice}¢ → 實測${rm}° ${r.result} ${r.pnl > 0 ? "+" : ""}$${r.pnl}`);
    } catch (e) {
      console.log(`  ${r.city} ${r.date}: ❌ ${e.message}`);
    }
  }
  if (settled) saveLedger(ledger);
  console.log(`\n結算咗 ${settled} 個倉`);
  report();
}

async function fetchRealizedMaxForDate(cityKey, cfg, dateStr) {
  if (!cfg.icao) {
    // 香港:官方氣候API(有歷史)
    const year = dateStr.slice(0, 4);
    const res = await fetch(`https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=CLMMAXT&rformat=json&station=HKO&year=${year}`);
    if (!res.ok) return null;
    for (const row of (await res.json()).data ?? []) {
      const [y, m, d, v] = row;
      if (`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}` === dateStr) {
        const n = parseFloat(v);
        return Number.isNaN(n) ? null : n;
      }
    }
    return null;
  }
  return fetchRealizedMax(cityKey, cfg, dateStr); // METAR 26小時window,啱啱過咗一日仲攞到
}

function judgeOutcome(r, realizedMax) {
  const t = r.bucket.toLowerCase();
  const num = t.match(/(-?\d+)/);
  if (!num) return false;
  // 香港係0.1°精度但market係整數bucket:用floor對齊
  const deg = parseInt(num[1], 10);
  const range = t.match(/(-?\d+)\s*[-–—]\s*(-?\d+)/);
  const hiDeg = range ? parseInt(range[2], 10) : deg;
  const fb = Math.floor(realizedMax);

  let yesHappened;
  if (t.includes("higher") || t.includes("above")) yesHappened = realizedMax >= deg;
  else if (t.includes("below") || t.includes("lower")) yesHappened = fb <= hiDeg;
  else yesHappened = fb >= deg && fb <= hiDeg;

  return r.side === "YES" ? yesHappened : !yesHappened;
}

// ---------- report ----------
function report() {
  const ledger = loadLedger();
  const done = ledger.filter((r) => r.result);
  const open = ledger.filter((r) => !r.result);

  console.log(`\n📒 紙上交易成績 — 已結算${done.length}注 / 未結算${open.length}注`);
  if (!done.length) { console.log("   (等結算,未有成績)"); return; }

  const wins = done.filter((r) => r.result === "WIN").length;
  const pnl = done.reduce((s, r) => s + parseFloat(r.pnl || 0), 0);
  const staked = done.reduce((s, r) => s + r.stake, 0);
  console.log(`   勝率 ${wins}/${done.length} (${(wins/done.length*100).toFixed(0)}%)`);
  console.log(`   總投入 $${staked.toFixed(0)} · 損益 ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnl/staked*100).toFixed(1)}%)`);

  // 分訊號睇邊種真係賺錢
  const bySignal = {};
  for (const r of done) {
    const s = (bySignal[r.signal] ||= { n: 0, w: 0, pnl: 0, staked: 0 });
    s.n++; if (r.result === "WIN") s.w++;
    s.pnl += parseFloat(r.pnl || 0); s.staked += r.stake;
  }
  console.log("\n   分訊號:");
  for (const [sig, s] of Object.entries(bySignal)) {
    console.log(`     ${sig}: ${s.w}/${s.n}勝 · ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)} (${(s.pnl/s.staked*100).toFixed(1)}%)`);
  }
  // 分城市
  const byCity = {};
  for (const r of done) {
    const c = (byCity[r.city] ||= { n: 0, w: 0, pnl: 0 });
    c.n++; if (r.result === "WIN") c.w++; c.pnl += parseFloat(r.pnl || 0);
  }
  console.log("\n   分城市:");
  for (const [city, c] of Object.entries(byCity)) {
    console.log(`     ${city}: ${c.w}/${c.n}勝 · ${c.pnl >= 0 ? "+" : ""}$${c.pnl.toFixed(2)}`);
  }

  // 最重要嗰句:輸咗嘅「已鎖」注 = 訊號或者結算源有問題
  const lockLosses = done.filter((r) => r.signal.startsWith("LOCK") && r.result === "LOSS");
  if (lockLosses.length) {
    console.log(`\n   ⚠️ 有${lockLosses.length}注「已鎖」竟然輸咗——理論上唔應該發生。`);
    console.log("      即係話:結算源配錯、METAR攞到舊數據、或者bucket判斷有bug。");
    for (const r of lockLosses.slice(0, 5)) {
      console.log(`      ${r.date} ${r.city} ${r.bucket} ${r.side} → 實測${r.realizedMax}°`);
    }
    console.log("      ⛔ 呢個係放真錢之前一定要查清楚嘅嘢。");
  } else if (done.length >= 20) {
    console.log("\n   ✓ 所有「已鎖」注都贏晒——訊號邏輯同結算源暫時對得上。");
  }

  if (done.length < 30) {
    console.log(`\n   ℹ️ 樣本仲細(${done.length}注)。要分辨「真edge」定「行運」,至少要30-50注。`);
  }
}

async function main() {
  if (process.argv.includes("--settle")) { await settle(); return; }
  if (process.argv.includes("--report")) { report(); return; }
  console.log("📝 掃描鎖定訊號(紙上交易)…\n");
  await scan();
  report();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
