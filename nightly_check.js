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

const CITIES = ["shanghai", "beijing", "london", "paris"];

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

function checkBiasProgress(problems, cityLines) {
  let bias = {};
  try { bias = JSON.parse(fs.readFileSync("bias.json", "utf-8")); } catch { /* 冇就空 */ }
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
    }
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
