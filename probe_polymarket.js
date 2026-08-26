/**
 * probe_polymarket.js
 * ------------------------------------------------------------
 * 喺你自己部電腦跑,答我喺sandbox度答唔到嗰幾條問題。
 *
 * 點解要你跑:呢個開發sandbox個proxy封晒 polymarket.com、
 * status.polymarket.com、連你個 workers.dev 都403。所以我改得到code,
 * 但驗證唔到Polymarket實際回乜。你部電腦冇呢個限制。
 *
 * 佢會查:
 *   ① 三條線通唔通    status頁 / gamma(市場數據) / clob(交易)
 *   ② 今日+聽日個slug 命唔命中(市價一路記唔到,懷疑係呢度)
 *   ③ weather tag入面到底有咩香港event(睇真正個slug格式)
 *   ④ 搵到個market之後,逐格label同價印晒出嚟
 *
 * 用法:
 *   node probe_polymarket.js
 *   node probe_polymarket.js > probe.txt     ← 出咗嚟嘅嘢整份貼返俾我
 *
 * ⚠️唔會改任何檔案,淨係讀同print。行完唔會有side effect。
 * ------------------------------------------------------------
 */

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const TIMEOUT_MS = 15000;

function hkDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

async function get(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body };
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.name === "AbortError";
    return { ok: false, status: null, ms: Date.now() - t0, err: timeout ? `${TIMEOUT_MS / 1000}秒都冇回應` : err.message };
  }
}

const line = (n = 60) => console.log("─".repeat(n));

// ---------- ① 三條線 ----------
async function checkLines() {
  console.log("\n① 三條線通唔通");
  line();
  const targets = [
    ["官方狀態頁", "https://status.polymarket.com/api/v2/summary.json"],
    ["gamma 市場數據", "https://gamma-api.polymarket.com/events?limit=1&closed=false"],
    ["clob 交易API", "https://clob.polymarket.com/time"],
  ];
  const out = {};
  for (const [name, url] of targets) {
    const r = await get(url);
    out[name] = r;
    console.log(`  ${name.padEnd(16)} ${r.ok ? "✓" : "✗"} ${r.status ?? ""} ${String(r.ms).padStart(5)}ms  ${r.err ?? ""}`);
  }

  // 狀態頁講緊乜(維護窗口係你最想知嗰樣)
  const sp = out["官方狀態頁"];
  if (sp.ok) {
    try {
      const j = JSON.parse(sp.body);
      console.log(`\n  總體狀態: ${j.status?.description ?? "?"} (${j.status?.indicator ?? "?"})`);
      const mnt = (j.scheduled_maintenances || []).filter((m) => m.status !== "completed");
      const inc = (j.incidents || []).filter((i) => i.status !== "resolved" && i.status !== "postmortem");
      if (mnt.length) {
        console.log("  🔧 維護:");
        for (const m of mnt) console.log(`     ${m.name} [${m.status}] ${m.scheduled_for} → ${m.scheduled_until}`);
      } else console.log("  🔧 維護: 冇");
      if (inc.length) {
        console.log("  ⚠️ 事故:");
        for (const i of inc) console.log(`     ${i.name} [${i.impact}/${i.status}]`);
      } else console.log("  ⚠️ 事故: 冇");
      const bad = (j.components || []).filter((c) => c.status && c.status !== "operational" && !c.group);
      console.log(`  🔻 唔正常嘅component: ${bad.length ? bad.map((c) => `${c.name}=${c.status}`).join(", ") : "冇"}`);
    } catch { console.log("  ⚠️ 狀態頁parse唔到(schema變咗?)"); }
  }

  const clob = out["clob 交易API"];
  if (clob.ok) {
    const t = parseInt(String(clob.body).trim(), 10);
    console.log(`\n  clob回應: ${String(clob.body).slice(0, 40)}` +
      (Number.isFinite(t) && t > 1e9 ? ` (時間戳,同你部機差${Math.round(Math.abs(Date.now() / 1000 - t))}秒)` : " ⚠️唔似時間戳"));
  }
  return out;
}

// ---------- ② slug命唔命中 ----------
async function checkSlug(label, date) {
  const [, m, d] = date.split("-").map(Number);
  const slug = `highest-temperature-in-hong-kong-on-${MONTHS[m - 1]}-${d}`;
  const r = await get(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  if (!r.ok) { console.log(`  ${label} ${date}  ✗ HTTP ${r.status ?? r.err}`); return null; }
  let arr = [];
  try { arr = JSON.parse(r.body); } catch { console.log(`  ${label} ${date}  ✗ 回應唔係JSON`); return null; }
  const hit = Array.isArray(arr) && arr.length;
  console.log(`  ${label} ${date}  ${hit ? "✓ 命中" : "✗ MISS"}   slug=${slug}`);
  return hit ? arr[0] : null;
}

// ---------- ③ weather tag入面真正有咩 ----------
async function scanWeatherTag() {
  console.log("\n③ weather tag入面有咩香港event(睇真正嘅slug格式)");
  line();
  const r = await get("https://gamma-api.polymarket.com/events?closed=false&limit=200&tag_slug=weather");
  if (!r.ok) { console.log(`  ✗ HTTP ${r.status ?? r.err}`); return []; }
  let all = [];
  try { all = JSON.parse(r.body); } catch { console.log("  ✗ 回應唔係JSON"); return []; }
  if (!Array.isArray(all)) { console.log("  ✗ 回應唔係array"); return []; }
  console.log(`  weather tag總共 ${all.length} 個未收市event`);
  const hk = all.filter((e) => /hong kong/i.test(e.title || "") || /hong-kong/i.test(e.slug || ""));
  if (!hk.length) {
    console.log("  ⚠️ 一個香港event都冇——可能真係未開盤,或者唔喺weather呢個tag");
    console.log("  (參考)頭10個event嘅slug:");
    for (const e of all.slice(0, 10)) console.log(`     ${e.slug}`);
  } else {
    console.log(`  搵到 ${hk.length} 個香港event:`);
    for (const e of hk) console.log(`     ${e.slug}\n        title: ${e.title}`);
  }
  return hk;
}

// ---------- ④ 逐格label同價 ----------
function dumpBuckets(ev) {
  console.log(`\n④ 「${ev.title}」逐格`);
  line();
  console.log(`  slug: ${ev.slug}`);
  const mkts = ev.markets || [];
  if (!mkts.length) { console.log("  ⚠️ 冇markets(可能未開盤)"); return; }
  for (const mkt of mkts) {
    const label = (mkt.groupItemTitle || mkt.question || "").trim();
    let price = "?";
    try {
      const p = JSON.parse(mkt.outcomePrices || "[]");
      if (p[0] !== undefined) price = Math.round(parseFloat(p[0]) * 100) + "¢";
    } catch { /* ignore */ }
    // daily_log淨係收「單一整數」嘅格,標返出嚟邊啲會被跳過
    const skipped = /higher|above|below|lower|[-–—]/.test(label.toLowerCase());
    console.log(`  ${(label || "(冇label)").padEnd(22)} ${price.padStart(5)}   ${skipped ? "← daily_log會跳過(唔係單一整數)" : ""}`);
  }
}

async function main() {
  console.log("═".repeat(60));
  console.log("Polymarket 探測報告");
  console.log(`本機時間: ${new Date().toString()}`);
  console.log(`香港今日: ${hkDate(0)}   聽日: ${hkDate(1)}`);
  console.log("═".repeat(60));

  await checkLines();

  console.log("\n② 個slug命唔命中(市價一路記唔到,懷疑係呢度)");
  line();
  const today = await checkSlug("今日", hkDate(0));
  const tmr = await checkSlug("聽日", hkDate(1));

  const hk = await scanWeatherTag();

  const ev = today || tmr || hk[0] || null;
  if (ev) dumpBuckets(ev);
  else console.log("\n④ 冇event可以拆——上面②③已經講咗死喺邊");

  console.log("\n" + "═".repeat(60));
  console.log("跑完。成份copy返俾我(或者 node probe_polymarket.js > probe.txt)");
  console.log("═".repeat(60));
}

main().catch((e) => { console.error("❌ 跑唔完:", e.message); process.exit(1); });
