// functions/api/live.js — ⚡快線
// ------------------------------------------------------------
// 2026-09-09用戶:「人哋快我30秒左右…我都想即時知道」。
// 量咗先答,唔靠估:
//
//   ① 個源:race過(n=23,兩條獨立發佈路徑),0.1°嘅數
//      **全世界都要等 stamp+8.4分鐘**。冇人快得過,包括對家。
//   ② 個fan-out:/api/temperature 一個request拉5條上游,
//      Promise.allSettled要全部返晒先出回應。實測(Actions,6次):
//        直接拉CSV 178ms · 經worker 437ms → 白等 259ms(最壞1195ms)
//   ③ 個poll間隔:出數窗口10秒一次 → 平均遲5秒、最壞10秒
//
//   即係30秒入面,我拎得返嘅係 ②+③ ≈ 最壞11秒。餘下嘅係物理同對家嘅設置。
//
// 呢條快線做嘅事好窄:**只拉「決定得到你落唔落注」嗰兩條**——
//   1分鐘CSV(0.1°,決定max)  +  網站JSON(整數,最快出街嗰條)
// 唔拉METAR(美國host)、唔拉maxmin、唔拉rhrread雨量。
//
// ⚠️佢**唔係**攞嚟畫成塊板嘅。client應該用佢做「有冇新數」嘅探子:
// 一見recordTime變咗就即刻call返 /api/temperature 攞齊嘢再render。
// 咁就唔會有第二份render邏輯——呢個repo最大嘅伏就係同一段嘢有幾份copy。
//
// ⚠️冇Netlify孖生版:個站行緊Cloudflare Workers(cf-worker.js),
// Netlify嗰邊係CommonJS,要抄多份fetcher先做得到。抄=分叉,
// 而呢條線本身就係為咗快,唔值得為一個唔用緊嘅平台開多個分叉點。
// ------------------------------------------------------------

import { fetchLive, fetchHkoWeb } from "./temperature.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function onRequest() {
  const [csvResult, webResult] = await Promise.allSettled([fetchLive(), fetchHkoWeb()]);

  const out = {};
  const csv = csvResult.status === "fulfilled" ? csvResult.value : null;
  if (csv && csv.value !== null) out.live = { ...csv, source: "csv" };
  else out.liveError = csvResult.status === "rejected" ? csvResult.reason.message : "CSV冇總部讀數(N/A)";

  if (webResult.status === "fulfilled" && webResult.value?.recordTime) out.web = webResult.value;
  else out.webError = webResult.status === "rejected" ? webResult.reason.message
    : `網站JSON個BulletinTime砌唔到時間(收到:${JSON.stringify(webResult.value?.bulletinRaw ?? null)})`;

  // 兩條都死先叫真係冇嘢——一條死唔好拖冧另一條(同/api/temperature同一個規矩)
  return json(out, out.live || out.web ? 200 : 502);
}
