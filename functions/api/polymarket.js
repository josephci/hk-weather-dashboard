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

    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: CITY_TZ[city], year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const [, m, d] = dateStr.split("-").map(Number);
    const slug = `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}`;

    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!res.ok) return json({ error: `Gamma API ${res.status}` }, 502);
    const events = await res.json();
    let target = Array.isArray(events) ? events[0] : null;

    // slug命中唔到→掃weather tag用title配對(應對slug格式唔同嘅城市)
    if (!target) {
      const res2 = await fetch("https://gamma-api.polymarket.com/events?closed=false&limit=200&tag_slug=weather");
      if (res2.ok) {
        const all = await res2.json();
        const cityName = city.replace(/-/g, " ");
        const titleRe = new RegExp(`highest temperature in ${cityName} on ${MONTHS[m - 1]} ${d}\\b`, "i");
        target = (Array.isArray(all) ? all : []).find((ev) => titleRe.test(ev.title || "")) || null;
      }
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
