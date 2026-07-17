# HK Weather Dashboard — Polymarket溫度市場交易系統

香港深度線 + 上海北京倫敦METAR線 + 全球49市場掃描。

## 系統架構

```
數據源                     處理層                      輸出
─────────                ─────────                   ─────────
HKO 1min CSV(0.1°,慢8分) ┐
HKO rhrread(整數,快4分)   ├→ Cloudflare Worker(每分鐘) → Telegram警報
HKO warnsum警告          ┘   雙水喉+破關+edge+METAR
ZSPD/ZBAA/EGLC/LFPB METAR
Open-Meteo 6模型         ┬→ Netlify Functions        → Dashboard網頁
Polymarket Gamma API     ┘   temperature/polymarket     (5城市tabs)
                         
                         GitHub Actions:
                         - daily-bias(朝晚): bias.json自動校正
                         - scan-cities(6hr): 全球49市場edge掃描
                         - temp-alerts(後備): history.csv記錄
```

## 檔案對照表

| 檔案 | 跑喺邊 | 做乜 |
|---|---|---|
| index.html | Netlify | dashboard:5城市/即時/機率/走勢圖/METAR趨勢/Edge表/🔒鎖定機會 |
| netlify/functions/temperature.js | Netlify | 代理HKO CSV+METAR(即時/歷史/任意機場)(解決CORS) |
| netlify/functions/polymarket.js | Netlify | 代理Gamma API:單城市現價+trending市場發現 |
| worker.js | Cloudflare | 主力警報:每分鐘,雙水喉+4警報+edge+中國METAR |
| daily_log.js | GitHub Actions | 朝07:15記預測/晚23:45記實測+計bias(HK+滬京倫巴5城市) |
| backfill_bias.js | 手動一次 | 回填歷史bias(已完成,26日) |
| scan_cities.js | GitHub Actions | 全球49市場edge掃描,每6小時 |
| alert.js | GitHub Actions(後備) | 同worker邏輯,兼記history.csv(commit去data branch) |
| watch.js | 本機(可選) | 秒級精度本地監察 |
| latency_race.js | 本機(實驗) | 渠道延遲測量 |

## 關鍵發現記錄(俾未來嘅自己)

- rhrread整點讀數~04分出,1min CSV~08分先出 → 雙水喉設計嘅由來
- 6模型系統性低估HK總部1-2°C(熱島),bias.json自動校正緊
- 颱風/雷暴日模型可以錯5σ(2026-07-05實例:預測30.5°實開33°) → 警告日std×1.8
- 落雨日反向版:實測落緊雨(rhrread)+模型高峰時段(12-16)預測雨 → 今日高溫
  階梯將分佈移低0.4-1.5°+std×1.3。注意:均勻砍upside bucket再歸一係no-op
  (比例唔變),一定要移mean先有真效果
- 上海北京market結算源=機場METAR整數,冇小數呢回事
- Wunderground嘅x.1°係°F換算殘影,唔係真精度
- 倫敦結算站=EGLC倫敦城市機場(2026-07-17更正,以前錯用Heathrow);
  巴黎結算站=LFPB布爾歇機場;落注前都要對返market描述
- aviationweather.gov嘅metar API有hours=參數可以攞返成日報文
  → METAR趨勢圖唔使自己儲,每次現攞現砌(有變化先算一點)
- history.csv+alert_state.json嘅log commit住咗喺data branch(每2hr一個,
  以前灌爆main history);bias.json/forecast_log.csv一日先兩個commit,留喺main
  (BIAS_URL同scan_cities.js都讀main,唔值得搬)
- ⚠️歷史bug(2026-07-16修):bucket機率對「86-87°F」兩度一格只計咗第一個數,
  美國°F市場全部兩度一格→模型%以前一直被低估近半,舊edge訊號要重新審視
- 遠程城市bias(2026-07-16起累積):daily_log每朝記ZSPD/ZBAA/EGLC/LFPB嘅6模型預測
  (forecast_log_{city}.csv),每晚用METAR 48hr報文結算「當地昨日」最高
  (揀昨日因為倫敦嗰邊HK23:45先下晝);儲夠7日bias.json出cities key,
  dashboard/scanner自動由「未校正」轉「✓已校正」,std×1.4補償同時取消
- aviationweather嘅reportTime係"YYYY-MM-DD HH:MM:SS"UTC但冇Z,直接
  new Date()會當本地時間——一律經metarTimeIso()轉ISO先用
- 🔒鎖定策略:「N or higher」bucket一旦當日METAR max實現>=N,結果已確定,
  90-95¢買YES食5-10%係無模型風險嘅(剩返結算源對錯+METAR修正風險);
  「半鎖」(單度bucket,floor(max)啱好喺格內)仲有升穿風險,夜晚先算實

## Secrets清單

- GitHub: TG_BOT_TOKEN, TG_CHAT_ID
- Cloudflare Worker: TG_BOT_TOKEN, TG_CHAT_ID + KV binding "STATE"

## 交易警示

模型% vs 市場價差距大,先假設自己錯。惡劣天氣日減注。呢個係決策輔助,唔係財務建議。
