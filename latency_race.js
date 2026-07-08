/**
 * latency_race.js
 * ------------------------------------------------------------
 * 目的：科學噉搵出「邊條渠道最快出新溫度讀數」。
 *
 * 同時每30秒poll 4條渠道：
 *   A. 開放數據CSV（你而家用緊嗰條）
 *   B. rhrread 開放API JSON
 *   C. 天文台網站內部JSON（佢自己網頁用嘅，非官方文檔渠道）
 *   D. METAR VHHH（機場，獨立系統）
 *
 * 每當任何渠道出現新讀數，記低「邊條渠道、幾點幾分收到、讀數幾多」
 * 落 latency_log.csv。跑幾個鐘之後睇返，就知邊條渠道慣性行先、
 * 快幾多分鐘——嗰條就係你要換去嘅水喉。
 *
 * 順便內置【推算模式】：喺兩次官方更新之間，用最近讀數嘅趨勢
 * 估算「而家大約幾多度」，等你唔使盲等。
 *
 * 用法（喺你本機/長開嘅機器跑，唔好用GitHub Actions——呢個實驗要連續跑）：
 *   node latency_race.js            # 跑2個鐘自動停
 *   node latency_race.js --hours=6  # 跑6個鐘
 *
 * ⚠️ 渠道C係天文台網站嘅內部endpoint，唔係官方開放API：
 *   佢冇文檔、可能隨時改結構、理論上唔係俾第三方程式用。
 *   呢度只用嚟做延遲測量實驗（低頻poll，同開個網頁冇分別），
 *   唔建議攞嚟做長期production依賴。
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "latency_log.csv");
const POLL_MS = 30_000;

const STATION_PATTERN = /^(香港天文台|HK Observatory|Hong Kong Observatory)$/i;

// ---------- 4條渠道 ----------
const CHANNELS = {
  // A: 開放數據CSV（現用）
  csv: async () => {
    const res = await fetch("https://data.weather.gov.hk/weatherAPI/hko_data/regional-weather/latest_1min_temperature.csv", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lines = (await res.text()).trim().split(/\r?\n/).slice(1);
    for (const line of lines) {
      const [ts, place, tempStr] = line.split(",").map((s) => s.trim());
      if (STATION_PATTERN.test(place)) {
        return { stamp: ts, value: parseFloat(tempStr) };
      }
    }
    return null;
  },

  // B: rhrread開放API（整數,但可能唔同時序）
  rhrread: async () => {
    const res = await fetch("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const station = json.temperature?.data?.find((d) => STATION_PATTERN.test(d.place.trim()));
    if (!station) return null;
    return { stamp: json.temperature.recordTime, value: station.value };
  },

  // C: 天文台網站內部JSON（網頁自己用嘅，非官方渠道，實驗用）
  hkoWeb: async () => {
    const res = await fetch("https://www.hko.gov.hk/json/DYN_DAT_MINDS_RHRREAD.json", {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.hko.gov.hk/" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // 內部格式無文檔，防禦式noon掘：搵HKO/香港天文台溫度相關嘅key
    const root = json.DYN_DAT_MINDS_RHRREAD || json;
    const stamp = root.BulletinTime?.Val_Eng || root.BulletinTime || null;
    // 常見pattern: HKOReadingsTemperature / 或者站點陣列
    let value = null;
    const tryKeys = ["HongKongObservatoryTemperature", "HKOTemperature", "HKO"];
    for (const k of Object.keys(root)) {
      if (/observatory/i.test(k) && /temp/i.test(k)) {
        const v = root[k]?.Val_Eng ?? root[k];
        const n = parseFloat(v);
        if (!Number.isNaN(n)) { value = n; break; }
      }
    }
    if (value === null) {
      // 攞唔到就將成個keys印一次俾用戶睇（只第一次）
      if (!CHANNELS._hkoWebKeysPrinted) {
        console.log("  [hkoWeb] 未搵到溫度key，可用keys（俾Claude debug用）:", Object.keys(root).slice(0, 40).join(", "));
        CHANNELS._hkoWebKeysPrinted = true;
      }
      return null;
    }
    return { stamp: String(stamp), value };
  },

  // D: METAR VHHH（機場,獨立系統,做對照組）
  metar: async () => {
    const res = await fetch("https://aviationweather.gov/api/data/metar?ids=VHHH&format=json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    const m = Array.isArray(arr) ? arr[0] : null;
    if (!m || typeof m.temp !== "number") return null;
    return { stamp: String(m.reportTime || m.obsTime), value: m.temp };
  },
};

// ---------- 推算模型（nowcast） ----------
// 用最近3個官方讀數做線性趨勢+阻尼外推：
//   估計 = 最新讀數 + 斜率 × 經過分鐘 × 0.7（阻尼,因為溫度趨勢會自然放緩）
const recentReadings = []; // { time: ms, value }

function nowcast() {
  if (recentReadings.length < 2) return null;
  const rs = recentReadings.slice(-3);
  const first = rs[0], last = rs[rs.length - 1];
  const spanMin = (last.time - first.time) / 60000;
  if (spanMin <= 0) return null;
  const slopePerMin = (last.value - first.value) / spanMin;
  const elapsedMin = (Date.now() - last.time) / 60000;
  const est = last.value + slopePerMin * elapsedMin * 0.7;
  return { est, slopePerHour: slopePerMin * 60, sinceLastMin: elapsedMin };
}

// ---------- 主迴圈 ----------
const lastStamp = {}; // channel -> stamp

function logArrival(channel, stamp, value) {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "arrivalTimeISO,channel,dataStamp,value\n");
  }
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()},${channel},${stamp},${value}\n`);
}

async function pollAll() {
  const results = await Promise.allSettled(
    Object.entries(CHANNELS)
      .filter(([k]) => typeof CHANNELS[k] === "function")
      .map(async ([name, fn]) => ({ name, data: await fn() }))
  );

  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.data) continue;
    const { name, data } = r.value;
    if (lastStamp[name] !== data.stamp) {
      lastStamp[name] = data.stamp;
      const hhmmss = new Date().toISOString().slice(11, 19);
      console.log(`🏁 [${hhmmss}] ${name.padEnd(8)} 新讀數: ${data.value}°C (數據時戳: ${data.stamp})`);
      logArrival(name, data.stamp, data.value);

      // 用CSV渠道嘅讀數餵推算模型（呢條係結算基準渠道）
      if (name === "csv" && !Number.isNaN(data.value)) {
        recentReadings.push({ time: Date.now(), value: data.value });
        if (recentReadings.length > 5) recentReadings.shift();
      }
    }
  }

  const nc = nowcast();
  if (nc) {
    process.stdout.write(
      `   ↳ 推算現時: ${nc.est.toFixed(1)}°C（趨勢${nc.slopePerHour >= 0 ? "+" : ""}${nc.slopePerHour.toFixed(1)}°/hr,上次官方讀數${nc.sinceLastMin.toFixed(0)}分鐘前）\r`
    );
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  const hours = parseFloat(args.hours ?? "2");
  console.log(`⏱ 延遲競賽開始，跑${hours}個鐘，每${POLL_MS / 1000}秒poll一次4條渠道。結果記錄喺 latency_log.csv\n`);

  await pollAll();
  const timer = setInterval(pollAll, POLL_MS);
  setTimeout(() => {
    clearInterval(timer);
    console.log(`\n\n✅ 實驗完成。分析方法：開 latency_log.csv，對比同一個dataStamp喺唔同channel嘅arrivalTime——` +
      `邊條channel慣性最早出現，佢就係最快嘅水喉。將個CSV貼俾Claude可以幫你分析。`);
    process.exit(0);
  }, hours * 3600 * 1000);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
