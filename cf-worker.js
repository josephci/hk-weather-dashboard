// cf-worker.js — Cloudflare Workers入口(Workers「Connect to Git」流程用)
// ------------------------------------------------------------
// /api/temperature、/api/polymarket → reuse functions/api/嘅邏輯
// 其他路徑 → 靜態檔(index.html等,由assets binding serve)
// 注意:呢個worker叫hk-weather-dashboard,同你原本嘅警報worker係兩個獨立project
// ------------------------------------------------------------

import * as temperature from "./functions/api/temperature.js";
import * as polymarket from "./functions/api/polymarket.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/temperature") return temperature.onRequest({ request, env, ctx });
    if (pathname === "/api/polymarket") return polymarket.onRequest({ request, env, ctx });
    return env.ASSETS.fetch(request);
  },
};
