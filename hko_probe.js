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
      const stampRaw = root.BulletinTime?.Val_Eng ?? root.BulletinTime ?? null;
      // BulletinTime格式係 "202609071300"(YYYYMMDDHHMM)
      const iso = csvTime(stampRaw);
      if (iso) { out.stamp = iso; out.lag = mins(iso); }
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
    if (r.header) console.log(`   欄位: ${r.header}`);
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log("💡 結論:邊個對落注有增益?");
  console.log("═".repeat(72));
  const useful = results.filter((r) => r.ok && r.hko && r.lag !== null);
  useful.sort((a, b) => Number(a.lag) - Number(b.lag));
  console.log("\n有天文台總部溫度數據嘅源,按滯後排:");
  for (const r of useful) {
    console.log(`   ${String(r.lag).padStart(6)}分  ${r.name}  (${r.sample ?? ""})`);
  }
  console.log("\n⚠️ 滯後係一次抽樣,唔係平均——要睇規律要用rhrread_probe.js跑一段時間。");
  console.log("⚠️ 一個源快唔代表有用:仲要睇個時間戳幾密(密過10分鐘先叫贏1分鐘CSV),");
  console.log("   同埋佢係咪天文台總部(唔係總部就同結算無關)。");

  const unused = results.filter((r) => r.ok && !r.name.startsWith("【用緊】"));
  console.log(`\n通到但我哋未用嘅: ${unused.length ? unused.map((r) => r.name).join("、") : "冇"}`);
  const dead = results.filter((r) => !r.ok);
  console.log(`唔存在/通唔到: ${dead.length ? dead.map((r) => `${r.name}(${r.note})`).join("、") : "冇"}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
