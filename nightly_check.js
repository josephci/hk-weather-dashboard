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
    problems.push("香港近兩日有模型預測但冇realized——晚上settle班冇跑到(cron延遲衝過香港午夜?)");
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
        problems.push(`calibration_log ${wide.length}行一個市價都冇——market班攞唔到價(市場未開盤?slug變咗?),「模型vs市場」永遠出唔到`);
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
