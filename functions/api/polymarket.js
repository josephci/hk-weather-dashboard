// functions/api/polymarket.js — Cloudflare Pages Function版
// ------------------------------------------------------------
// 同netlify/functions/polymarket.js功能一致,行Workers runtime:
// 代理Gamma API攞當日城市溫度market現價,slug搵唔到有title fallback。
// ------------------------------------------------------------

const CITY_TZ = {
  "hong-kong": "Asia/Hong_Kong",
  "shanghai": "Asia/Shanghai",
  "beijing": "Asia/Shanghai",
  "london": "Europe/London",
  "paris": "Europe/Paris",
  "shenzhen": "Asia/Shanghai",
};
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function parseBuckets(ev) {
  const buckets = [];
  let unit = "C";
  for (const mkt of ev.markets || []) {
    let yesPrice = null;
    try {
      const prices = JSON.parse(mkt.outcomePrices || "[]");
      yesPrice = prices[0] !== undefined ? Math.round(parseFloat(prices[0]) * 100) : null;
    } catch { /* ignore */ }
    const label = (mkt.groupItemTitle || mkt.question || "").trim();
    if (/°f|fahrenheit/i.test(label)) unit = "F";
    if (yesPrice !== null && label) buckets.push({ label, yesPrice });
  }
  return { buckets, unit };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const city = (url.searchParams.get("city") || "hong-kong").toLowerCase();
    if (!CITY_TZ[city]) {
      return json({ error: `city要係: ${Object.keys(CITY_TZ).join("/")}` }, 400);
    }

    // ?day=tomorrow → 聽日market(通常今日已開盤,早期定價最鬆)
    const dayOffset = url.searchParams.get("day") === "tomorrow" ? 86400e3 : 0;
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: CITY_TZ[city], year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(Date.now() + dayOffset));
    const [, m, d] = dateStr.split("-").map(Number);
    // ⚠️2026-08-26 由真實API response查實:Polymarket個slug**尾有年份**
    // (見daily_log.js fetchHkMarketPrices個註解)。一路試緊冇年份嗰個,
    // 所以夠鐘夠命中都要靠下面個fallback。兩個都試,有年份行先。
    const y = Number(dateStr.split("-")[0]);
    const slugs = [
      `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}-${y}`,
      `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}`,
    ];
    const slug = slugs[0];

    let target = null;
    for (const s of slugs) {
      const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${s}`);
      if (!res.ok) return json({ error: `Gamma API ${res.status}` }, 502);
      const events = await res.json();
      const hit = Array.isArray(events) ? events[0] : null;
      if (hit) { target = hit; break; }
    }

    // slug命中唔到→掃weather tag用title配對(應對slug格式唔同嘅城市)
    // ⚠️同日發現:個API寫limit=200但實際最多回100個,一版掃唔晒 → 要分頁
    if (!target) {
      const all = [];
      for (let offset = 0; offset < 600; offset += 100) {
        const res2 = await fetch(`https://gamma-api.polymarket.com/events?closed=false&limit=100&offset=${offset}&tag_slug=weather`);
        if (!res2.ok) break;
        const page = await res2.json();
        if (!Array.isArray(page) || !page.length) break;
        all.push(...page);
        if (page.length < 100) break;
      }
      const cityName = city.replace(/-/g, " ");
      const titleRe = new RegExp(`highest temperature in ${cityName} on ${MONTHS[m - 1]} ${d}\\b`, "i");
      target = all.find((ev) => titleRe.test(ev.title || "")) || null;
    }

    if (!target) return json({ found: false, slug });

    const { buckets } = parseBuckets(target);
    return json({
      found: true,
      title: target.title,
      url: `https://polymarket.com/event/${target.slug}`,
      buckets,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
