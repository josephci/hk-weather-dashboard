// functions/api/pmstatus.js — Cloudflare Pages Function版
// ------------------------------------------------------------
// 答一條問題:而家搞唔掂交易,係Polymarket出事,定係我自己出事?
//
// ⚠️2026-08-24:用戶撞到Polymarket down,連交易都做唔到。嗰陣個dashboard
// 淨係顯示「今日market未搵到」——同「市場未開盤」「slug變咗」用同一句,
// 完全睇唔出係人哋down咗。個人就會以為自己個系統壞咗,去查錯方向。
//
// 探三樣嘢,分開報,唔好夾埋一齊:
//   ① status.polymarket.com  官方statuspage:總體狀態 + 進行中事故 + 維護窗口
//   ② gamma-api              市場數據(dashboard啲價、edge、鎖定全靠佢)
//   ③ clob                   交易API(落單、order book。Gamma好地地都可以佢單獨死)
//
// ②③分開探好重要:見過好多次數據API正常但交易API唔得,
// 個網睇落乜事都冇但你就係落唔到單。
//
// ⚠️呢個sandbox個proxy封晒polymarket.com同status.polymarket.com(403),
// 所以下面啲endpoint嘅實際response shape驗證唔到,全部用defensive parse:
// 讀唔到就報「讀唔到」,**永遠唔會default做綠燈**。
// 寧願話你知「我唔知」,都好過畫個綠燈呃你話一切正常。
// ------------------------------------------------------------

const STATUS_URL = "https://status.polymarket.com/api/v2/summary.json";
const GAMMA_URL = "https://gamma-api.polymarket.com/events?limit=1&closed=false";
const CLOB_URL = "https://clob.polymarket.com/time";

const TIMEOUT_MS = 8000;

// 逐個探,順手計延遲。任何情況都唔會throw——一個死唔可以拖冧其餘兩個。
async function probe(name, url, check, keepBody = false) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "hk-weather-dashboard/1.0" },
    });
    const ms = Date.now() - t0;
    const body = await res.text();
    if (!res.ok) {
      return { name, ok: false, ms, status: res.status, detail: `HTTP ${res.status}` };
    }
    const extra = check ? check(body) : {};
    return { name, ok: extra.ok !== false, ms, status: res.status, ...extra, body: keepBody ? body : undefined };
  } catch (err) {
    const ms = Date.now() - t0;
    // 分開講死法:timeout / DNS / 其他。「連唔到」同「慢到死」係兩件事
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      name, ok: false, ms, status: null,
      detail: isTimeout ? `超過${TIMEOUT_MS / 1000}秒冇回應` : (err.message || "連唔到"),
    };
  }
}

// Gamma:200唔代表有數,要真係parse到array先算生存
function checkGamma(body) {
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j)) return { ok: false, detail: "回應唔係array(格式變咗?)" };
    return { detail: `攞到${j.length}個event` };
  } catch {
    return { ok: false, detail: "回應唔係JSON(可能俾Cloudflare攔咗)" };
  }
}

// CLOB /time 應該回一個unix秒數。回到數=交易API條線通。
// ⚠️呢個只證明「API應緊機」,唔證明「你落到單」——落單仲要簽名同錢包。
function checkClob(body) {
  const t = parseInt(String(body).trim(), 10);
  if (!Number.isFinite(t) || t < 1e9) {
    return { ok: false, detail: `回應唔似時間戳: ${String(body).slice(0, 40)}` };
  }
  const drift = Math.abs(Date.now() / 1000 - t);
  return { detail: drift > 120 ? `通(但server時間差${Math.round(drift)}秒)` : "通" };
}

// Atlassian Statuspage v2 schema。呢個schema好穩定,但一樣defensive行事。
function parseStatusPage(body) {
  const j = JSON.parse(body);
  const indicator = j.status?.indicator ?? null;   // none|minor|major|critical
  const description = j.status?.description ?? null;

  const incidents = (j.incidents || [])
    .filter((i) => i.status !== "resolved" && i.status !== "postmortem")
    .map((i) => ({
      name: i.name,
      status: i.status,
      impact: i.impact,
      updated: i.updated_at,
      body: i.incident_updates?.[0]?.body?.slice(0, 300) ?? null,
    }));

  // 維護:進行中 + 未開始嘅都要,用戶想知「幾時維護」
  const maintenances = (j.scheduled_maintenances || [])
    .filter((m) => m.status !== "completed")
    .map((m) => ({
      name: m.name,
      status: m.status,               // scheduled | in_progress | verifying
      scheduledFor: m.scheduled_for,
      scheduledUntil: m.scheduled_until,
      body: m.incident_updates?.[0]?.body?.slice(0, 300) ?? null,
    }));

  // 邊啲component出事(通常會分Trading / API / Website)
  const degraded = (j.components || [])
    .filter((c) => c.status && c.status !== "operational" && !c.group)
    .map((c) => ({ name: c.name, status: c.status }));

  // ⚠️2026-08-27:本來只回進行緊嘅事故。但用戶嘅問題係
  // 「昨日就係佢個API有down time搞到咩都做唔到」——即係佢想知返
  // 啱啱先發生完嗰啲。已解決嘅一律filter走,個panel就會顯示「正常」,
  // 佢完全睇唔出尋日有嘢發生過,亦都唔知自己尋日做唔到嘢係咪自己問題。
  // 攞返過去48小時已解決嘅,用灰色細字放喺下面(唔好扮緊急)。
  const since = Date.now() - 48 * 3600e3;
  const recentIncidents = (j.incidents || [])
    .filter((i) => (i.status === "resolved" || i.status === "postmortem") &&
      i.resolved_at && Date.parse(i.resolved_at) >= since)
    .map((i) => ({
      name: i.name,
      impact: i.impact,
      startedAt: i.started_at ?? i.created_at ?? null,
      resolvedAt: i.resolved_at,
    }));

  // 交易嗰條component而家點——就算成體正常都要見到,因為你最想知就係佢
  const TRADING_RE = /trading|clob|order|exchange/i;
  const trading = (j.components || [])
    .filter((c) => !c.group && TRADING_RE.test(c.name || ""))
    .map((c) => ({ name: c.name, status: c.status }));

  return { indicator, description, incidents, maintenances, degraded, recentIncidents, trading };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequest() {
  const [statusRes, gamma, clob] = await Promise.all([
    probe("statuspage", STATUS_URL, null, true),
    probe("gamma", GAMMA_URL, checkGamma),
    probe("clob", CLOB_URL, checkClob),
  ]);

  // statuspage自己都可能down。攞唔到就老實講攞唔到,唔好當「冇事故」。
  let page = null, pageError = null;
  if (statusRes.ok) {
    try { page = parseStatusPage(statusRes.body ?? ""); }
    catch { pageError = "statuspage回應parse唔到(schema變咗?)"; }
  } else {
    pageError = statusRes.detail || "statuspage攞唔到";
  }

  return json({
    checkedAt: new Date().toISOString(),
    page,
    pageError,
    pageMs: statusRes.ms,
    api: {
      gamma: { ok: gamma.ok, ms: gamma.ms, detail: gamma.detail ?? null },
      clob: { ok: clob.ok, ms: clob.ms, detail: clob.detail ?? null },
    },
  });
}
