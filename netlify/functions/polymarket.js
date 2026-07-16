// netlify/functions/polymarket.js
// ------------------------------------------------------------
// 用途：代理Polymarket Gamma API，攞當日指定城市溫度market嘅
//       各bucket現價，俾dashboard嘅Edge panel用。
//       經自己function代理=冇CORS風險，slug直接命中=payload細。
//
// 用法：/.netlify/functions/polymarket?city=hong-kong
//       city支援: hong-kong | shanghai | beijing | london
//       /.netlify/functions/polymarket?mode=trending
//       → 自動發現全部「Highest temperature in X」市場,按流動性排序
// ------------------------------------------------------------

// 每個城市用自己當地時區計「今日」（倫敦同香港差7-8個鐘，唔可以齊用HK時間）
const CITY_TZ = {
  "hong-kong": "Asia/Hong_Kong",
  "shanghai": "Asia/Shanghai",
  "beijing": "Asia/Shanghai",
  "london": "Europe/London",
};
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

// 由一個Gamma event抽bucket現價+單位(同scan_cities.js一致)
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

// 高流動性溫度市場發現(俾「熱門」tab用)
async function trending() {
  const res = await fetch("https://gamma-api.polymarket.com/events?closed=false&limit=200&tag_slug=weather");
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const events = await res.json();

  const found = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const m = (ev.title || "").match(/highest temperature in (.+?) on (.+)\?/i);
    if (!m) continue;
    const { buckets, unit } = parseBuckets(ev);
    if (!buckets.length) continue;
    found.push({
      city: m[1].trim().toLowerCase(),
      title: ev.title,
      url: `https://polymarket.com/event/${ev.slug}`,
      liquidity: Number(ev.liquidity) || 0,
      volume24hr: Number(ev.volume24hr) || 0,
      unit,
      buckets,
    });
  }
  found.sort((a, b) => b.liquidity - a.liquidity);
  return found.slice(0, 10);
}

exports.handler = async function (event) {
  try {
    if (event.queryStringParameters?.mode === "trending") {
      const markets = await trending();
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          // 發現+排名兩分鐘cache夠新鮮,慳invocation
          "Netlify-CDN-Cache-Control": "public, s-maxage=120, stale-while-revalidate=180",
        },
        body: JSON.stringify({ markets }),
      };
    }

    const city = (event.queryStringParameters?.city || "hong-kong").toLowerCase();
    if (!CITY_TZ[city]) {
      return { statusCode: 400, body: JSON.stringify({ error: `city要係: ${Object.keys(CITY_TZ).join("/")}` }) };
    }

    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: CITY_TZ[city], year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // YYYY-MM-DD
    const [, m, d] = dateStr.split("-").map(Number);
    const slug = `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}`;

    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Gamma API ${res.status}` }) };
    }
    const events = await res.json();
    const target = Array.isArray(events) ? events[0] : null;
    // CDN cache 60秒(下面found:true同樣):市價喺dashboard本身都係2分鐘先refresh,
    // 全部tab/device共用一次invocation,慳Netlify credit
    const CACHE_HEADERS = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Netlify-CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
    };

    if (!target) {
      return {
        statusCode: 200,
        headers: CACHE_HEADERS,
        body: JSON.stringify({ found: false, slug }),
      };
    }

    const { buckets } = parseBuckets(target);

    return {
      statusCode: 200,
      headers: CACHE_HEADERS,
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
