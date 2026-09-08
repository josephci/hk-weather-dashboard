/**
 * nightly_check.js
 * ------------------------------------------------------------
 * 每晚健康檢查(GitHub Actions跑,香港時間22:10),結果推Telegram。
 * 完全唔依賴Claude session——用戶上唔上線都會run。
 *
 * 檢查項目:
 *   1. GitHub Actions過去26hr有冇workflow fail
 *   2. 四個遠程城市嘅bias累積有冇停滯(forecast_log_{city}.csv最新行日期)
 *   3. main有冇再俾「chore: temp log」污染(data branch遷移生效咗未)
 *   4. data branch有冇正常更新緊(temp-alerts線係咪生存)
 *
 * 環境變數: GITHUB_TOKEN(list runs用), GITHUB_REPOSITORY,
 *           TG_BOT_TOKEN, TG_CHAT_ID(冇就淨print唔推送)
 * ------------------------------------------------------------
 */

const { execSync } = require("child_process");
const fs = require("fs");

const CITIES = ["shanghai", "beijing", "london", "paris", "shenzhen"];

function sh(cmd) {
  return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

async function checkWorkflowRuns(problems, notes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || "josephci/hk-weather-dashboard";
  if (!token) { notes.push("冇GITHUB_TOKEN,跳過workflow檢查"); return; }
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=50`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) { notes.push(`workflow API ${res.status},跳過`); return; }
  const { workflow_runs } = await res.json();
  const recent = (workflow_runs || []).filter((r) => Date.now() - new Date(r.created_at) < 26 * 3600e3);
  const failsByName = {};
  for (const r of recent) {
    if (r.conclusion === "failure") failsByName[r.name] = (failsByName[r.name] || 0) + 1;
  }
  for (const [name, n] of Object.entries(failsByName)) {
    problems.push(`Actions「${name}」過去26hr fail咗${n}次`);
  }
  notes.push(`過去26hr ${recent.length}個run,${Object.values(failsByName).reduce((a, b) => a + b, 0)}個fail`);
}

// 一個log檔近兩日有冇「有預測」嘅行——2026-07實戰教訓:settle正常跑緊
// 但朝早forecast全部錯行settle,行行得realized冇模型欄,bias永遠唔會增長,
// 齋睇「最新行日期」係驗唔出嘅
function recentForecastOk(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).slice(1);
  const cutoff = Date.now() - 2 * 86400e3;
  let sawRecent = false;
  for (const line of lines.slice(-5)) {
    const cols = line.split(",");
    if (new Date(cols[0] + "T00:00:00Z").getTime() < cutoff) continue;
    sawRecent = true;
    if (cols.slice(1, 7).some((v) => v !== "")) return true; // 近兩日有行有預測
  }
  return sawRecent ? false : null; // false=有近行但全冇預測;null=根本冇近行
}

// 反方向:有模型預測但冇realized = settle冇跑到。
// 2026-08-03至05就係咁:cron延遲2小時衝過香港午夜,保險掣skip咗香港settle,
// 連續3日靜靜雞失敗。第一版健康檢查只查一個方向,所以捉唔到。
//
// ⚠️容忍度要留2日:遠程城市結算「當地昨日」,倫敦巴黎喺settle跑嗰陣
// 當日仲未完,正常會遲一日;加上cron延遲可能跑喺呢個檢查之後。
// 所以只當「2日前或更早」嘅行都仲未settle先當有問題。
function recentRealizedOk(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).slice(1);
  const nowHk = Date.now() + 8 * 3600e3;
  const graceMs = 2 * 86400e3;   // 今日+尋日唔計
  const windowMs = 5 * 86400e3;  // 太舊嘅唔理(可能係歷史遺留)
  // ⚠️由新到舊掃,只睇「最新一行可檢查嘅」——由舊到新嘅話,
  // 一撞到舊嘅好行就會即刻return正常,掩蓋咗新嘅壞行(自我檢查時中過招)
  for (const line of lines.slice(-6).reverse()) {
    const cols = line.split(",");
    const t = new Date(cols[0] + "T00:00:00Z").getTime();
    const age = nowHk - t;
    if (age < graceMs || age > windowMs) continue;
    if (!cols.slice(1, 7).some((v) => v !== "")) continue; // 冇預測嘅行唔喺呢度查
    return cols[7] !== "" && cols[7] !== undefined;
  }
  return null;
}

function checkBiasProgress(problems, cityLines) {
  let bias = {};
  try { bias = JSON.parse(fs.readFileSync("bias.json", "utf-8")); } catch { /* 冇就空 */ }

  if (recentForecastOk("forecast_log.csv") === false) {
    problems.push("香港近兩日有realized但冇模型預測——朝早forecast班可能錯咗mode/死咗");
  }
  if (recentRealizedOk("forecast_log.csv") === false) {
    // ⚠️2026-09-02:settle skip咗而家有後路(backfillHkRealized攞CLMMAXT官方數補返),
    // 所以行到呢度即係「當日settle skip咗**而且**backfill都補唔到」——
    // 唔好再叫人淨係去查cron,要分埋CLMMAXT嗰邊。
    problems.push("香港近兩日有模型預測但冇realized——settle skip咗(cron延遲衝過香港午夜)而且CLMMAXT backfill都補唔返,開Actions睇settle班個log");
  }

  for (const c of CITIES) {
    const cb = bias.cities?.[c];
    const file = `forecast_log_${c}.csv`;
    let lastDate = null;
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf-8").trim().split(/\r?\n/);
      if (lines.length > 1) lastDate = lines[lines.length - 1].split(",")[0];
    }
    const days = cb?.sampleDays ?? 0;
    const hasBias = Object.keys(cb?.max || {}).length > 0;
    cityLines.push(`${c}: ${days}日${hasBias ? " ✓已出bias" : days >= 1 ? `(仲爭${Math.max(0, 7 - days)}日)` : ""}${lastDate ? "" : " ⚠未有log"}`);
    if (!lastDate) {
      problems.push(`${c}未有forecast_log檔(daily_log未跑過?改動未merge入main?)`);
    } else if ((Date.now() - new Date(lastDate + "T00:00:00Z")) / 86400e3 > 2.5) {
      problems.push(`${c}嘅log停咗喺${lastDate},bias累積斷咗`);
    } else if (recentForecastOk(file) === false) {
      problems.push(`${c}近兩日得realized冇模型預測,bias唔會增長——查朝早forecast班`);
    } else if (recentRealizedOk(file) === false) {
      problems.push(`${c}近兩日得預測冇realized,bias唔會增長——查晚上settle班`);
    }
  }
}

// feedback loop健康:呢兩樣壞咗係唔會有錯誤訊息嘅,dashboard只會靜靜哋
// 顯示「累積緊」或者照用一個過份自信嘅σ。2026-08-20兩樣同時中招:
//   ① daily_log calibration_log加咗marketPrice欄,index.html仲讀住舊第4欄
//      → 45個已結算樣本全部filter走,可靠度表變0
//   ② bias.json一直冇寫香港嘅sigmaScale(5個遠程城市有,香港冇)
//      → 香港階梯冇放闊σ,29°C照報79%
// 所以呢度直接驗「dashboard會讀到啲乜」,唔係淨係驗個檔存唔存在。
function checkFeedbackLoop(problems, notes) {
  try {
    const lines = fs.readFileSync("calibration_log.csv", "utf-8").trim().split(/\r?\n/);
    const header = (lines[0] || "").split(",");
    const body = lines.slice(1).filter(Boolean);
    // 照index.html嘅規矩讀:5欄攞第5,4欄攞第4
    const settled = body.filter((l) => {
      const c = l.split(",");
      const hit = (c.length >= 5 ? c[4] : c[3] || "").trim();
      return hit === "0" || hit === "1";
    }).length;
    if (header[header.length - 1] !== "hit") {
      problems.push(`calibration_log最後一欄係「${header[header.length - 1]}」唔係hit——index.html讀唔到,可靠度表會變0`);
    } else if (body.length >= 25 && settled === 0) {
      problems.push(`calibration_log有${body.length}行但一個已結算樣本都讀唔到——settle冇填hit,可靠度表死咗`);
    } else {
      notes.push(`可靠度樣本 ${settled}個(${body.length}行)`);
    }

    // 市價欄有冇真係入到數。2026-08-22:呢欄開咗10日,92行一格都冇記到——
    // 因為去攞價嗰班喺香港07:15跑,但香港market下晝先開盤。
    // 冇錯誤訊息、個log照寫、「模型vs市場」就係永遠出唔到。
    const wide = body.filter((l) => l.split(",").length >= 5);
    if (wide.length >= 25) {
      const withPrice = wide.filter((l) => (l.split(",")[3] || "").trim() !== "").length;
      const recent = wide.slice(-30);
      const recentPrice = recent.filter((l) => (l.split(",")[3] || "").trim() !== "").length;
      if (withPrice === 0) {
        problems.push(`calibration_log ${wide.length}行一個市價都冇——「模型vs市場」永遠出唔到。開Actions睇market班個log,佢會print返係API唔通/slug miss/定label對唔上`);
      } else if (recentPrice === 0) {
        problems.push("calibration_log最近30行冇市價——market班近排一直攞唔到價");
      } else {
        notes.push(`市價已記 ${withPrice}格(最近30行有${recentPrice}格)`);
      }
    }
  } catch {
    notes.push("calibration_log未存在(daily_log未跑過settle)");
  }

  try {
    const bias = JSON.parse(fs.readFileSync("bias.json", "utf-8"));
    const ok = (o) => o && o.sigmaAbs && o.sigmaScale;
    const missing = [];
    if (bias.sampleDays >= 20 && !ok(bias)) missing.push("香港");
    for (const c of CITIES) {
      const cb = bias.cities?.[c];
      if (cb && cb.sampleDays >= 20 && !ok(cb)) missing.push(c);
    }
    if (missing.length) {
      problems.push(`bias.json冇${missing.join("/")}嘅σ校準(sigmaAbs/sigmaScale)——夠樣本但冇寫,呢啲城市個機率階梯仲用緊未校準嘅σ`);
    } else if (bias.sigmaAbs) {
      notes.push(`香港σ校準 常數${bias.sigmaAbs}° · per-day權重${bias.sigmaWeight ?? 0}`);
    }
  } catch { /* bias.json讀唔到,checkBiasProgress嗰邊已經會嘈 */ }
}

// ⚠️2026-08-26:呢個repo一路只驗data檔,**一次都冇fetch過個live worker**。
// 結果 /api/pmstatus 回咗成日404(cf-worker.js漏咗register),
// 係用戶影screenshot先發現。條規矩自己寫住「每次修好一樣嘢順手加一項驗返」,
// 但worker呢邊完全冇人睇。
// GitHub Actions行到個workers.dev(market班掂到gamma-api就係證明)。
//
// 驗嘅方式跟consumer:唔係淨係睇HTTP 200,係照dashboard嘅規矩讀一次,
// 睇下讀唔讀到要嗰幾個key。
const SITE_URL = (process.env.SITE_URL || "https://hk-weather-dashboard.ipchonin.workers.dev").replace(/\/$/, "");

async function getJson(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(SITE_URL + path, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 唔係JSON */ }
    return { status: res.status, ms: Date.now() - t0, body, text };
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.name === "AbortError";
    return { status: null, ms: Date.now() - t0, err: timeout ? "20秒都冇回應" : (err.message || "連唔到") };
  }
}

async function checkWorker(problems, notes) {
  const [temp, pm, st] = await Promise.all([
    getJson("/api/temperature"),
    getJson("/api/polymarket?city=hong-kong"),
    getJson("/api/pmstatus"),
  ]);

  // 三個都連唔到 = 成個站down,或者SITE_URL寫錯。唔好報三次同一件事。
  if ([temp, pm, st].every((r) => r.status === null)) {
    problems.push(`個dashboard三個endpoint都連唔到(${SITE_URL})——成個站down咗,或者SITE_URL secret未set/寫錯: ${temp.err}`);
    return;
  }

  const shapes = [
    ["/api/temperature", temp, (b) => (b.live || b.today ? null : "冇live又冇today")],
    ["/api/polymarket", pm, (b) => ("found" in b ? null : "冇found欄")],
    ["/api/pmstatus", st, (b) => (b.api?.gamma && b.api?.clob ? null : "冇api.gamma/api.clob")],
  ];
  for (const [path, r, shapeErr] of shapes) {
    if (r.status === null) { problems.push(`${path} 連唔到: ${r.err}`); continue; }
    // 404 = 十有八九漏咗喺cf-worker.js個ROUTES register(今次就係咁)
    if (r.status === 404) { problems.push(`${path} 回404——多數係cf-worker.js個ROUTES漏咗register`); continue; }
    if (!r.body) { problems.push(`${path} 回應唔係JSON(HTTP ${r.status}): ${String(r.text).slice(0, 80)}`); continue; }
    const bad = shapeErr(r.body);
    if (bad) { problems.push(`${path} 回應形狀唔啱(HTTP ${r.status}): ${bad}`); continue; }
    notes.push(`${path} ✓ ${r.status} ${r.ms}ms`);
  }

  // 上游逐條水喉:呢啲會間中壞,唔當problem(唔想出假警報),但一定要見到
  if (temp.body) {
    const dead = ["liveError", "todayError", "metarError", "rainError"]
      .filter((k) => temp.body[k]).map((k) => `${k.replace("Error", "")}(${temp.body[k]})`);
    if (dead.length) notes.push(`temperature上游有${dead.length}條死咗: ${dead.join(", ")}`);
    // live同today兩樣一齊死先算問題(單一條死已經喺上面shape check睇住)
    const rt = temp.body.live?.recordTime;
    if (rt) {
      const ageMin = (Date.now() - new Date(rt).getTime()) / 60000;
      if (ageMin > 90) problems.push(`即時讀數已經${Math.round(ageMin)}分鐘冇更新(HKO源頭滯後?)`);
      else notes.push(`即時讀數 ${Math.round(ageMin)}分鐘前`);
    }

    // ⚠️2026-09-08加:快水喉(網站JSON)個recordTime係由BulletinTime "1302"
    // 呢個裸HHMM砌返出嚟嘅。天文台改個格式(例如變ISO、加秒、加日期),
    // 條正則就match唔到 → recordTime變null → 個溫度照樣顯示得好正常,
    // 但dashboard個🆕永遠唔會著,你就會覺得「一路都冇新數」。
    // 呢個正正係呢個repo最典型嗰種靜靜哋壞。所以照consumer嘅規矩讀一次。
    const web = temp.body.web;
    if (web && typeof web.value === "number" && web.recordTime) {
      const t = new Date(web.recordTime).getTime();
      const age = (Date.now() - t) / 60000;
      if (!Number.isFinite(t)) problems.push(`快水喉recordTime parse唔到: ${web.recordTime}`);
      // 實測定時每個鐘:02一份,中間可能加插。>75分鐘即係連定時嗰份都跳咗
      else if (age > 75 || age < -5) problems.push(`快水喉個數${Math.round(age)}分鐘前(${web.recordTime})——正常應該喺75分鐘內`);
      else notes.push(`快水喉 ${web.value}° / ${Math.round(age)}分鐘前`);
    } else if (/BulletinTime/.test(temp.body.webError || "")) {
      // 格式變咗 = 靜靜哋跌返rhrread,個溫度照顯示,但慢返2.6分鐘,
      // 而dashboard個🆕永遠唔會著。呢個一定要當problem,唔可以當note。
      problems.push(`快水喉個時間戳格式變咗,已經靜靜哋跌返慢源: ${temp.body.webError}`);
    } else if (temp.body.webError) {
      notes.push(`快水喉今次攞唔到,跌返rhrread: ${temp.body.webError}`);
    }
  }
}

// ⚠️2026-09-08:用戶問「點解整黎整去都有問題」。做咗次深層檢查,答案好清楚:
// 同一段邏輯喺呢個repo有5-7份copy,而**冇任何嘢驗過佢哋一唔一致**。
// 每次修好一份,其餘幾份繼續壞,而且唔會throw——要等下次撞到先發現。
// 實際捉到:
//   Polymarket slug加年份 → 修咗4份,漏咗paper_trade/worker/probe_polymarket
//     (paper_trade個fetchMarket一直return null,四個訊號全部出唔到,
//      成個紙上交易系統跑緊空氣)
//   σ校準改用blend → 改咗4份,漏咗scan_cities(仲用緊已證實錯嘅乘倍數)
//   BulletinTime parse → 修咗hko_probe,漏咗market_race
// 所以呢度唔再驗「個檔啱唔啱」,係驗「幾份copy有冇分叉」。
function checkDuplicatedLogic(problems, notes) {
  const read = (f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } };

  // ① Polymarket slug:凡係砌呢個slug嘅檔,都要有年份
  const slugFiles = ["daily_log.js", "market_race.js", "paper_trade.js", "worker.js",
    "probe_polymarket.js", "functions/api/polymarket.js", "netlify/functions/polymarket.js"];
  const noYear = slugFiles.filter((f) => {
    const c = read(f);
    return c && c.includes("highest-temperature-in") && !/-\$\{y\}|getUTCFullYear\(\)/.test(c);
  });
  if (noYear.length) {
    problems.push(`Polymarket slug冇年份(一定命中唔到): ${noYear.join(", ")}——真slug尾有年份`);
  } else {
    notes.push(`slug年份一致 (${slugFiles.filter((f) => read(f)).length}份)`);
  }

  // ② σ校準:凡係讀sigmaScale嘅檔,都要一齊讀sigmaAbs(唔可以淨乘倍數)
  const sigmaFiles = ["index.html", "paper_trade.js", "scan_cities.js", "daily_log.js"];
  const scaleOnly = sigmaFiles.filter((f) => {
    const c = read(f);
    return c && c.includes("sigmaScale") && !c.includes("sigmaAbs");
  });
  if (scaleOnly.length) {
    problems.push(`σ校準淨用倍數冇用sigmaAbs(已證實對香港係錯,corr=−0.15): ${scaleOnly.join(", ")}`);
  } else {
    notes.push("σ校準口徑一致(全部用blend)");
  }
}

// ⚠️2026-09-08:CSV schema守門。
// forecast_log.csv而家8欄,而model_diagnostics.js同nightly_check.js
// 都係硬編碼c[7]攞realized。加一欄就會靜靜哋讀錯——同calibration_log
// 由4欄變5欄靜咗個feedback loop十日,係同一個伏。
// 呢度唔驗「個檔存唔存在」,係驗「欄數同reader嘅假設對唔對得上」。
function checkCsvSchema(problems, notes) {
  const expect = [
    ["forecast_log.csv", 8, "model_diagnostics.js / nightly_check.js 硬編碼 c[7] 攞realized"],
    ["calibration_log.csv", 5, "index.html / nightly_check.js 硬編碼 c[4] 攞hit"],
    ["station_wedge.csv", 3, "station_wedge.js 讀 date,hkoMax,vhhhMax"],
  ];
  for (const [file, n, why] of expect) {
    if (!fs.existsSync(file)) { notes.push(`${file} 未存在`); continue; }
    const header = fs.readFileSync(file, "utf-8").split("\n")[0];
    const got = header.split(",").length;
    if (got !== n) {
      problems.push(`${file} 由${n}欄變咗${got}欄——${why},唔一齊改就會讀錯格`);
    }
  }
  notes.push(`CSV欄數同reader假設一致 (${expect.filter(([f]) => fs.existsSync(f)).length}個檔)`);
}

// ⚠️2026-09-08:加咗個「↻更新」掣落即時讀數個標題行,先發現footer嗰個
// 一路都係 id="refreshBtn",兩個撞名。HTML重複id唔會throw、console乾淨,
// getElementById淨係攞排前嗰個 → 排後嗰個掣撳極都冇反應。
// 又係典型「靜靜哋壞」:個掣睇落正常,你撳極冇嘢就以為個網死咗。
// dashboard成頁靠getElementById砌,所以撞名 = 有嘢冇更新過。
function checkHtmlIds(problems, notes) {
  const file = "index.html";
  if (!fs.existsSync(file)) { problems.push("index.html唔見咗"); return; }
  const html = fs.readFileSync(file, "utf-8");
  // ⚠️第一版寫完即刻false-positive:個comment入面提過 id="refreshBtn",
  // 掃全份檔就當咗係第二個element。呢個repo唔准出假警報(出一次就冇人再信),
  // 所以掃id之前一定要剝走<script>同HTML comment,淨返真markup。
  const markup = html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const seen = new Map();
  for (const m of markup.matchAll(/\sid=["']([^"']+)["']/g)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const dup = [...seen].filter(([, n]) => n > 1);
  if (dup.length) {
    problems.push(`index.html有重複id(getElementById只攞到第一個,後面嗰個永遠更新唔到): ` +
      dup.map(([k, n]) => `${k}×${n}`).join(", "));
  } else {
    notes.push(`index.html ${seen.size}個id冇撞名`);
  }

  // 有handler但冇對應element = 個掣/個欄改咗名之後漏咗一邊,一樣係靜靜哋死
  const wired = new Set([...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
  const missing = [...wired].filter((id) => !seen.has(id));
  if (missing.length > 6) {
    // 少量係正常(有啲element由JS動態生成),多過6個就多數係改名漏咗
    problems.push(`index.html有${missing.length}個getElementById搵唔到對應element: ${missing.slice(0, 8).join(", ")}…`);
  }
}

// ⚠️2026-09-08用戶叫加:branch有commit領先main但冇open PR = 啲改動
// 卡死喺度冇人merge得到。呢個repo嘅branch係長期重用嘅,PR merge咗之後
// branch仲喺,再push就變咗孤兒commit。PR #6/7/8/9/13/31全部中過,
// 用戶問過三次「點解merged唔到」。CLAUDE.md寫咗規矩但靠人記——
// 靠人記就會漏,所以要自動查。
async function checkOrphanCommits(problems, notes) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || "josephci/hk-weather-dashboard";
  if (!token) { notes.push("冇GITHUB_TOKEN,跳過孤兒commit檢查"); return; }
  const api = async (p) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${p}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    return r.ok ? r.json() : null;
  };
  const branches = await api("/branches?per_page=50");
  if (!branches) { notes.push("branch API攞唔到,跳過"); return; }
  const openPrs = (await api("/pulls?state=open&per_page=50")) || [];
  const withPr = new Set(openPrs.map((p) => p.head?.ref));

  const orphans = [];
  for (const b of branches) {
    if (b.name === "main" || b.name === "data") continue;   // data branch係純數據,唔會開PR
    if (withPr.has(b.name)) continue;
    const cmp = await api(`/compare/main...${encodeURIComponent(b.name)}`);
    if (cmp && cmp.ahead_by > 0) orphans.push(`${b.name}(領先${cmp.ahead_by}個commit)`);
  }
  if (orphans.length) {
    problems.push(`有commit卡死冇PR可以merge: ${orphans.join(", ")}——開返個新PR先merge到`);
  } else {
    notes.push("冇孤兒commit(所有領先main嘅branch都有open PR)");
  }
}

function checkMainPollution(problems) {
  try {
    const n = parseInt(sh(`git log --oneline --since="26 hours ago" --grep="chore: temp log" origin/main | wc -l`), 10);
    if (n > 0) problems.push(`main過去26hr有${n}個temp log commit——data branch遷移未生效(claude branch merge咗未?)`);
  } catch { /* 靜默 */ }
}

function checkDataBranch(problems, notes) {
  try {
    sh("git fetch --depth=1 origin data:refs/remotes/origin/data");
    const ageHr = (Date.now() - parseInt(sh("git log -1 --format=%ct refs/remotes/origin/data"), 10) * 1000) / 3600e3;
    if (ageHr > 8) problems.push(`data branch最後commit係${ageHr.toFixed(0)}小時前,temp-alerts條線可能死咗`);
    else notes.push(`data branch ${ageHr.toFixed(1)}hr前有commit,正常`);
  } catch {
    notes.push("data branch未存在(未merge或未bootstrap)");
  }
}

async function sendTelegram(text) {
  const token = process.env.TG_BOT_TOKEN, chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) { console.log("(未設定Telegram,只print)"); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) console.error("Telegram失敗:", res.status, await res.text());
}

async function main() {
  const problems = [], notes = [], cityLines = [];
  await checkWorkflowRuns(problems, notes);
  checkBiasProgress(problems, cityLines);
  checkFeedbackLoop(problems, notes);
  checkDuplicatedLogic(problems, notes);
  checkCsvSchema(problems, notes);
  checkHtmlIds(problems, notes);
  await checkOrphanCommits(problems, notes);
  await checkWorker(problems, notes);
  checkMainPollution(problems);
  checkDataBranch(problems, notes);

  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const lines = [
    `🌙 <b>每晚健康檢查</b> ${today}`,
    problems.length ? `⚠️ 發現${problems.length}個問題` : "✅ 一切正常",
  ];
  if (problems.length) lines.push("", "<b>問題:</b>", ...problems.map((p) => "• " + p));
  lines.push("", "<b>bias累積:</b>", ...cityLines.map((l) => "• " + l));
  if (notes.length) lines.push("", ...notes.map((n) => `(${n})`));

  const msg = lines.join("\n");
  console.log(msg.replace(/<[^>]+>/g, ""));
  await sendTelegram(msg);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
