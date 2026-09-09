/**
 * hko_probe.js
 * ------------------------------------------------------------
 * 掃一次天文台公開數據,睇下有冇我哋未用、但對落注有幫助嘅源。
 *
 * 我哋而家淨係用緊三條:
 *   latest_1min_temperature.csv     0.1°,~8分鐘滯後,每10分鐘更新
 *   latest_since_midnight_maxmin.csv 今日至今max/min(結算最貼)
 *   rhrread                          整數,正整點,~3.4分鐘滯後
 *
 * 對呢個系統嚟講,一個源有冇用只睇三樣:
 *   ① 有冇天文台總部(結算站)嘅數?      唔係總部嘅話,同結算無關
 *   ② 個時間戳幾密?                   密過10分鐘先叫有增益
 *   ③ 滯後幾多?                       滯後細過現有嘅先有速度優勢
 * 所以呢個script唔係淨係「試下通唔通」,係逐條答返呢三條。
 *
 * ⚠️純讀,唔會改檔、唔會落單。
 * 用法: node hko_probe.js
 * ------------------------------------------------------------
 */

const STATION_RE = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const BASE_OD = "https://data.weather.gov.hk/weatherAPI/opendata";
const BASE_RW = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather";
const BASE_HKO = "https://www.hko.gov.hk/json";  // 天文台網站自己個JSON,唔係開放數據

// 候選名單:已知用緊嘅 + 未試過但可能有用嘅
const TARGETS = [
  // --- 而家用緊(做對照基準) ---
  ["【用緊】1分鐘溫度", `${BASE_RW}/latest_1min_temperature.csv`, "csv"],
  ["【用緊】今日maxmin", `${BASE_RW}/latest_since_midnight_maxmin.csv`, "csv"],
  ["【用緊】rhrread", `${BASE_OD}/weather.php?dataType=rhrread&lang=tc`, "rhrread"],

  // --- 同區域天氣同一個資料夾,可能有更密嘅溫度 ---
  ["1分鐘濕度", `${BASE_RW}/latest_1min_humidity.csv`, "csv"],
  ["10分鐘風", `${BASE_RW}/latest_10min_wind.csv`, "csv"],
  ["今日至今雨量", `${BASE_RW}/latest_since_midnight_rainfall.csv`, "csv"],
  ["10分鐘平均溫度", `${BASE_RW}/latest_10min_temperature.csv`, "csv"],
  ["1分鐘氣壓", `${BASE_RW}/latest_1min_pressure.csv`, "csv"],

  // --- opendata其他dataType ---
  ["每日最高溫(氣候)", `${BASE_OD}/opendata.php?dataType=CLMMAXT&rformat=json&station=HKO&year=2026`, "json"],
  ["每日最低溫(氣候)", `${BASE_OD}/opendata.php?dataType=CLMMINT&rformat=json&station=HKO&year=2026`, "json"],
  ["每日平均溫(氣候)", `${BASE_OD}/opendata.php?dataType=CLMTEMP&rformat=json&station=HKO&year=2026`, "json"],
  ["本港地區天氣預報", `${BASE_OD}/weather.php?dataType=flw&lang=tc`, "json"],
  ["九日天氣預報", `${BASE_OD}/weather.php?dataType=fnd&lang=tc`, "json"],
  ["天氣警告一覽", `${BASE_OD}/weather.php?dataType=warnsum&lang=tc`, "json"],
  ["特別天氣提示", `${BASE_OD}/weather.php?dataType=swt&lang=tc`, "json"],

  // --- ⭐天文台網站自己個內部JSON(唔係開放數據API) ---
  // market_race.js一早搵到DYN_DAT_MINDS_RHRREAD,佢自己個comment寫住
  // 「網頁要即時,可能快過開放數據」——但個script一直未跑過,所以
  // 冇人知佢究竟快唔快。呢啲係第一手源,值得逐個試。
  ["⭐網站內部:現時天氣", `${BASE_HKO}/DYN_DAT_MINDS_RHRREAD.json`, "minds"],
  ["網站內部:本港預報", `${BASE_HKO}/DYN_DAT_MINDS_FLW.json`, "minds"],
  ["網站內部:九日預報", `${BASE_HKO}/DYN_DAT_MINDS_FND.json`, "minds"],
  ["網站內部:氣象站溫度", `${BASE_HKO}/DYN_DAT_MINDS_TEMP.json`, "minds"],
  ["網站內部:警告", `${BASE_HKO}/DYN_DAT_MINDS_WARNSUM.json`, "minds"],
];

const now = () => Date.now();
const mins = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? ((now() - t) / 60000).toFixed(1) : null;
};

// CSV第一欄係YYYYMMDDHHMM
function csvTime(ts) {
  if (!/^\d{12}$/.test(String(ts).trim())) return null;
  const s = String(ts).trim();
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:00+08:00`;
}

// DYN_DAT_MINDS_*個時間戳格式未知。試齊幾種常見寫法,一種都唔中就回null,
// 由caller負責print原文——好過靜靜哋當「冇時間戳」。
function mindsTime(timeRaw, dateRaw) {
  if (timeRaw === null || timeRaw === undefined) return null;
  const t = String(timeRaw).trim();
  const d = dateRaw === null || dateRaw === undefined ? "" : String(dateRaw).trim();

  // ① YYYYMMDDHHMM 一舊過
  const full = csvTime(t);
  if (full) return full;
  // ② BulletinDate=YYYYMMDD + BulletinTime=HHMM (最大機會)
  if (/^\d{8}$/.test(d) && /^\d{3,4}$/.test(t)) {
    const hhmm = t.padStart(4, "0");
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00+08:00`;
  }
  // ④ 淨係HHMM冇日期(實測就係呢個:BulletinTime="1300")→ 當係今日(香港)
  if (/^\d{3,4}$/.test(t)) {
    const hhmm = t.padStart(4, "0");
    const hk = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    return `${hk}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00+08:00`;
  }
  // ⑤ 淨係HH:MM → 當係今日(香港)
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hk = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    return `${hk}T${m[1].padStart(2,"0")}:${m[2]}:00+08:00`;
  }
  // ⑥ ISO或者Date食得落。⚠️一定要排喺HHMM之後——Date.parse("1300")
  //    會當咗「1300年」,排前面就會食咗上面個case,重蹈覆轍
  const v = Date.parse(t);
  if (!Number.isNaN(v) && Math.abs(Date.now() - v) < 86400e3) return new Date(v).toISOString();
  return null;
}

async function probe([name, url, kind]) {
  const t0 = now();
  let res;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      // 網站內部JSON會揀客,唔俾header可能回403/空
      headers: url.includes("www.hko.gov.hk")
        ? { "User-Agent": "Mozilla/5.0", Referer: "https://www.hko.gov.hk/" } : {},
    });
  } catch (e) {
    return { name, url, ok: false, note: e.name === "TimeoutError" ? "20秒冇回應" : (e.message || "連唔到") };
  }
  const ms = now() - t0;
  if (!res.ok) return { name, url, ok: false, note: `HTTP ${res.status}`, ms };

  const text = await res.text();
  const out = { name, url, ok: true, ms, bytes: text.length };

  if (kind === "csv") {
    const lines = text.trim().split(/\r?\n/);
    out.note = `${lines.length - 1}行`;
    const hit = lines.slice(1).find((l) => STATION_RE.test((l.split(",")[1] ?? "").trim()));
    if (hit) {
      const cols = hit.split(",").map((c) => c.trim());
      out.hko = true;
      out.stamp = csvTime(cols[0]);
      out.lag = out.stamp ? mins(out.stamp) : null;
      out.sample = cols.slice(2).join(" / ");
      out.header = lines[0];
    } else {
      out.hko = false;
      out.note += "(冇天文台總部呢個站)";
    }
  } else {
    let j;
    try { j = JSON.parse(text); } catch { out.ok = false; out.note = "唔係JSON"; return out; }
    if (kind === "minds") {
      const root = j[Object.keys(j)[0]] || {};
      const keys = Object.keys(root);
      out.note = `${keys.length}個欄位`;
      // ⚠️2026-09-07:我當咗BulletinTime係YYYYMMDDHHMM(同區域天氣CSV一樣),
      // 結果parse唔到,個表印咗「undefined分」。而呢條源正正就係最想量嗰條
      // ——存在、有總部溫度、但滯後幾多完全唔知,即係最關鍵嗰格空咗。
      // 唔好再估佢咩格式:試幾種,試唔到就直接print原文出嚟。
      const stampRaw = root.BulletinTime?.Val_Eng ?? root.BulletinTime?.Val_Chi ?? root.BulletinTime ?? null;
      const dateRaw = root.BulletinDate?.Val_Eng ?? root.BulletinDate ?? null;
      const iso = mindsTime(stampRaw, dateRaw);
      if (iso) { out.stamp = iso; out.lag = mins(iso); }
      else out.stampRaw = `BulletinDate=${JSON.stringify(dateRaw)} BulletinTime=${JSON.stringify(stampRaw)}`;
      // 搵天文台總部個溫度欄
      const tempKey = keys.find((k) => /observatory|HKO/i.test(k) && /temp/i.test(k));
      if (tempKey) {
        const v = parseFloat(root[tempKey]?.Val_Eng ?? root[tempKey]);
        if (!Number.isNaN(v)) { out.hko = true; out.sample = `${v}° (欄位 ${tempKey})`; }
      }
      if (!out.hko) out.note += ` · 冇搵到總部溫度欄,頭幾個: ${keys.slice(0, 5).join(", ")}`;
    } else if (kind === "rhrread") {
      const st = (j.temperature?.data ?? []).find((d) => STATION_RE.test(String(d.place).trim()));
      out.hko = !!st;
      out.stamp = j.temperature?.recordTime ?? null;
      out.lag = out.stamp ? mins(out.stamp) : null;
      out.sample = st ? `${st.value}°(整數)` : "冇總部";
      out.note = `${(j.temperature?.data ?? []).length}個站`;
    } else {
      out.note = Object.keys(j).slice(0, 6).join(", ");
      const stamp = j.updateTime ?? j.generalSituation ?? null;
      if (typeof stamp === "string" && Date.parse(stamp)) { out.stamp = stamp; out.lag = mins(stamp); }
      if (Array.isArray(j.data)) out.note += ` · data ${j.data.length}行`;
    }
  }
  return out;
}

// ============================================================
// ⚠️2026-09-09加:自動搵源,唔再靠我估個URL。
//
// 點解要加:用戶11:48影低兩張圖——天文台自己個「分區天氣資訊平台」
// 站頁已經有 11:40 嘅30.2°,而我哋條1分鐘CSV仲停喺 11:30。
// 實測CSV滯後7.5–9.1分,即係11:40嗰格最快11:47.5先到,佢冇壞,
// 但天文台個網頁**就係攞得快過開放數據CSV**。
// 差10分鐘。對一個:05–:12嘅窗口嚟講,10分鐘等於成局。
//
// 上面個TARGETS係我逐條估出嚟嘅,估唔到嗰個平台個endpoint。
// 所以呢度改成爬:由天文台首頁出發,搵含「分區」嗰啲頁,
// 再喺頁入面挖晒所有 .json/.php/.csv,逐個開嚟睇有冇總部溫度。
//
// ⚠️純讀+print,唔會改檔。爬嘅範圍鎖死喺天文台自己嘅domain。
// ============================================================
// ⚠️2026-09-09第一輪爬嘅結果:由首頁爬到個平台真身係
//   www.hko.gov.hk/tc/wxinfo/awsgis/regional_portal.html?ele=Temperature
// 但成8版頁淨係挖到1條data URL,而且冇總部 → 佢啲data URL係JS砌出嚟嘅,
// 唔會以完整字串形式出現喺HTML。所以第二輪要落埋去啲JS檔度掘。
const CRAWL_SEEDS = [
  "https://www.hko.gov.hk/tc/wxinfo/awsgis/regional_portal.html?ele=Temperature",
  "https://www.hko.gov.hk/tc/wxinfo/awsgis/regional_portal.html",
  "https://www.hko.gov.hk/tc/index.html",
  "https://maps.weather.gov.hk/",
];
const ALLOW_HOST = /(^|\.)(hko\.gov\.hk|weather\.gov\.hk)$/i;
const HQ_HINT = /香港天文台|HK Observatory|Hong Kong Observatory|"HKO"|>HKO</i;

async function getText(url, ms = 12000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(ms),
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.hko.gov.hk/" },
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e) { return { ok: false, status: null, err: e.name === "TimeoutError" ? "timeout" : e.message }; }
}

function absUrls(body, base) {
  const out = new Set();
  // 連相對路徑一齊收——個平台啲data URL多數係相對嘅
  // ⚠️第二輪漏咗.txt,而個平台真正嗰兩個檔(latestReadings_AWS1_v2.txt、
  // gislatest_portal.txt)正正就係.txt。差啲就因為個regex而miss咗。
  for (const m of body.matchAll(/["'(]([^"'()\s]+?\.(?:json|php|csv|txt)(?:\?[^"'()\s]*)?)["')]/gi)) {
    try {
      const u = new URL(m[1], base);
      if (ALLOW_HOST.test(u.hostname)) out.add(u.href);
    } catch { /* 唔係URL就算 */ }
  }
  return [...out];
}

// ⚠️2026-09-09第二輪掘到嘅金:個平台個 irwip-map-config.js 入面有
//   /wxinfo/aws/
//   ../../../wxinfo/awsgis/        ← 由 /tc/wxinfo/awsgis/files/ 解返出嚟 = /wxinfo/awsgis/
//   latestReadings_AWS1_v2.txt
//   gislatest_portal.txt
// 呢兩個.txt十有八九就係「分區天氣資訊平台」啲即時讀數。
// 用戶11:48見到佢個站頁有11:40嘅30.2°,而我哋條CSV仲係11:30——
// 就係要驗呢兩個檔係咪真係早過開放數據CSV。
// 直接開嚟睇格式同時間戳,唔好再靠爬。
async function probeAwsGis() {
  console.log("\n  🎯 直接開個平台自己嗰兩個檔:");
  const cands = [
    "https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt",
    "https://www.hko.gov.hk/wxinfo/awsgis/gislatest_portal.txt",
    "https://www.hko.gov.hk/tc/wxinfo/awsgis/latestReadings_AWS1_v2.txt",
    "https://www.hko.gov.hk/tc/wxinfo/awsgis/gislatest_portal.txt",
    "https://www.hko.gov.hk/wxinfo/aws/latestReadings_AWS1_v2.txt",
  ];
  for (const u of cands) {
    const r = await getText(u, 10000);
    if (!r.ok) { console.log(`    ✗ ${r.status ?? r.err}  ${u.replace("https://www.hko.gov.hk", "")}`); continue; }
    const body = r.body;
    console.log(`    ✓ ${body.length}B  ${u.replace("https://www.hko.gov.hk", "")}`);
    // 頭幾行睇格式
    const lines = body.split(/\r?\n/).filter((l) => l.trim());
    console.log(`      頭5行:`);
    for (const l of lines.slice(0, 5)) console.log(`        ${l.slice(0, 120)}`);
    // 有冇總部?(呢個平台多數用站碼,所以連HKO/HKA呢啲碼一齊搵)
    const hq = lines.filter((l) => /香港天文台|HK Observatory|Hong Kong Observatory|\bHKO\b/i.test(l)).slice(0, 3);
    if (hq.length) {
      console.log(`      ⭐總部嗰行:`);
      for (const l of hq) console.log(`        ${l.slice(0, 160)}`);
    } else {
      console.log(`      ⚠️搵唔到總部字眼——可能用緊站碼,總行數 ${lines.length}`);
    }
  }
}

// ⚠️2026-09-09用戶堅持「人哋快我30秒」。我上次個race係20秒poll一次,
// 即係30秒呢個數字**喺我解析度以下**,我根本量唔到,唔可以話佢冇。
// 而race已經證實冇快源。所以30秒唔會嚟自「源」,只可能嚟自呢兩度:
//   ① poll間隔——而家出數窗口10秒一次,平均遲5秒、最壞10秒先見到
//   ② 我哋個worker一個request拉5條上游(CSV/maxmin/METAR/rhrread/網站JSON)
//      Promise.allSettled要**全部**返晒先出回應。即係嗰個0.1°讀數
//      要等埋美國個aviationweather.gov。呢條係白等,量咗先知幾貴。
// 呢度就係量②:直接拉條CSV vs 經我哋個worker,差幾多。
async function measureFanout() {
  const SITE = (process.env.SITE_URL || "https://hk-weather-dashboard.ipchonin.workers.dev").replace(/\/$/, "");
  console.log("\n" + "═".repeat(72));
  console.log("⏱  一個request拉5條上游,貴幾多?");
  console.log("═".repeat(72));
  const time = async (url, opts) => {
    const t0 = Date.now();
    try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); await r.text(); return { ms: Date.now() - t0, ok: r.ok, status: r.status }; }
    catch (e) { return { ms: Date.now() - t0, ok: false, status: e.name === "TimeoutError" ? "timeout" : e.message }; }
  };
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const direct = await time(`${BASE_RW}/latest_1min_temperature.csv`, { cache: "no-store" });
    const metar = await time("https://aviationweather.gov/api/data/metar?ids=VHHH&format=json", { cache: "no-store" });
    const full = await time(`${SITE}/api/temperature`, { cache: "no-store" });
    rows.push({ direct, metar, full });
    console.log(`  第${i + 1}次  直接拉CSV ${String(direct.ms).padStart(5)}ms${direct.ok ? "" : "(" + direct.status + ")"}` +
      `   METAR ${String(metar.ms).padStart(5)}ms${metar.ok ? "" : "(" + metar.status + ")"}` +
      `   經我哋worker ${String(full.ms).padStart(5)}ms${full.ok ? "" : "(" + full.status + ")"}`);
  }
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const d = med(rows.map((r) => r.direct.ms)), m = med(rows.map((r) => r.metar.ms)), f = med(rows.map((r) => r.full.ms));
  console.log(`\n  中位:直接 ${d}ms · METAR ${m}ms · 經worker ${f}ms`);
  console.log(`  → 個fan-out成本 ≈ ${f - d}ms (${((f - d) / 1000).toFixed(1)}秒)`);
  console.log(`  ⚠️呢個係Actions(美國機房)嘅數。你部手機喺香港,直接拉CSV會快好多,`);
  console.log(`     但經worker嗰邊個fan-out成本係一樣要俾嘅——所以呢個差額先係重點。`);
}

async function discoverSources() {
  console.log("\n" + "═".repeat(72));
  console.log("🔎 自動搵源:天文台個網頁攞緊邊條data線?");
  console.log("═".repeat(72));

  // ① 由seed頁搵「分區天氣資訊平台」嗰類頁
  const pages = new Set(CRAWL_SEEDS);
  for (const seed of CRAWL_SEEDS) {
    const r = await getText(seed);
    console.log(`  seed ${seed.replace("https://", "")} → ${r.ok ? "HTTP " + r.status : "✗ " + (r.err ?? r.status)}`);
    if (!r.ok) continue;
    for (const m of r.body.matchAll(/href=["']([^"']+)["'][^>]*>([^<]{0,40})/gi)) {
      const [, href, text] = m;
      if (!/分區|regional|rwip|ts\/|element/i.test(href + text)) continue;
      try {
        const u = new URL(href, seed);
        if (ALLOW_HOST.test(u.hostname)) pages.add(u.href);
      } catch { /* skip */ }
    }
  }
  const pageList = [...pages].slice(0, 12);
  console.log(`\n  搵到 ${pageList.length} 個候選頁:`);
  for (const p of pageList) console.log(`    ${p.replace("https://", "")}`);

  // ② 每頁挖晒data URL,連埋佢load緊嘅JS一齊挖
  //    (第一輪只挖HTML,得1條;個平台啲URL係喺JS入面砌嘅)
  const dataUrls = new Set();
  const scripts = new Set();
  const fragments = new Map(); // 路徑碎片 → 喺邊個JS見到
  for (const p of pageList) {
    const r = await getText(p);
    if (!r.ok) continue;
    for (const u of absUrls(r.body, p)) dataUrls.add(u);
    for (const m of r.body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      try {
        const u = new URL(m[1], p);
        if (ALLOW_HOST.test(u.hostname)) scripts.add(u.href);
      } catch { /* skip */ }
    }
  }
  const scriptList = [...scripts].slice(0, 20);
  console.log(`\n  啲頁load緊 ${scriptList.length} 個自家JS,逐個掘:`);
  for (const s of scriptList) {
    const r = await getText(s);
    if (!r.ok) { console.log(`    ✗ ${r.status ?? r.err}  ${s.replace("https://", "")}`); continue; }
    const before = dataUrls.size;
    for (const u of absUrls(r.body, s)) dataUrls.add(u);
    // JS入面多數係 "…/dat/" + ele + ".json" 咁砌,所以連碎片都要收
    const frags = new Set();
    for (const m of r.body.matchAll(/["'`]([\w./?=&-]*(?:aws|gis|\/dat\/|latest|minute|rwip|temp|obs)[\w./?=&-]*)["'`]/gi)) {
      const f = m[1];
      if (f.length > 3 && f.length < 90 && /[/.]/.test(f)) frags.add(f);
    }
    for (const f of frags) if (!fragments.has(f)) fragments.set(f, s);
    console.log(`    ✓ ${String(r.body.length).padStart(7)}B  +${dataUrls.size - before}條URL  ${frags.size}個碎片  ${s.replace("https://www.hko.gov.hk", "")}`);
  }
  if (fragments.size) {
    console.log(`\n  JS入面同data有關嘅路徑碎片(頭40個,用嚟砌真URL):`);
    for (const f of [...fragments.keys()].slice(0, 40)) console.log(`    ${f}`);
  }
  const list = [...dataUrls].filter((u) => !TARGETS.some(([, known]) => known === u)).slice(0, 40);
  console.log(`\n  由啲頁度挖到 ${dataUrls.size} 條data URL,其中 ${list.length} 條係我哋未試過嘅`);

  // ③ 逐條開嚟睇有冇總部溫度
  console.log("\n  逐條試(⭐= 入面有天文台總部字眼):");
  const hits = [];
  for (const u of list) {
    const r = await getText(u, 10000);
    if (!r.ok) { console.log(`    ✗ ${r.status ?? r.err}  ${u.replace("https://", "")}`); continue; }
    const hasHq = HQ_HINT.test(r.body);
    // 搵時間戳:ISO、或者 YYYYMMDDHHMM、或者裸HHMM
    const stamps = [...new Set([...r.body.matchAll(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\b\d{12}\b|"\d{4}"/g)].map((m) => m[0]))].slice(0, 3);
    console.log(`    ${hasHq ? "⭐" : "  "} ${String(r.body.length).padStart(7)}B  ${stamps.join(" ") || "冇時間戳"}  ${u.replace("https://", "")}`);
    if (hasHq) hits.push({ u, stamps, size: r.body.length });
  }

  await probeAwsGis();

  console.log(`\n  ⭐有總部字眼嘅 ${hits.length} 條:`);
  for (const h of hits) console.log(`     ${h.u}`);
  if (!hits.length) console.log("     冇——即係個平台唔係用純data URL餵(可能係POST/WebSocket/內嵌),要換方法");
  return hits;
}

async function main() {
  console.log("═".repeat(72));
  console.log("天文台公開數據掃描 — 有冇我哋未用而又有用嘅源?");
  console.log(`香港時間 ${new Date(now() + 8 * 3600e3).toISOString().slice(11, 19)}`);
  console.log("═".repeat(72));

  const results = [];
  for (const t of TARGETS) {
    const r = await probe(t);
    results.push(r);
    const tag = r.ok ? "✓" : "✗";
    const lag = r.lag !== null && r.lag !== undefined ? `滯後${r.lag}分` : "";
    console.log(`\n${tag} ${r.name}`);
    console.log(`   ${r.url.replace("https://data.weather.gov.hk/weatherAPI/", "…/")}`);
    console.log(`   ${r.note ?? ""} ${r.ms ? `${r.ms}ms` : ""}`);
    if (r.hko) console.log(`   總部: ${r.sample ?? ""}  時間戳 ${r.stamp?.slice(11, 16) ?? "?"}  ${lag}`);
    if (r.stampRaw) console.log(`   ⚠️ 讀唔到時間戳,原文: ${r.stampRaw}`);
    if (r.header) console.log(`   欄位: ${r.header}`);
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log("💡 結論:邊個對落注有增益?");
  console.log("═".repeat(72));
  const useful = results.filter((r) => r.ok && r.hko && r.lag !== null && r.lag !== undefined);
  const noLag = results.filter((r) => r.ok && r.hko && (r.lag === null || r.lag === undefined));
  useful.sort((a, b) => Number(a.lag) - Number(b.lag));
  console.log("\n有天文台總部溫度數據嘅源,按滯後排:");
  for (const r of useful) {
    console.log(`   ${String(r.lag).padStart(6)}分  ${r.name}  (${r.sample ?? ""})`);
  }
  if (noLag.length) {
    console.log("\n有總部溫度但讀唔到時間戳(排唔到序,上面有原文):");
    for (const r of noLag) console.log(`      ?分  ${r.name}  (${r.sample ?? ""})`);
  }
  console.log("\n⚠️ 滯後係一次抽樣,唔係平均——要睇規律要用rhrread_probe.js跑一段時間。");
  console.log("⚠️ 一個源快唔代表有用:仲要睇個時間戳幾密(密過10分鐘先叫贏1分鐘CSV),");
  console.log("   同埋佢係咪天文台總部(唔係總部就同結算無關)。");

  const unused = results.filter((r) => r.ok && !r.name.startsWith("【用緊】"));
  console.log(`\n通到但我哋未用嘅: ${unused.length ? unused.map((r) => r.name).join("、") : "冇"}`);
  const dead = results.filter((r) => !r.ok);
  console.log(`唔存在/通唔到: ${dead.length ? dead.map((r) => `${r.name}(${r.note})`).join("、") : "冇"}`);

  await measureFanout();
  await discoverSources();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
