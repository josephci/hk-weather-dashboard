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

  await checkScheduleCadence(problems, notes, repo, token);
}

// 由cron算返26個鐘應該跑幾多次。
// ⚠️2026-09-13擴闊:本來淨係識 */N 分鐘。但temp-alerts由 */5 改咗做
// 每個鐘("0 * * * *")之後,舊個parser會return null → 個守門靜靜哋熄咗,
// 之後GitHub再跌run都冇人知。修一樣嘢順手熄咗個check,係最衰嗰種。
// 一日跑幾次嗰啲(daily-bias/scan-cities)照樣唔查——本身就疏,查咗會出假警報。
function cronRunsPer26h(cron) {
  const c = String(cron).trim();
  let m;
  if ((m = c.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/))) {        // */N 分鐘
    const n = parseInt(m[1], 10);
    return n > 0 ? Math.round((26 * 60) / n) : null;
  }
  if ((m = c.match(/^\d+\s+\*\s+\*\s+\*\s+\*$/))) return 26;        // 每個鐘
  if ((m = c.match(/^\d+\s+\*\/(\d+)\s+\*\s+\*\s+\*$/))) {        // 每N個鐘
    const n = parseInt(m[1], 10);
    return n > 0 ? Math.round(26 / n) : null;
  }
  return null;
}

// ⚠️2026-09-09:用戶問點解Telegram啲香港警報咁疏。查GitHub API先發現——
// temp-alerts.yml寫住 cron "*/5 * * * *"(一日288次),
// 實際26個鐘得20幾次,即係~72分鐘先一次。
// **每一個run都係綠色success**,所以上面「有冇fail」嗰個check一世都捉唔到。
// GitHub係會靜靜哋跳過高頻schedule嘅,佢唔會報錯,只係唔跑。
// 而用戶個edge窗口得8分鐘 —— 72分鐘一次嘅警報等於冇。
// 所以呢度驗嘅係「真係跑咗幾多次」,唔係「跑嗰啲有冇fail」。
async function checkScheduleCadence(problems, notes, repo, token) {
  let files = [];
  try { files = fs.readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f)); } catch { return; }
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

  for (const file of files) {
    const yml = fs.readFileSync(`.github/workflows/${file}`, "utf-8");
    // ⚠️一個檔可以有幾個cron(daily-bias就有7個)。淨睇第一個就會漏——
    // 揀最密嗰個,因為個workflow嘅實際頻率係由最密嗰條決定。
    let cron = null, expect = null;
    for (const m of yml.matchAll(/cron:\s*["']([^"']+)["']/g)) {
      const n = cronRunsPer26h(m[1]);
      if (n !== null && (expect === null || n > expect)) { expect = n; cron = m[1]; }
    }
    if (!expect) continue; // 一日跑幾次嗰啲本身就疏,查咗會出假警報

    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=100&event=schedule`,
      { headers });
    if (!res.ok) { notes.push(`${file} runs API ${res.status},跳過cadence檢查`); continue; }
    const runs = ((await res.json()).workflow_runs || [])
      .filter((r) => Date.now() - new Date(r.created_at) < 26 * 3600e3);

    // 攞夠100個 = 撞到API上限,數唔準,寧願唔講都好過報個錯數
    if (runs.length >= 100) { notes.push(`${file} 26hr內≥100個run,cadence正常`); continue; }
    if (runs.length < 2) { problems.push(`${file} 排程 ${cron} 但26個鐘只跑咗${runs.length}次——當佢冇跑`); continue; }

    const gapMin = (26 * 60) / runs.length;
    const ratio = runs.length / expect;
    if (ratio < 0.5) {
      // ⚠️2026-09-13:呢個警報要講得出「跟住點做」。實測GitHub會照跑低頻cron
      // (daily-bias 7/7、scan-cities 4/4),淨係跌高頻嗰個。所以出到呢句
      // 唔係叫你去修GitHub,係叫你將個頻率寫返真,或者搬去Cloudflare Worker。
      problems.push(`${file} 排程寫住 ${cron}(26hr應該${expect}次),實際只跑咗${runs.length}次` +
        ` = 平均${Math.round(gapMin)}分鐘先一次。GitHub會靜靜哋跌高頻schedule(每個run都係success,睇fail數查唔到)。` +
        `→ 要即時就搬去Cloudflare Worker個cron;唔搬就將個cron寫返真實跑到嘅頻率,唔好留住句大話`);
    } else {
      notes.push(`${file} cadence ${runs.length}/${expect}次 (~${Math.round(gapMin)}分鐘一次)`);
    }
  }
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
  const [temp, pm, st, lv] = await Promise.all([
    getJson("/api/temperature"),
    getJson("/api/polymarket?city=hong-kong"),
    getJson("/api/pmstatus"),
    getJson("/api/live"),
  ]);

  // 全部都連唔到 = 成個站down,或者SITE_URL寫錯。唔好報幾次同一件事。
  if ([temp, pm, st, lv].every((r) => r.status === null)) {
    problems.push(`個dashboard所有endpoint都連唔到(${SITE_URL})——成個站down咗,或者SITE_URL secret未set/寫錯: ${temp.err}`);
    return;
  }

  const shapes = [
    ["/api/temperature", temp, (b) => (b.live || b.today ? null : "冇live又冇today")],
    ["/api/polymarket", pm, (b) => ("found" in b ? null : "冇found欄")],
    ["/api/pmstatus", st, (b) => (b.api?.gamma && b.api?.clob ? null : "冇api.gamma/api.clob")],
    // ⚡快線:dashboard窗口內每2秒靠佢做「有冇新數」嘅探子。佢一死(或者
    // 忘記咗喺cf-worker.js register)個page唔會報錯——pollChange個catch食晒,
    // 只係靜靜哋跌返30秒poll,你就無啦啦慢返十幾秒。所以一定要有人睇住。
    ["/api/live", lv, (b) => (b.live || b.web ? null : "冇live又冇web")],
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

      // ⚠️2026-09-08:index.html個livePollDelay()硬編碼咗「每十分鐘嘅:07-:10
      // poll密啲」,係由實測嚟嘅——latest_1min_temperature.csv雖然叫「1min」,
      // 實際係10分鐘出一份(戳:00/:10/:20…),滯後7.5-9.1分(n=18)。
      // 天文台一改cadence(例如真係變1分鐘、或者變5分鐘),個窗口就對唔正:
      // 個page照行、個數照顯示,只係又靜靜哋慢返成分鐘——用戶就係咁報上嚟。
      // 所以驗個戳仲係咪10分鐘一格。
      const stampMin = new Date(rt).getUTCMinutes();
      if (stampMin % 10 !== 0) {
        problems.push(`即時讀數個戳係:${String(stampMin).padStart(2, "0")},唔再係10分鐘一格(${rt})——` +
          `index.html個livePollDelay()窗口係照10分鐘cadence排嘅,要重新量過再改`);
      }
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

    // ⚠️2026-09-13加:today.max 就係結算嗰個數,而家有第二條獨立源
    // (region.json,喺www.hko.gov.hk;maxmin CSV喺data.weather.gov.hk)。
    // 兩條唔同host、唔同發佈路徑,理論上要一模一樣。唔夾 = 其中一邊出事,
    // 而你唔會喺dashboard上面自己發現——所以要每晚對一次。
    const rg = temp.body.region, td = temp.body.today;
    if (rg && typeof rg.max === "number" && td && typeof td.max === "number") {
      if (Math.abs(rg.max - td.max) > 0.05) {
        problems.push(`今日max兩條源唔夾:maxmin CSV=${td.max}° vs region.json=${rg.max}°(差${(rg.max - td.max).toFixed(1)}°)——結算就係呢個數,查邊邊出事`);
      } else {
        notes.push(`今日max兩條源對得上 (${td.max}°)`);
      }
    } else if (temp.body.regionError) {
      notes.push(`region.json攞唔到(冇咗today.max嘅交叉對照): ${temp.body.regionError}`);
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

  // ④ 「唔知」唔可以當「0」。
  // 2026-09-10用戶影低:1小時預測panel喺趨勢同模型都未load嗰陣,
  // 照樣寫住「預測29.2° 趨勢+0.0°/hr 距今日max 0.0° → 破max機率:低」。
  // 個29.2°就係當時嘅現時溫度——攞住現時溫度冠上「預測」兩個字。
  // 元兇係 `let slope = 0`:把「未夠採樣點」寫成「趨勢係平」,
  // 再由「平」推出「機率低」。撳一下更新就跳去29.0°,用戶問點解會跳。
  // 呢個係最貴嗰種bug——唔會throw、睇落正常、而且直接影響落注。
  // ⚠️又中同一個伏(第③項嗰陣已經中過一次):我上面段comment引用咗
  // `let slope = 0` 做反面教材,掃成份檔就當咗係真code。剝走comment先掃。
  const idxRaw = read("index.html") || "";
  const idx = idxRaw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (/let\s+slope\s*=\s*0\b/.test(idx)) {
    problems.push("index.html個1小時預測又用返 `let slope = 0`——趨勢唔知就當平,會出「距max 0.0°但機率低」呢種自相矛盾嘅結論");
  }
  // 靜默catch = 呢個repo所有靜靜哋壞嘅source。Open-Meteo嗰個中過招。
  const silent = (idx.match(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*\s*靜默\s*\*\/)?\s*\}/g) || []).length;
  if (silent > 0) {
    problems.push(`index.html有${silent}個乜都唔做嘅catch——上游死咗會靜靜哋當「未load完」,分唔到死因`);
  } else {
    notes.push("index.html冇靜默catch");
  }

  // ③ 天文台總部個站名:個CSV寫「HK Observatory」,唔係「Hong Kong Observatory」。
  // 2026-09-09白行咗一次45分鐘race先發現——rhrread_probe自己另外寫咗個
  // /香港天文台|Hong Kong Observatory/,128次poll全部match唔到,race出唔到結果。
  // 凡係要由呢個CSV撈總部嗰行嘅檔,都一定要有齊三個寫法。
  const stationFiles = ["functions/api/temperature.js", "netlify/functions/temperature.js",
    "alert.js", "worker.js", "rhrread_probe.js", "hko_probe.js", "market_race.js"];
  // ⚠️第一版寫「成份檔有冇HK Observatory呢串字」,結果俾我自己上面段
  // comment(提咗個站名)冚住,反向測試捉唔到。所以要驗**個regex嗰行**,
  // 唔係成份檔——comment講過個名唔等於個matcher識match。
  const missHk = stationFiles.filter((f) => {
    const c = read(f);
    if (!c) return false;
    // ⚠️再中一次:上面段comment引用咗**寫錯嗰個**regex做反面教材,
    // 掃埋comment就會當佢係真matcher,rhrread_probe同hko_probe即刻false-positive。
    // 呢個repo唔准出假警報,所以comment行要剝走先掃。
    const patLines = c.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .filter((l) => /Observatory/.test(l) && /\/\^?\(?.*\|/.test(l));
    return patLines.length > 0 && patLines.some((l) => !l.includes("HK Observatory"));
  });
  if (missHk.length) {
    problems.push(`個站名寫漏咗「HK Observatory」(CSV實際用呢個,漏咗就成日match唔到、又唔會throw): ${missHk.join(", ")}`);
  } else {
    notes.push(`總部站名三個寫法齊 (${stationFiles.filter((f) => read(f)).length}份)`);
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
