/**
 * rhrread_probe.js
 * ------------------------------------------------------------
 * 量度「快水喉」(rhrread) 真正幾耐更新一次、幾點出、幾時會冇咗。
 *
 * 點解要量:
 *   用戶發現個edge——整點快水喉出咗整數溫度,市場未反應得切,
 *   可以早買、08分放。但「有時無send出嚟」。
 *   而家個repo入面**冇任何嘢記錄過rhrread嘅更新時間**:
 *     history.csv 記嘅係慢水喉(latest_1min_temperature.csv)嘅recordTime
 *     alert_state.json 淨係存alert狀態,冇時間
 *   即係「幾耐更新一次」呢條問題,而家係答唔到嘅。要量先知。
 *
 * 量乜:
 *   ① recordTime 每次跳幾多分鐘(真cadence,唔係靠估「10分鐘」)
 *   ② 每次更新落喺個鐘嘅第幾分鐘(用戶話「整點」,驗下係咪)
 *   ③ 滯後 = 我哋見到嗰刻 − recordTime(即係你實際幾快知道)
 *   ④ 有冇slot跳咗(「有時無send出嚟」量化返)
 *   ⑤ 整數值幾時變(呢個先係可以落注嗰下)
 *
 * ⚠️呢個係純觀察,唔會改任何檔案、唔會落單、唔會send通知。
 *
 * 用法:
 *   node rhrread_probe.js                    # 預設跑65分鐘,每15秒poll一次
 *   node rhrread_probe.js --minutes=20
 *   node rhrread_probe.js --interval=10      # poll間隔(秒)
 * ------------------------------------------------------------
 */

const RHRREAD_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc";
const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : dflt;
}

const MINUTES = arg("minutes", 65);
const INTERVAL_S = arg("interval", 15);

const hk = (d) => new Date(d.getTime() + 8 * 3600e3);
const hhmmss = (d) => hk(d).toISOString().slice(11, 19);

async function poll() {
  const t0 = Date.now();
  try {
    const res = await fetch(RHRREAD_URL, { cache: "no-store" });
    if (!res.ok) return { at: new Date(), err: `HTTP ${res.status}`, ms: Date.now() - t0 };
    const j = await res.json();
    const st = (j.temperature?.data ?? []).find((d) => STATION_PATTERN.test(String(d.place).trim()));
    if (!st) return { at: new Date(), err: "回應冇香港天文台總部呢個站", ms: Date.now() - t0 };
    return {
      at: new Date(),
      ms: Date.now() - t0,
      value: Number(st.value),
      unit: st.unit ?? null,
      recordTime: j.temperature?.recordTime ?? null,
    };
  } catch (e) {
    return { at: new Date(), err: e.message || "連唔到", ms: Date.now() - t0 };
  }
}

// ============================================================
// ⚠️2026-09-09加:AWS-GIS檔 vs 1分鐘CSV 對賽。
//
// 由來:用戶11:48撳「更新」,個數企喺11:30,但天文台自己個
// 「分區天氣資訊平台」站頁同一刻已經係11:40。爬咗3輪先掘到個平台
// 真正食緊邊條線——喺 irwip-map-config.js 入面:
//   https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt
// 格式(12:04:50香港時間實測):
//   Latest readings recorded at 11:50 Hong Kong Time 9 September 2026
//   STN,WINDDIRECTION,WINDSPEED,GUST,TEMP,RH,MAXTEMP,MINTEMP,…
//   HKO,,,,30.5,64,30.7,27.5,…      ← 總部,結算站
//   HKA,90,15,24,32.0,54,32.3,27.4,… ← 赤鱲角
//
// ⚠️嗰次單次抽樣:AWS戳11:50、CSV嗰陣都係11:50 —— **打和,冇證明佢快**。
// 用戶11:48見到嘅一步之差,好可能只係踩正到貨界線。
// 所以呢度唔靠抽樣,靠「邊個先見到同一個戳」嚟分勝負。
// ============================================================
const AWS_URL = "https://www.hko.gov.hk/wxinfo/awsgis/latestReadings_AWS1_v2.txt";
const CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv";
// ⚠️2026-09-13搵到:天文台首頁自己食嗰條(由old_index.js掘出嚟)。
// 格式:{"fields":["region","temp","rh",...,"maxtemp","mintemp",...],
//        "btime":"202609131220","datas":[["hko","30.1","68",...]]}
// 好處:溫度同今日max/min都有小數、btime係完整YYYYMMDDHHMM(冇歧義)、
//      一個3.6KB檔有齊全港站。頂到我哋而家兩個CSV。
// ⚠️但快唔快未證實——單次抽樣同CSV一樣係12:20。所以擺入race度量。
const REGION_URL = "https://www.hko.gov.hk/wxinfo/json/region.json";

async function pollAws() {
  try {
    const res = await fetch(AWS_URL, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return { err: `HTTP ${res.status}` };
    const body = await res.text();
    const m = body.match(/recorded at\s+(\d{1,2}):(\d{2})/i);
    if (!m) return { err: "讀唔到個標題時間" };
    const row = body.split(/\r?\n/).find((l) => /^HKO,/.test(l.trim()));
    if (!row) return { err: "冇HKO嗰行" };
    const c = row.split(",");
    return {
      stamp: `${m[1].padStart(2, "0")}:${m[2]}`,
      temp: parseFloat(c[4]), max: parseFloat(c[6]), min: parseFloat(c[7]),
    };
  } catch (e) { return { err: e.message }; }
}

async function pollRegion() {
  try {
    const res = await fetch(REGION_URL, { cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.hko.gov.hk/" } });
    if (!res.ok) return { err: `HTTP ${res.status}` };
    const j = await res.json();
    const f = j.fields || [];
    const iT = f.indexOf("temp"), iRh = f.indexOf("rh"), iMax = f.indexOf("maxtemp");
    const row = (j.datas || []).find((r) => String(r[0]).toLowerCase() === "hko");
    if (!row) return { err: `冇hko嗰行(有${(j.datas || []).length}個站)` };
    const b = String(j.btime || "");
    if (!/^\d{12}$/.test(b)) return { err: `btime唔係12位: ${JSON.stringify(j.btime)}` };
    return { stamp: `${b.slice(8, 10)}:${b.slice(10, 12)}`,
      temp: parseFloat(row[iT]), rh: row[iRh], max: parseFloat(row[iMax]) };
  } catch (e) { return { err: e.message }; }
}

// ⚠️2026-09-09白行咗一次45分鐘race先發現:我自己另外寫咗個
// /香港天文台|Hong Kong Observatory/ 去match,但個CSV實際寫嘅係
// **"HK Observatory"** —— 128次poll全部「冇總部嗰行」,race出唔到結果。
// 呢個檔上面本身一早有個啱嘅STATION_PATTERN,我連佢都冇用,自己重寫多個。
// 所以而家用返上面嗰個,唔好再有第二份。
async function pollCsv() {
  try {
    const res = await fetch(CSV_URL, { cache: "no-store" });
    if (!res.ok) return { err: `HTTP ${res.status}` };
    const lines = (await res.text()).trim().split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const [ts, place, t] = line.split(",").map((s) => s.trim());
      if (STATION_PATTERN.test(place)) {
        return { stamp: `${ts.slice(8, 10)}:${ts.slice(10, 12)}`, temp: parseFloat(t) };
      }
    }
    // ⚠️分唔清「個站改咗名」同「個檔壞咗」就等於冇log——print返證據,
    // 唔好again白行45分鐘先知。
    return { err: `冇總部嗰行(共${lines.length}行,頭3個站名: ${lines.slice(1, 4).map((l) => l.split(",")[1]).join(" / ")})` };
  } catch (e) { return { err: e.message }; }
}

// 邊個先見到同一個戳 = 邊個快。呢個先係公平比較,
// 單次抽樣「而家幾舊」會被10分鐘一格嘅grid放大成假差距。
function raceReport(firstSeen) {
  console.log("\n" + "═".repeat(64));
  console.log("🏁 邊個先攞到同一個觀測(戳) — 全部同1分鐘CSV比");
  console.log("═".repeat(64));
  // 每條源同CSV比:負數 = 比CSV慢,正數 = 快
  for (const [key, name] of [["aws", "AWS-GIS檔"], ["rgn", "region.json(首頁源)"]]) {
    const both = [...firstSeen[key].keys()].filter((s) => firstSeen.csv.has(s)).sort();
    console.log(`\n── ${name} vs 1分鐘CSV`);
    if (!both.length) { console.log("   兩邊都見過嘅戳唔夠,跑耐啲(--minutes=45)"); continue; }
    const diffs = [];
    for (const s of both) {
      const a = firstSeen[key].get(s), c = firstSeen.csv.get(s);
      const d = (c - a) / 60000;
      diffs.push(d);
      console.log(`   戳${s}  佢${hhmmss(new Date(a))}  CSV${hhmmss(new Date(c))}  ${d >= 0 ? "+" : ""}${d.toFixed(1)}分`);
    }
    diffs.sort((x, y) => x - y);
    const med = diffs[Math.floor(diffs.length / 2)];
    console.log(`   n=${diffs.length} 中位 ${med >= 0 ? "+" : ""}${med.toFixed(1)}分 → ` +
      (diffs.length < 5 ? "⚠️樣本唔夠,唔好落結論"
        : med > 0.5 ? `真係快${med.toFixed(1)}分,值得換`
        : med < -0.5 ? "反而慢,唔好換" : "打和,換咗冇著數"));
  }
}

function summarise(updates, errors, polls) {
  console.log(`\n${"═".repeat(64)}`);
  console.log("📊 快水喉 (rhrread) 更新規律");
  console.log("═".repeat(64));
  console.log(`poll咗 ${polls} 次,見到 ${updates.length} 次更新,${errors} 次攞唔到`);

  if (updates.length < 2) {
    console.log("\n更新次數太少,跑耐啲先有結論(--minutes=120)。");
    return;
  }

  // ① cadence:recordTime之間隔幾耐
  console.log("\n① recordTime 之間隔幾耐");
  const gaps = [];
  for (let i = 1; i < updates.length; i++) {
    const a = Date.parse(updates[i - 1].recordTime), b = Date.parse(updates[i].recordTime);
    if (Number.isFinite(a) && Number.isFinite(b)) gaps.push(Math.round((b - a) / 60000));
  }
  const tally = {};
  for (const g of gaps) tally[g] = (tally[g] || 0) + 1;
  for (const g of Object.keys(tally).map(Number).sort((a, b) => a - b)) {
    console.log(`   ${String(g).padStart(3)}分鐘: ${"█".repeat(tally[g])} ${tally[g]}次`);
  }
  const usual = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  console.log(`   → 最常見 ${usual[0]}分鐘`);
  const skipped = gaps.filter((g) => g > Number(usual[0]) * 1.5);
  console.log(skipped.length
    ? `   ⚠️ 有 ${skipped.length} 次隔得特別耐 (${skipped.join(", ")}分鐘) ← 「有時無send」就係呢啲`
    : `   ✓ 冇跳過slot`);

  // ② 落喺個鐘第幾分鐘
  console.log("\n② recordTime 落喺個鐘嘅第幾分鐘");
  const mins = updates.map((u) => new Date(u.recordTime).getMinutes()).filter((m) => !Number.isNaN(m));
  const mt = {};
  for (const m of mins) mt[m] = (mt[m] || 0) + 1;
  console.log("   " + Object.keys(mt).map(Number).sort((a, b) => a - b).map((m) => `${m}分×${mt[m]}`).join("  "));

  // ③ 滯後:見到嗰刻 − recordTime。呢個先係「你實際幾快知」
  console.log("\n③ 滯後(我哋見到 − recordTime)");
  const lags = updates.map((u) => (u.at.getTime() - Date.parse(u.recordTime)) / 60000).filter(Number.isFinite);
  if (lags.length) {
    const s = [...lags].sort((a, b) => a - b);
    console.log(`   最快 ${s[0].toFixed(1)}分  中位 ${s[Math.floor(s.length / 2)].toFixed(1)}分  最慢 ${s[s.length - 1].toFixed(1)}分`);
    console.log(`   ⚠️ 呢個已經包咗我哋個poll間隔(${INTERVAL_S}秒),真實發佈滯後仲細少少`);
  }

  // ④ 值幾時真係變——冇變嘅更新對落注冇用
  console.log("\n④ 整數值變咗幾多次(冇變嗰啲更新落唔到注)");
  let changes = 0;
  for (let i = 1; i < updates.length; i++) if (updates[i].value !== updates[i - 1].value) changes++;
  console.log(`   ${updates.length}次更新入面,得 ${changes} 次個整數真係變咗`);
  console.log(`   → 「每次更新都通知」會收到 ${updates.length} 次,但得 ${changes} 次有新資訊`);

  console.log("\n⑤ 逐次更新明細");
  console.log("   香港時間見到    recordTime        溫度   滯後");
  for (const u of updates) {
    const lag = (u.at.getTime() - Date.parse(u.recordTime)) / 60000;
    console.log(`   ${hhmmss(u.at)}       ${String(u.recordTime).slice(11, 16)}             ${String(u.value).padStart(3)}°   ${Number.isFinite(lag) ? lag.toFixed(1) + "分" : "?"}`);
  }
}

async function main() {
  console.log("═".repeat(64));
  console.log(`快水喉探測:跑 ${MINUTES} 分鐘,每 ${INTERVAL_S} 秒poll一次`);
  console.log(`開始 香港時間 ${hhmmss(new Date())}`);
  console.log("═".repeat(64));

  const until = Date.now() + MINUTES * 60e3;
  const updates = [];
  let polls = 0, errors = 0, lastRecordTime = null;

  const firstSeen = { aws: new Map(), csv: new Map(), rgn: new Map() };
  const seeStamp = (src, stamp, extra) => {
    if (!stamp || firstSeen[src].has(stamp)) return;
    firstSeen[src].set(stamp, Date.now());
    console.log(`${hhmmss(new Date())} 🏁 ${src.toUpperCase().padEnd(3)} 見到戳 ${stamp}  ${extra}`);
  };

  while (Date.now() < until) {
    const [r, aws, csv, rgn] = await Promise.all([poll(), pollAws(), pollCsv(), pollRegion()]);
    polls++;
    if (rgn.err) console.log(`${hhmmss(new Date())} ⚠️ region.json: ${rgn.err}`);
    else seeStamp("rgn", rgn.stamp, `${rgn.temp}° rh${rgn.rh} max${rgn.max}`);
    if (aws.err) console.log(`${hhmmss(new Date())} ⚠️ AWS: ${aws.err}`);
    else seeStamp("aws", aws.stamp, `${aws.temp}° max${aws.max}`);
    if (csv.err) console.log(`${hhmmss(new Date())} ⚠️ CSV: ${csv.err}`);
    else seeStamp("csv", csv.stamp, `${csv.temp}°`);
    if (r.err) {
      errors++;
      console.log(`${hhmmss(r.at)} ⚠️ ${r.err}`);
    } else if (r.recordTime !== lastRecordTime) {
      // 第一次唔算「更新」(只係我哋啱啱開始睇),但要記低做基準
      if (lastRecordTime !== null) {
        const lag = (r.at.getTime() - Date.parse(r.recordTime)) / 60000;
        console.log(`${hhmmss(r.at)} 🔔 更新 recordTime=${String(r.recordTime).slice(11, 16)} ${r.value}°C 滯後${Number.isFinite(lag) ? lag.toFixed(1) : "?"}分`);
      } else {
        console.log(`${hhmmss(r.at)} ── 開始:recordTime=${String(r.recordTime).slice(11, 16)} ${r.value}°C`);
      }
      updates.push(r);
      lastRecordTime = r.recordTime;
    }
    const wait = Math.min(INTERVAL_S * 1000, until - Date.now());
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }

  // 第一筆係基準唔係更新,唔計入cadence
  summarise(updates.slice(1).length ? updates : [], errors, polls);
  raceReport(firstSeen);
  console.log(`\n完 香港時間 ${hhmmss(new Date())}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
