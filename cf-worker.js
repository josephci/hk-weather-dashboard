// cf-worker.js — Cloudflare Workers入口(Workers「Connect to Git」流程用)
// ------------------------------------------------------------
// /api/* → reuse functions/api/嘅邏輯
// 其他路徑 → 靜態檔(index.html等,由assets binding serve)
// 注意:呢個worker叫hk-weather-dashboard,同你原本嘅警報worker係兩個獨立project
//
// ⚠️2026-08-26:加新endpoint要記住喺呢度register。
// Netlify靠netlify.toml個 /api/* wildcard、Cloudflare Pages會自動掃
// functions/api/,但**Workers呢條路係逐個路徑白名單**——加咗
// functions/api/pmstatus.js但冇加呢度,個dashboard就出「狀態API 404」。
// 一個endpoint有三個地方要照顧:functions/api/、netlify/functions/、同呢度。
// ------------------------------------------------------------

import * as temperature from "./functions/api/temperature.js";
import * as polymarket from "./functions/api/polymarket.js";
import * as pmstatus from "./functions/api/pmstatus.js";

const ROUTES = {
  "/api/temperature": temperature,
  "/api/polymarket": polymarket,
  "/api/pmstatus": pmstatus,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const mod = ROUTES[pathname];
    if (mod) return mod.onRequest({ request, env, ctx });
    // ⚠️唔好靜靜哋跌落靜態檔:/api/*搵唔到就係漏咗register,
    // 唔講清楚就會好似今次咁,睇到個404但估唔到係邊度漏
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({
        error: `冇呢個endpoint: ${pathname}`,
        available: Object.keys(ROUTES),
        hint: "新endpoint要喺cf-worker.js個ROUTES度register",
      }), { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  },
};
