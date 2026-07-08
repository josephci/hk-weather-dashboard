// netlify/functions/polymarket.js
// ------------------------------------------------------------
// 用途：代理Polymarket Gamma API，攞當日指定城市溫度market嘅
//       各bucket現價，俾dashboard嘅Edge panel用。
//       經自己function代理=冇CORS風險，slug直接命中=payload細。
//
// 用法：/.netlify/functions/polymarket?city=hong-kong
//       city支援: hong-kong | shanghai | beijing
// ------------------------------------------------------------

const SUPPORTED = ["hong-kong", "shanghai", "beijing"];
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

exports.handler = async function (event) {
  try {
    const city = (event.queryStringParameters?.city || "hong-kong").toLowerCase();
    if (!SUPPORTED.includes(city)) {
      return { statusCode: 400, body: JSON.stringify({ error: `city要係: ${SUPPORTED.join("/")}` }) };
    }

    // 三個城市都係UTC+8，用香港時間計「今日」
    const hk = new Date(Date.now() + 8 * 3600 * 1000);
    const y = hk.getUTCFullYear(), m = hk.getUTCMonth(), d = hk.getUTCDate();
    const slug = `highest-temperature-in-${city}-on-${MONTHS[m]}-${d}`;

    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Gamma API ${res.status}` }) };
    }
    const events = await res.json();
    const target = Array.isArray(events) ? events[0] : null;
    if (!target) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ found: false, slug }),
      };
    }

    const buckets = [];
    for (const mkt of target.markets || []) {
      let yesPrice = null;
      try {
        const prices = JSON.parse(mkt.outcomePrices || "[]");
        yesPrice = prices[0] !== undefined ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch { /* ignore */ }
      const label = (mkt.groupItemTitle || mkt.question || "").trim();
      if (yesPrice !== null && label) buckets.push({ label, yesPrice });
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        found: true,
        title: target.title,
        url: `https://polymarket.com/event/${target.slug}`,
        buckets,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
