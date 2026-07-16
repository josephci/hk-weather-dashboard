# HK Weather Dashboard — Polymarket溫度市場交易系統

香港深度線 + 上海北京倫敦METAR線 + 全球49市場掃描。

## 系統架構

```
數據源                     處理層                      輸出
─────────                ─────────                   ─────────
HKO 1min CSV(0.1°,慢8分) ┐
HKO rhrread(整數,快4分)   ├→ Cloudflare Worker(每分鐘) → Telegram警報
HKO warnsum警告          ┘   雙水喉+破關+edge+METAR
ZSPD/ZBAA/EGLL METAR     
Open-Meteo 6模型         ┬→ Netlify Functions        → Dashboard網頁
Polymarket Gamma API     ┘   temperature/polymarket     (4城市tabs)
                         
                         GitHub Actions:
                         - daily-bias(朝晚): bias.json自動校正
                         - scan-cities(6hr): 全球49市場edge掃描
                         - temp-alerts(後備): history.csv記錄
```

## 檔案對照表

| 檔案 | 跑喺邊 | 做乜 |
|---|---|---|
| index.html | Netlify | 4城市dashboard:即時/機率/走勢圖/METAR趨勢/Edge表 |
| netlify/functions/temperature.js | Netlify | 代理HKO CSV+4機場METAR+歷史METAR(解決CORS) |
| netlify/functions/polymarket.js | Netlify | 代理Gamma API攞market現價 |
| worker.js | Cloudflare | 主力警報:每分鐘,雙水喉+4警報+edge+中國METAR |
| daily_log.js | GitHub Actions | 朝07:15記預測/晚23:45記實測+計bias |
| backfill_bias.js | 手動一次 | 回填歷史bias(已完成,26日) |
| scan_cities.js | GitHub Actions | 全球49市場edge掃描,每6小時 |
| alert.js | GitHub Actions(後備) | 同worker邏輯,兼記history.csv |
| watch.js | 本機(可選) | 秒級精度本地監察 |
| latency_race.js | 本機(實驗) | 渠道延遲測量 |

## 關鍵發現記錄(俾未來嘅自己)

- rhrread整點讀數~04分出,1min CSV~08分先出 → 雙水喉設計嘅由來
- 6模型系統性低估HK總部1-2°C(熱島),bias.json自動校正緊
- 颱風/雷暴日模型可以錯5σ(2026-07-05實例:預測30.5°實開33°) → 警告日std×1.8
- 上海北京market結算源=機場METAR整數,冇小數呢回事
- Wunderground嘅x.1°係°F換算殘影,唔係真精度
- 倫敦tab跟scan_cities.js嘅convention用Heathrow(EGLL);Polymarket London market嘅
  結算源未逐隻驗證過,落注前對返market描述
- aviationweather.gov嘅metar API有hours=參數可以攞返成日報文
  → METAR趨勢圖唔使自己儲,每次現攞現砌(有變化先算一點)

## Secrets清單

- GitHub: TG_BOT_TOKEN, TG_CHAT_ID
- Cloudflare Worker: TG_BOT_TOKEN, TG_CHAT_ID + KV binding "STATE"

## 交易警示

模型% vs 市場價差距大,先假設自己錯。惡劣天氣日減注。呢個係決策輔助,唔係財務建議。
