/**
 * daily_log.js
 * ------------------------------------------------------------
 * 用最穩陣嘅方式建立bias校正：自己每日記錄「模型預測 vs 實測結果」。
 *
 * 兩種模式（由GitHub Actions喺唔同時間觸發）：
 *
 *   --mode=forecast   香港時間朝早07:15跑
 *     攞6個模型對「今日」嘅最高溫預測，寫入 forecast_log.csv
 *     （呢個就係你朝早落單嗰陣見到嘅預測，公平比較基準）
 *
 *   --mode=settle     香港時間夜晚23:45跑
 *     攞天文台總部今日實測最高溫，填返落 forecast_log.csv 對應行，
 *     然後用全部已完成嘅記錄重新計算每個模型嘅bias → bias.json
 *
 * 遠程城市擴展（上海ZSPD/北京ZBAA/倫敦EGLC/巴黎LFPB/深圳ZGSZ）：
 *   forecast模式順手記埋各城市當地「今日」嘅6模型預測
 *     → forecast_log_{city}.csv（每城市一個檔,唔郁香港個檔）
 *   settle模式結算各城市當地「昨日」：用METAR過去48小時報文搵當日最高
 *     （揀昨日因為倫敦嗰邊HK 23:45先係下晝,當日未完;結算口徑=METAR整數,
 *       同Polymarket結算源一致）
 *   儲夠7日就寫入bias.json嘅cities key,dashboard/scanner自動轉「已校正」
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const FORECAST_LOG = path.join(__dirname, "forecast_log.csv");
const BIAS_FILE = path.join(__dirname, "bias.json");

const LAT = 22.302, LON = 114.174;
const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const MAXMIN_CSV_URL = "https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv";
const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;
const MIN_SAMPLES = 7; // 至少幾多日數據先出bias

// 遠程城市（結算站=機場,座標同dashboard/scan_cities一致）
const REMOTE_CITIES = {
  shanghai: { icao: "ZSPD", lat: 31.143,  lon: 121.805, tz: "Asia/Shanghai" },
  beijing:  { icao: "ZBAA", lat: 40.080,  lon: 116.585, tz: "Asia/Shanghai" },
  london:   { icao: "EGLC", lat: 51.505,  lon: 0.055,   tz: "Europe/London" }, // 倫敦城市機場(結算站)
  paris:    { icao: "LFPB", lat: 48.9694, lon: 2.4414,  tz: "Europe/Paris" },  // 巴黎布爾歇(結算站)
  shenzhen: { icao: "ZGSZ", lat: 22.639,  lon: 113.811, tz: "Asia/Shanghai" }, // 深圳寶安(跟滬京convention)
};

function hkToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cityLocalDate(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// aviationweather嘅reportTime係"2026-07-16 11:00:00"(UTC但冇Z),
// 直接new Date()會當本地時間——要自己補返個Z
function metarTimeIso(m) {
  if (typeof m.obsTime === "number") return new Date(m.obsTime * 1000).toISOString();
  const t = m.reportTime || m.obsTime;
  if (!t) return null;
  const s = String(t);
  return /Z$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s).toISOString() : new Date(s.replace(" ", "T") + "Z").toISOString();
}

function logFileFor(cityKey) {
  return path.join(__dirname, `forecast_log_${cityKey}.csv`);
}

// ---------- 校準記錄 ----------
// 每朝記低「我哋話某個bucket有幾多%機會」,晚上對返實際邊格中。
// 累積落嚟就答到:「話70%嗰啲,實際係咪真係7成中?」——冇呢個
// feedback loop,所有edge數字都係憑感覺信。
const CALIB_LOG = path.join(__dirname, "calibration_log.csv");
const CALIB_HEADER = "date,bucket,prob,marketPrice,hit";

function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t = 1/(1+p*x);
  return sign * (1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}
function normalCdf(x, mean, std) {
  if (std === 0) return x >= mean ? 1 : 0;
  return 0.5*(1+erf((x-mean)/(std*Math.SQRT2)));
}

function loadCalib() {
  if (!fs.existsSync(CALIB_LOG)) return [];
  return fs.readFileSync(CALIB_LOG, "utf-8").trim().split(/\r?\n/).slice(1)
    .map((line) => {
      const c = line.split(",");
      // 向後兼容:舊格式係 date,bucket,prob,hit (4欄);新格式加咗marketPrice (5欄)
      const [date, bucket, prob] = c;
      const marketPrice = c.length >= 5 ? c[3] : "";
      const hit = c.length >= 5 ? c[4] : c[3];
      return { date, bucket: parseInt(bucket, 10), prob: parseFloat(prob), marketPrice, hit };
    })
    .filter((r) => r.date && !Number.isNaN(r.bucket));
}

function saveCalib(rows) {
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.bucket - b.bucket);
  const lines = [CALIB_HEADER, ...rows.map((r) => `${r.date},${r.bucket},${r.prob.toFixed(4)},${r.marketPrice ?? ""},${r.hit ?? ""}`)];
  fs.writeFileSync(CALIB_LOG, lines.join("\n") + "\n");
}

// 記低今朝個機率分佈(用同dashboard一樣嘅口徑:6模型+bias,未條件化)
// 攞當日香港market每個整數bucket嘅價(用嚟同模型對數)
const CALIB_MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
// ⚠️2026-08-23:呢度本來淨係試slug,一miss就靜靜哋回{}。
// 但 functions/api/polymarket.js(dashboard行嗰條)一早就有個title fallback,
// 佢自己個comment寫住「slug命中唔到→掃weather tag用title配對(應對slug
// 格式唔同嘅城市)」——即係作者早就知slug會miss。兩條路唔同步,
// 結果係dashboard 16:51見到31°C@99¢,但market班16:19乜都攞唔到。
// ⚠️改呢個function嘅時候,functions/api/polymarket.js同netlify嗰份要一齊改。
async function fetchHkMarketPrices(date) {
  const [y, m, d] = date.split("-").map(Number);

  // ⚠️2026-08-26 由真實API response查實:Polymarket個slug**尾有年份**。
  // 08-26嗰次market班個log印返:
  //   slug miss(highest-temperature-in-hong-kong-on-august-26)
  //   tag入面香港嘅event: lowest-temperature-in-hong-kong-on-august-26-2026
  //                                                            ^^^^^ 年份
  // 我哋一路試緊冇年份嗰個,所以由開波到而家一次都冇命中過。
  // 舊market可能真係冇年份,所以兩個都試,有年份嗰個行先。
  const slugs = [
    `highest-temperature-in-hong-kong-on-${CALIB_MONTHS[m - 1]}-${d}-${y}`,
    `highest-temperature-in-hong-kong-on-${CALIB_MONTHS[m - 1]}-${d}`,
  ];

  let ev = null, tried = [];
  for (const slug of slugs) {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!res.ok) { console.log(`  ⚠️ Gamma API ${res.status}(slug=${slug})`); return {}; }
    const hit = (await res.json())?.[0];
    tried.push(slug);
    if (hit) { ev = hit; console.log(`  ℹ️ slug命中: ${slug}`); break; }
  }

  if (!ev) {
    // slug都miss → 掃weather tag用title配對
    // ⚠️同日發現:個API寫limit=200但實際最多回100個,所以一版掃唔晒,
    // 香港個highest-temperature event就係咁被cut走。要分頁。
    const list = [];
    for (let offset = 0; offset < 600; offset += 100) {
      const res2 = await fetch(`https://gamma-api.polymarket.com/events?closed=false&limit=100&offset=${offset}&tag_slug=weather`);
      if (!res2.ok) { console.log(`  ⚠️ slug miss,weather tag offset=${offset} 回 ${res2.status}`); break; }
      const page = await res2.json();
      if (!Array.isArray(page) || !page.length) break;
      list.push(...page);
      if (page.length < 100) break;
    }
    const titleRe = new RegExp(`highest temperature in hong kong on ${CALIB_MONTHS[m - 1]} ${d}\\b`, "i");
    ev = list.find((e) => titleRe.test(e.title || "")) || null;
    if (!ev) {
      // ⚠️唔好淨係講「攞唔到」——分唔清「市場未開」定「slug/title格式變咗」,
      // 就會好似今次咁,一句模糊嘅log拖足一日先查得出。print返證據。
      const hk = list.filter((e) => /hong kong/i.test(e.title || "")).map((e) => e.slug);
      console.log(`  ⚠️ slug都miss(試過: ${tried.join(", ")}),weather tag掃咗${list.length}個event都配唔到title`);
      console.log(hk.length ? `     tag入面香港嘅event: ${hk.slice(0, 8).join(", ")}` : "     tag入面完全冇香港event(可能真係未開盤)");
      return {};
    }
    console.log(`  ℹ️ slug miss,靠title fallback搵到: ${ev.slug}`);
  }

  const out = {};
  for (const mkt of ev.markets || []) {
    const label = (mkt.groupItemTitle || mkt.question || "").trim().toLowerCase();
    // 只要「單一整數」嘅bucket(同校準log嘅bucket對應得返)
    if (/higher|above|below|lower|[-–—]/.test(label)) continue;
    const num = label.match(/(-?\d+)/);
    if (!num) continue;
    try {
      const p = JSON.parse(mkt.outcomePrices || "[]");
      if (p[0] !== undefined) out[parseInt(num[1], 10)] = Math.round(parseFloat(p[0]) * 100);
    } catch { /* ignore */ }
  }
  // 搵到個event但一格都對唔上=bucket label格式變咗,同「未開盤」係兩件事
  if (!Object.keys(out).length) {
    const labels = (ev.markets || []).map((x) => (x.groupItemTitle || x.question || "").trim()).filter(Boolean);
    console.log(`  ⚠️ 搵到event(${ev.slug})但冇一格對得上單一整數bucket`);
    console.log(`     見到嘅label: ${labels.slice(0, 8).join(" | ") || "(冇)"}`);
  }
  return out;
}

async function recordCalibForecast(date, values) {
  const n = values.length;
  if (n < 2) return;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
  const rows = loadCalib().filter((r) => r.date !== date); // 同日重跑就覆蓋

  // ⭐ 同時記低市價:冇呢個你只知「模型準唔準」,唔知「模型有冇贏過市場」。
  // 市場本身都可能過份自信/保守——兩者Brier score對比先答到你有冇edge。
  let prices = {};
  try { prices = await fetchHkMarketPrices(date); } catch (e) { console.log("ℹ️ 市價攞唔到:", e.message); }

  const range = Math.max(4 * std, 3);
  for (let b = Math.floor(mean - range); b < Math.ceil(mean + range); b++) {
    const p = normalCdf(b + 1, mean, std) - normalCdf(b, mean, std);
    if (p >= 0.02) rows.push({ date, bucket: b, prob: p, marketPrice: prices[b] ?? "", hit: "" });
  }
  saveCalib(rows);
  const withPrice = rows.filter((r) => r.date === date && r.marketPrice !== "").length;
  console.log(`✅ 已記錄 ${date} 校準快照(${rows.filter((r) => r.date === date).length}個bucket,${withPrice}個有市價)`);
}

// 對答案:實測max落喺邊格
function settleCalib(date, realized) {
  const rows = loadCalib();
  const todays = rows.filter((r) => r.date === date);
  if (!todays.length) return;
  const hitBucket = Math.floor(realized);
  for (const r of todays) r.hit = r.bucket === hitBucket ? "1" : "0";
  saveCalib(rows);
  const hitRow = todays.find((r) => r.bucket === hitBucket);
  console.log(`✅ ${date} 校準對答案: 實測${realized}° 落喺${hitBucket}°格` +
    (hitRow ? `(當時話${(hitRow.prob * 100).toFixed(0)}%)` : "(當時冇預測呢格!)"));
  reportReliability(rows);
}

// 可靠度表:話X%嘅,實際中幾多%
function reportReliability(rows) {
  const done = rows.filter((r) => r.hit === "1" || r.hit === "0");
  if (done.length < 20) {
    console.log(`ℹ️ 校準樣本${done.length}個(要20個先出可靠度表)`);
    return;
  }
  const bands = [[0, .1], [.1, .25], [.25, .5], [.5, .75], [.75, 1.01]];
  console.log("📊 可靠度(話幾多% → 實際中幾多%):");
  for (const [lo, hi] of bands) {
    const inBand = done.filter((r) => r.prob >= lo && r.prob < hi);
    if (!inBand.length) continue;
    const actual = inBand.filter((r) => r.hit === "1").length / inBand.length;
    const said = inBand.reduce((a, r) => a + r.prob, 0) / inBand.length;
    const gap = actual - said;
    const verdict = Math.abs(gap) < 0.08 ? "✓準" : gap > 0 ? "↑實際高過講(過份保守)" : "↓實際低過講(過份自信)";
    console.log(`  ${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}%: 講${(said*100).toFixed(0)}% 實際${(actual*100).toFixed(0)}% (n=${inBand.length}) ${verdict}`);
  }
  reportVsMarket(done);
}

// ⭐ 模型 vs 市場:邊個估得準?
// 上面個可靠度表只答到「你個模型準唔準」,答唔到「你有冇贏過市場」。
// 市場自己都可能過份自信/保守——如果佢比你準,你就冇model edge,
// 只有鎖定edge(靠已實現事實,唔靠預測)。
// 用Brier score:mean((機率 - 結果)²),越細越準。
function reportVsMarket(done) {
  const paired = done.filter((r) => r.marketPrice !== "" && r.marketPrice !== undefined && !Number.isNaN(parseFloat(r.marketPrice)));
  if (paired.length < 20) {
    console.log(`ℹ️ 模型vs市場對比:得${paired.length}個有市價嘅樣本(要20+)。市價由今日起先開始記。`);
    return;
  }
  let bModel = 0, bMarket = 0;
  for (const r of paired) {
    const outcome = r.hit === "1" ? 1 : 0;
    bModel += (r.prob - outcome) ** 2;
    bMarket += (parseFloat(r.marketPrice) / 100 - outcome) ** 2;
  }
  bModel /= paired.length; bMarket /= paired.length;
  const better = bModel < bMarket;
  const gapPct = Math.abs(bModel - bMarket) / Math.max(bMarket, 1e-9) * 100;

  console.log(`\n🎯 模型 vs 市場(${paired.length}個配對樣本,Brier score越細越準):`);
  console.log(`   模型 ${bModel.toFixed(4)}   市場 ${bMarket.toFixed(4)}`);
  if (gapPct < 3) {
    console.log("   → 打和。模型冇贏過市場——你嘅edge唔喺模型度,");
    console.log("     專心做🔒鎖定(靠已實現事實)就算,唔好花時間調模型。");
  } else if (better) {
    console.log(`   → ✓ 模型贏市場 ${gapPct.toFixed(0)}%。有真model edge,值得繼續調。`);
  } else {
    console.log(`   → ⚠️ 市場贏模型 ${gapPct.toFixed(0)}%。跟模型落注會蝕俾市場,`);
    console.log("     model edge訊號要停,淨做鎖定。");
  }
}

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v];
    })
  );
  return { mode: args.mode };
}

// CSV欄位: date, gfs, ecmwf, icon, ukmo, gem, jma, realized
const HEADER = "date," + MODELS.join(",") + ",realized";

function loadLog(file = FORECAST_LOG) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    const parts = line.split(",");
    const row = { date: parts[0], forecasts: {}, realized: parts[MODELS.length + 1] || "" };
    MODELS.forEach((m, i) => { row.forecasts[m] = parts[i + 1] || ""; });
    return row;
  });
}

function saveLog(rows, file = FORECAST_LOG) {
  rows.sort((a, b) => a.date.localeCompare(b.date)); // settle昨日+forecast今日可能亂序
  const lines = [HEADER];
  for (const r of rows) {
    lines.push([r.date, ...MODELS.map((m) => r.forecasts[m] ?? ""), r.realized ?? ""].join(","));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// 一格有冇真數:空字串同undefined(新建行)都唔算
// ⚠️以前寫 forecasts[m] !== "" ,新建行係undefined會當成有數,
// sampleDays每次settle虛報+1,搞到「1日數據」但其實一個預測都冇
function hasVal(v) { return v !== undefined && v !== null && v !== ""; }

// 由已完成記錄計bias(所有城市共用同一條公式)
function computeBias(rows) {
  const complete = rows.filter((r) => hasVal(r.realized) && MODELS.some((m) => hasVal(r.forecasts[m])));
  const biasMax = {};
  for (const m of MODELS) {
    const diffs = complete
      .filter((r) => hasVal(r.forecasts[m]))
      .map((r) => parseFloat(r.realized) - parseFloat(r.forecasts[m]))
      .filter((d) => !Number.isNaN(d));
    if (diffs.length >= MIN_SAMPLES) {
      biasMax[m] = Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 100) / 100;
    }
  }
  return { sampleDays: complete.length, max: biasMax, ...computeSigmaModel(complete, biasMax) };
}

// σ校準倍數 = 實際誤差標準差 / 模型自己講嘅σ
//
// ⚠️2026-08-08發現:6模型嘅分歧(spread)量度嘅係「模型之間爭議幾多」,
// 唔係「預測有幾唔準」。啲模型share住相似物理同初始場,所以佢哋一致
// 唔代表啱——香港實測 std(z)=3.58,即係真實不確定性係模型σ嘅3.6倍,
// 只有29%結果落喺±1σ內(理論應該68%)。
// 後果:所有bucket機率都過份自信,熱門格買貴、冷門格錯過。
//
// 城市差異好合理:越市區/微氣候複雜嘅結算站,低估得越犀利
//   香港HKO總部(市區山丘)3.58 > 倫敦EGLC 1.92 > 北京1.35 > 上海0.92 > 巴黎0.58
//   模型預測~10km格點平均,唔係一個市區站嘅實況;bias校正到平均偏差,
//   但校正唔到「每日偏差幾多」嘅波動。
//
// ⚠️2026-08-20再發現:淨係「乘個倍數」係錯嘅補救法。香港嘅
//   corr(模型σ, |實際誤差|) = −0.15
// 即係話模型σ喺香港完全冇per-day預測力(仲要輕微負相關)。乘3.4之後:
//   模型σ=0.20嘅日 → 0.68°(仲係過份自信,實際誤差std其實有1.63°)
//   模型σ=1.68嘅日 → 5.7° (個階梯攤到25-34°C,完全冇資訊)
// 等於將噪音放大3.4倍——兩邊都錯,只係錯嘅方向唔同。
//
// 正解:睇corr決定「per-day分歧」同「常數誤差std」各信幾多。
//   σ² = w·(模型σ×scale)² + (1−w)·sigmaAbs² ,  w = clamp(corr, 0, 1)
//   香港 w=0    → 直接用 sigmaAbs 1.63°(常數,唔理當日分歧)
//   上海 w=0.53 → 分歧真係有訊號,一半跟per-day
// 六城corr:上海+0.53 巴黎+0.41 北京+0.21 倫敦+0.20 深圳−0.11 香港−0.15
// 分歧有冇用係逐個城市唔同嘅,唔可以一刀切。
function computeSigmaModel(complete, biasMax) {
  const pts = [];
  for (const r of complete) {
    const vals = [];
    for (const m of MODELS) {
      if (!hasVal(r.forecasts[m])) continue;
      const v = parseFloat(r.forecasts[m]);
      if (!Number.isNaN(v)) vals.push(v + (biasMax[m] || 0));
    }
    if (vals.length < 2) continue;
    const n = vals.length;
    const mu = vals.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1));
    const err = parseFloat(r.realized) - mu;
    if (sd > 0.05 && Number.isFinite(err)) pts.push({ sd, err });
  }
  if (pts.length < MIN_SAMPLES * 2) return {}; // 樣本太少,唔好亂改

  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sdOf = (a) => { const m = avg(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  const corr = (a, b) => {
    const ma = avg(a), mb = avg(b);
    const num = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
    const den = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0));
    return den > 0 ? num / den : 0;
  };
  const r2 = (x) => Math.round(x * 100) / 100;

  const zs = pts.map((p) => p.err / p.sd);
  return {
    // 夾喺合理範圍:太細會過份自信,太大會令個階梯冇資訊
    sigmaScale: r2(Math.min(Math.max(sdOf(zs), 0.8), 4)),
    sigmaAbs: r2(sdOf(pts.map((p) => p.err))),   // 常數σ = 真實誤差標準差
    sigmaWeight: r2(Math.min(Math.max(corr(pts.map((p) => p.sd), pts.map((p) => Math.abs(p.err))), 0), 1)),
  };
}

// ---------- forecast模式 ----------
async function runForecast() {
  const today = hkToday();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max&timezone=auto&models=${MODELS.join(",")}` +
    `&start_date=${today}&end_date=${today}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const rows = loadLog();
  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }

  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) row.forecasts[m] = arr[0].toFixed(1);
  }

  saveLog(rows);
  console.log(`✅ 已記錄 ${today} 嘅模型預測:`, MODELS.map((m) => `${m}=${row.forecasts[m] || "N/A"}`).join(" "));

  // 校準快照:用今朝加咗bias嘅預測(同dashboard口徑一致)
  try {
    const bias = JSON.parse(fs.readFileSync(BIAS_FILE, "utf-8")).max || {};
    const vals = MODELS.filter((m) => row.forecasts[m])
      .map((m) => parseFloat(row.forecasts[m]) + (bias[m] || 0));
    recordCalibForecast(today, vals);
  } catch (e) {
    console.log("⚠️ 校準快照失敗(唔影響其他):", e.message);
  }

  // ---- 遠程城市:記當地「今日」預測(邊個城市fail唔影響其他) ----
  for (const [key, cfg] of Object.entries(REMOTE_CITIES)) {
    try {
      await forecastRemoteCity(key, cfg);
    } catch (e) {
      console.log(`⚠️ ${key} forecast失敗(照繼續): ${e.message}`);
    }
  }
}

async function forecastRemoteCity(key, cfg) {
  const today = cityLocalDate(cfg.tz);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}` +
    `&daily=temperature_2m_max&timezone=${encodeURIComponent(cfg.tz)}&models=${MODELS.join(",")}` +
    `&start_date=${today}&end_date=${today}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();

  const file = logFileFor(key);
  const rows = loadLog(file);
  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }
  for (const m of MODELS) {
    const arr = data.daily?.[`temperature_2m_max_${m}`];
    if (arr && arr[0] != null) row.forecasts[m] = arr[0].toFixed(1);
  }
  saveLog(rows, file);
  console.log(`✅ ${key}(${cfg.icao}) 已記錄 ${today} 預測`);
}

// ---------- settle模式 ----------
async function runSettle() {
  const rows = loadLog();

  // ⚠️保險:GitHub cron延遲可以成80分鐘,22:15排程都可能拖過香港午夜。
  // 過咗午夜嘅話,maxmin CSV已經係「新一日至今」(得凌晨個零鐘嘅假max),
  // 尋日真max已攞唔返——寧願skip香港settle,都唔好寫錯數(2026-07-23實例)
  const hkHour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hkHour >= 12) {
    await settleHk(rows);
  } else {
    console.log(`⚠️ 延遲跨咗香港午夜(HK ${hkHour}點),maxmin CSV得新一日凌晨數據,skip香港settle`);
  }

  await settleAndWriteBias(rows);
}

async function settleHk(rows) {
  const today = hkToday();
  const res = await fetch(MAXMIN_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`maxmin CSV ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/).slice(1);

  let realized = null;
  for (const line of lines) {
    const parts = line.split(",").map((s) => s.trim());
    if (STATION_PATTERN.test(parts[1])) { realized = parseFloat(parts[2]); break; }
  }
  if (realized === null || Number.isNaN(realized)) throw new Error("攞唔到今日實測最高溫");

  let row = rows.find((r) => r.date === today);
  if (!row) { row = { date: today, forecasts: {}, realized: "" }; rows.push(row); }
  row.realized = realized.toFixed(1);
  saveLog(rows);
  console.log(`✅ 已記錄 ${today} 實測最高溫: ${realized.toFixed(1)}°C`);

  try {
    settleCalib(today, realized);
  } catch (e) {
    console.log("⚠️ 校準對答案失敗(唔影響其他):", e.message);
  }

  // 順手記低VHHH當日最高,累積「機場vs總部」楔子數據。
  // 用途:市場跟住VHHH郁(快6-16分鐘),但結算跟HKO總部——
  // 兩者分歧嗰陣就係「市場以為鎖咗但實際冇」(伏)或者
  // 「實際鎖咗但市場未知」(機會)。station_wedge.js做分析。
  try {
    await recordStationWedge(today, realized);
  } catch (e) {
    console.log("⚠️ 站點楔子記錄失敗(唔影響其他):", e.message);
  }
}

const WEDGE_LOG = path.join(__dirname, "station_wedge.csv");

async function recordStationWedge(date, hkoMax) {
  const res = await fetch("https://aviationweather.gov/api/data/metar?ids=VHHH&format=json&hours=26");
  if (!res.ok) throw new Error(`METAR ${res.status}`);
  let vhhhMax = null;
  for (const m of (await res.json()) ?? []) {
    if (typeof m.temp !== "number") continue;
    const iso = metarTimeIso(m);
    if (!iso || cityLocalDate("Asia/Hong_Kong", new Date(iso)) !== date) continue;
    if (vhhhMax === null || m.temp > vhhhMax) vhhhMax = m.temp;
  }
  if (vhhhMax === null) { console.log("ℹ️ 今日冇VHHH報文,楔子跳過"); return; }

  const rows = {};
  if (fs.existsSync(WEDGE_LOG)) {
    for (const line of fs.readFileSync(WEDGE_LOG, "utf-8").trim().split(/\r?\n/).slice(1)) {
      const [d, h, v] = line.split(",");
      if (d) rows[d] = { hko: h, vhhh: v };
    }
  }
  rows[date] = { hko: hkoMax.toFixed(1), vhhh: String(vhhhMax) };
  const lines = ["date,hkoMax,vhhhMax", ...Object.keys(rows).sort().map((d) => `${d},${rows[d].hko},${rows[d].vhhh}`)];
  fs.writeFileSync(WEDGE_LOG, lines.join("\n") + "\n");
  const diff = vhhhMax - hkoMax;
  console.log(`✅ 站點楔子 ${date}: HKO ${hkoMax.toFixed(1)}° vs VHHH ${vhhhMax}° (差${diff>=0?"+":""}${diff.toFixed(1)}°)`);
}

// 遠程城市settle+寫bias.json——就算香港嗰part被skip都照做
// (遠程城市結算「當地昨日」用METAR 48hr報文,延遲跨午夜都攞得返正確數據)
async function settleAndWriteBias(rows) {
  // ---- 遠程城市:結算當地「昨日」+計bias ----
  // 讀返舊bias.json,邊個城市今次fail就保留佢上次嘅值
  let oldBias = {};
  try { oldBias = JSON.parse(fs.readFileSync(BIAS_FILE, "utf-8")); } catch { /* 冇就算 */ }
  const cities = { ...(oldBias.cities || {}) };
  for (const [key, cfg] of Object.entries(REMOTE_CITIES)) {
    try {
      const fresh = await settleRemoteCity(key, cfg);
      // σ校準未夠樣本會回空(computeSigmaModel要20個z)。噉嘅話保留上次量到嘅值,
      // 唔好靜靜哋倒退返做「未校準」——樣本數會因為某日缺數而上落。
      const prev = cities[key] || {};
      for (const k of ["sigmaScale", "sigmaAbs", "sigmaWeight"]) {
        if (fresh[k] == null && prev[k] != null) fresh[k] = prev[k];
      }
      cities[key] = fresh;
    } catch (e) {
      console.log(`⚠️ ${key} settle失敗(保留舊bias): ${e.message}`);
    }
  }

  // ---- 重新計算香港bias ----
  const hk = computeBias(rows);

  const output = {
    generatedAt: new Date().toISOString(),
    sampleDays: hk.sampleDays,
    note: "bias = mean(實測 - 模型預測)，正數代表模型低估。由daily_log.js自動產生。max=香港(HKO總部);cities=遠程城市(結算口徑=機場METAR整數)。",
    max: hk.max,
    // ⚠️2026-08-20:computeBias一直有計香港嘅sigmaScale,但呢個output object
    // 冇寫落去,所以5個遠程城市全部有σ校準,得香港——即係你真係落注嗰個——
    // 冇。dashboard讀唔到就當1,個階梯繼續過份自信(29°C成79%)。
    // 今次跑完應該係3.4左右(std(z)=3.40,只有26%落喺±1σ內)。
    // 樣本未夠computeSigmaModel會回空,嗰陣保留上次個值,唔好倒退返做1。
    sigmaScale: hk.sigmaScale ?? oldBias.sigmaScale ?? null,
    sigmaAbs: hk.sigmaAbs ?? oldBias.sigmaAbs ?? null,
    sigmaWeight: hk.sigmaWeight ?? oldBias.sigmaWeight ?? null,
    min: {}, // 暫時只做max（Polymarket香港市場以最高溫為主）
    cities,
  };
  fs.writeFileSync(BIAS_FILE, JSON.stringify(output, null, 2));

  if (Object.keys(hk.max).length === 0) {
    console.log(`ℹ️ 香港數據仲未夠${MIN_SAMPLES}日，bias暫時空（而家有${hk.sampleDays}日）。繼續累積。`);
  } else {
    console.log("✅ bias.json已更新(香港):");
    Object.entries(hk.max).forEach(([m, b]) => console.log(`  ${m.padEnd(18)}: ${b >= 0 ? "+" : ""}${b}°C`));
    console.log(`  σ校準: 常數${output.sigmaAbs ?? "?"}° · 倍數${output.sigmaScale ?? "?"} · per-day權重${output.sigmaWeight ?? "?"}`);
  }
  for (const [key, c] of Object.entries(cities)) {
    const n = Object.keys(c.max || {}).length;
    console.log(`  ${key}: ${c.sampleDays}日數據${n ? `,${n}個模型有bias` : `(未夠${MIN_SAMPLES}日,未出bias)`}`);
  }
}

// 結算一個遠程城市當地「昨日」嘅METAR最高溫,回傳最新bias
async function settleRemoteCity(key, cfg) {
  const target = cityLocalDate(cfg.tz, new Date(Date.now() - 24 * 3600 * 1000));
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${cfg.icao}&format=json&hours=48`);
  if (!res.ok) throw new Error(`METAR API ${res.status}`);
  const arr = await res.json();

  let maxT = null;
  for (const m of Array.isArray(arr) ? arr : []) {
    if (typeof m.temp !== "number") continue;
    const iso = metarTimeIso(m);
    if (!iso || cityLocalDate(cfg.tz, new Date(iso)) !== target) continue;
    if (maxT === null || m.temp > maxT) maxT = m.temp;
  }
  if (maxT === null) throw new Error(`搵唔到${target}嘅${cfg.icao} METAR`);

  const file = logFileFor(key);
  const rows = loadLog(file);
  let row = rows.find((r) => r.date === target);
  if (!row) { row = { date: target, forecasts: {}, realized: "" }; rows.push(row); }
  row.realized = String(maxT);
  saveLog(rows, file);
  console.log(`✅ ${key}(${cfg.icao}) 已結算 ${target} 實測最高: ${maxT}°C`);

  return computeBias(rows);
}

// ---------- market模式:補返今日嘅市價 ----------
//
// ⚠️2026-08-22發現:市價欄開咗10日,一格都冇記到(92行全部空白)。
// 原因係 recordCalibForecast 喺 forecast 班跑,即係香港07:15——
// 但香港market通常當日下晝先開盤(dashboard自己都寫住「聽日market未開
// (通常當日下晝先開盤)」)。7點鐘去攞,個event根本未存在,永遠攞唔到。
// 所以「模型vs市場」呢個對比由開波嗰日起就係死嘅,而冇任何錯誤訊息。
//
// 做法:另開一班喺香港下晝跑,淨係填返今日仲係空白嗰啲格。
// 已經有價嘅唔會覆蓋——要保住「最早攞到嗰個報價」,愈早嘅報價
// 資訊優勢愈細,同模型(07:15出)比先公道。
// 攞市價太夜 = 攞緊個已經知道答案嘅價,唔可以攞嚟同模型比
// ⚠️2026-08-26實測:22:55 HKT手動跑一次,成功攞到價,但攞返嚟係
//   29°C=100¢(結果:中)  30°C=0¢  31°C=0¢
// 香港14-15時就見頂,夜晚個market已經收晒窄。呢啲數放入Brier對比
// 就係送分俾市場——「市場100%啱」只係因為佢當時已經睇到答案,
// 唔係佢預測叻。個對比會得出「市場贏晒模型」嘅假結論。
// 排程本身係13/15/16點,唔會撞到;呢個掣係防手動觸發同cron大延遲。
const MARKET_CUTOFF_HK_HOUR = 17;

async function runMarketSnapshot() {
  const date = hkToday();
  const hkHour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hkHour >= MARKET_CUTOFF_HK_HOUR || hkHour < 6) {
    console.log(`⏭️ 而家香港${hkHour}點,過咗${MARKET_CUTOFF_HK_HOUR}點就唔記市價——`);
    console.log("   高溫早就見頂,個價已經接近結算價,記落去會令「模型vs市場」對比失真。");
    return;
  }
  const rows = loadCalib();
  const todays = rows.filter((r) => r.date === date);
  if (!todays.length) { console.log(`ℹ️ ${date} 未有校準快照,冇嘢好補(forecast班未跑?)`); return; }

  const blank = todays.filter((r) => r.marketPrice === "" || r.marketPrice === undefined);
  if (!blank.length) { console.log(`✓ ${date} ${todays.length}個bucket已經全部有市價`); return; }

  const prices = await fetchHkMarketPrices(date);
  if (!Object.keys(prices).length) { console.log(`ℹ️ ${date} market未開盤/攞唔到價,下一班再試`); return; }

  let filled = 0;
  for (const r of blank) {
    if (prices[r.bucket] !== undefined) { r.marketPrice = prices[r.bucket]; filled++; }
  }
  if (!filled) { console.log(`ℹ️ market有開,但冇一格對得上(bucket格式變咗?)`); return; }
  saveCalib(rows);
  console.log(`✅ ${date} 補到 ${filled}/${blank.length} 個bucket嘅市價`);
}

async function main() {
  const { mode } = parseArgs();
  if (mode === "forecast") await runForecast();
  else if (mode === "settle") await runSettle();
  else if (mode === "market") await runMarketSnapshot();
  else throw new Error("要指定 --mode=forecast / settle / market");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
