/**
 * watch.js — 本機長駐監察器
 * ------------------------------------------------------------
 * 解決GitHub Actions cron唔準時嘅問題：喺你自己部機長開，
 * 用智能節奏重複執行 alert.js（同一套雙水喉+edge scanner邏輯）：
 *
 *   日間（HK 07:00-18:00）：
 *     - 整點嘅 :03-:06 分 → 每20秒跑（捕捉rhrread快水喉，佢~04分出數）
 *     - 每個10分鐘嘅 :07-:09 分 → 每30秒跑（捕捉CSV，佢~08分出數）
 *     - 其他時間 → 每2分鐘跑
 *   夜晚（18:00-07:00）：每10分鐘跑（高溫已鎖定，唔使密）
 *
 * 用法（喺project資料夾，即係alert.js同一位置）：
 *   set TG_BOT_TOKEN=你的token
 *   set TG_CHAT_ID=你的chatid
 *   node watch.js
 *
 * 停止：Ctrl+C
 * ------------------------------------------------------------
 */

const { spawn } = require("child_process");
const path = require("path");

let running = false;
let runCount = 0;

function hkNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// 決定而家應該幾密咁跑（回傳毫秒）
function currentInterval() {
  const { hour, minute } = hkNow();
  const isDaytime = hour >= 7 && hour < 18;
  if (!isDaytime) return 10 * 60_000; // 夜晚每10分鐘

  const minInHour = minute;
  const minIn10 = minute % 10;

  if (minInHour >= 3 && minInHour <= 6) return 20_000;  // 整點03-06分:rhrread出數窗口
  if (minIn10 >= 7 && minIn10 <= 9) return 30_000;      // 每十分鐘07-09分:CSV出數窗口
  return 2 * 60_000;                                     // 日間其他時間
}

function runAlertOnce() {
  if (running) return; // 上一次未完就skip,唔好疊
  running = true;
  runCount++;
  const child = spawn("node", [path.join(__dirname, "alert.js")], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => {
    running = false;
    const stamp = new Date().toISOString().slice(11, 19);
    // 只print有意義嘅行,靜默跑唔洗screen
    const meaningful = out.split("\n").filter((l) => l && !l.startsWith("（未設定")).join("\n  ");
    if (meaningful.includes("已推送") || meaningful.includes("❌") || runCount % 20 === 0) {
      console.log(`[${stamp}] run#${runCount} (exit ${code})\n  ${meaningful}`);
    } else {
      process.stdout.write(`[${stamp}] run#${runCount} 冇事件 (下次${Math.round(currentInterval()/1000)}秒後)\r`);
    }
  });
}

function loop() {
  runAlertOnce();
  setTimeout(loop, currentInterval());
}

console.log("👀 本機監察器啟動。智能節奏：日間整點03-06分每20秒（快水喉窗口）/ 10分鐘07-09分每30秒（CSV窗口）/ 其他2分鐘 / 夜晚10分鐘。Ctrl+C停止。\n");
if (!process.env.TG_BOT_TOKEN) {
  console.log("⚠️ 未設定TG_BOT_TOKEN環境變數，警報只會print唔會推Telegram。設定方法見檔案頂部註解。\n");
}
loop();
