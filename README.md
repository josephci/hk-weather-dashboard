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
| backfill_forecasts.js | 手動觸發 | 補「有實測冇預測」嘅爛行(cron bug遺留) |
| scan_cities.js | GitHub Actions | 全球49市場edge掃描,每6小時 |
| alert.js | GitHub Actions(後備) | 同worker邏輯,兼記history.csv(commit去data branch) |
| nightly_check.js | GitHub Actions | 每晚22:10健康檢查(Actions fail/bias停滯/main污染)→Telegram |
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
- ⚠️sampleDays講過大話(2026-08-01修):computeBias用 `forecasts[m] !== ""`
  判斷有冇數,但settle新建嘅行係 `undefined`,而 `undefined !== ""` 係true
  → 每次settle虛報+1日。所以見過「1日數據」但一個預測都冇。
  一律用 hasVal() 判斷
- 遠程城市bias(2026-07-16起累積):daily_log每朝記ZSPD/ZBAA/EGLC/LFPB嘅6模型預測
  (forecast_log_{city}.csv),每晚用METAR 48hr報文結算「當地昨日」最高
  (揀昨日因為倫敦嗰邊HK23:45先下晝);儲夠7日bias.json出cities key,
  dashboard/scanner自動由「未校正」轉「✓已校正」,std×1.4補償同時取消
- aviationweather嘅reportTime係"YYYY-MM-DD HH:MM:SS"UTC但冇Z,直接
  new Date()會當本地時間——一律經metarTimeIso()轉ISO先用
- 🔒鎖定策略:「N or higher」bucket一旦當日METAR max實現>=N,結果已確定,
  90-95¢買YES食5-10%係無模型風險嘅(剩返結算源對錯+METAR修正風險);
  「半鎖」(單度bucket,floor(max)啱好喺格內)仲有升穿風險,夜晚先算實
- ⚠️倫敦market係°F開盤!模型機率/edge/鎖定判斷全部要跟market單位計,
  pollCnCity會由bucket label自動偵測°F並轉晒成套(°C對照另外顯示);
  0¢/100¢係凌晨未有流動性嘅假價,顯示「市未開價」+鎖定判斷剔除(3-97¢先有效)
- polymarket function有slug fallback:直接命中唔到就掃weather tag用title配對
  (應對巴黎等slug格式唔同嘅城市)
- 🌧升返風險(遠程城市):METAR wxString(RA/SHRA/TS=落緊水,事實非預測)+
  Open-Meteo逐小時(過去1hr/未來2hr雨+今日餘下模型最高)→「升穿今日max風險」
  高/中/低;倫敦7月19-21°C係海洋性氣候正常事,唔好用香港直覺估溫度
- Open-Meteo嘅hourly precipitation=「之前一小時總量」,current hour嗰格
  就係過去1hr
- ⚠️Cloudflare Workers嘅fetch()預設經edge cache!HKO CSV試過俾佢食住
  舊版個零鐘(2026-07-25,dashboard「讀數唔更新」)——所有上游fetch一律
  cache:"no-store"
- dashboard live讀數都做埋雙水喉:1分鐘CSV(0.1°)滯後>20分鐘就自動轉
  rhrread(整數,快4分),UI標「rhrread後備」;滯後>30分鐘出⚠️HKO源頭滯後

## Hosting（Netlify ⇄ Cloudflare Pages兩邊都跑得）

前端統一打`/api/temperature`同`/api/polymarket`:
- **Netlify**: netlify.toml嘅redirect駁去netlify/functions/(有CDN cache header)
- **Cloudflare Pages**: functions/api/*.js直接命中(Workers runtime)

轉Cloudflare步驟(一次過,~5分鐘):
1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 揀呢個repo,production branch=main,Framework=None,build command留空,output directory=`/`
3. Deploy完會有*.pages.dev網址,即刻用得

點解值得轉:Netlify係credit/月(爆一次鎖成個月,2026-07試過),CF係10萬request/**日**
(每日reset),dashboard優化後用量~3千/日=CF日限3%,爆極都爆唔到。
worker.js(警報系統)一直都喺Cloudflare,同一個帳戶。

## 自我校準機制（2026-08加）

三個feedback loop,全部唔使人手維護:

| 機制 | 邊度學 | 用嚟做乜 |
|---|---|---|
| bias.json | daily_log每日「模型預測vs實測」 | 修正6模型系統性偏差(HK+4城市) |
| maxGrowth校準 | history.csv 27日日內軌跡 | 「今日max仲會生長幾多」上限,取代手作估算 |
| calibration_log.csv | 每朝記機率、晚上對答案 | 可靠度表:「話70%實際中幾多%」 |

⚠️maxGrowth量度嘅係 `finalMax - 當時todayMax`(max仲會生長幾多),
**唔係** `finalMax - 當時氣溫`——後者喺夜晚會誤讀成「仲可以升5度」
(其實只係溫度跌咗返),第一版就係咁中招,個表夜晚仲大過朝早先發現。

### 模型已被超越(model beaten)

實測max追過模型平均、而高峰時段(<16時)未完 = 硬證據話俾你聽今日模型低估咗。
呢個情況會做三件事:
1. **停止向下修**(唔再applied雨天修正)——錯上加錯
2. **放闊分佈**:effStd = √(std² + 已證實誤差²)
3. **溝純軌跡分佈**:條件化本身會將「模型話低過實測」嘅機率全部塞入實測嗰格,
   模型錯得越犀利嗰格個%就越高(實測:模型錯2.1°竟然畀到93%)=假信心。
   純軌跡分佈完全唔用模型,淨係問「歷史上呢個鐘之後max仲會生長幾多」
   (經驗CDF),按誤差大細溝入去:錯1°溝50%、錯2°溝67%

效果(2026-08-02真實個案,11:53實測28.8°vs模型28.4°):
28°:83% → 72%,30°由0% → 8%、31°由0% → 3%

## Secrets清單

- GitHub: TG_BOT_TOKEN, TG_CHAT_ID
- Cloudflare Worker: TG_BOT_TOKEN, TG_CHAT_ID + KV binding "STATE"

## 交易警示

模型% vs 市場價差距大,先假設自己錯。惡劣天氣日減注。呢個係決策輔助,唔係財務建議。

## 快水喉(rhrread)捨入特性 — 交易含意

rhrread係**四捨五入**（200樣本驗證：179個吻合round-half-up，101個
小數≥.5被入上）。即係讀到 `26` 代表真值喺 **[25.5, 26.5)**。

⚠️ 後果：「快水喉搶先破關」訊號**唔係實破**。rhrread啱啱跳上26嗰陣，
26.0關口只係大約一半機會破咗。用CSV已知max做下限可以收窄：

| rhrread | CSV已知max | 真值區間 | 26.0關口破咗嘅機會 |
|---|---|---|---|
| 26 | 25.2 | 25.5–26.5 | 50% |
| 26 | 25.8 | 25.8–26.5 | 71% |
| 26 | 25.95 | 25.95–26.5 | 91% |

worker.js/alert.js已經改成報實際百分比，唔再講「大概率已破」。
`rounding_probe.js` 可以繼續查例外個案（例外集中喺小數.4–.6 = 時間差
造成，規則本身冇問題；例外散開 = rhrread可能係另一個量度，要重新評估）。

## 深圳 vs 香港（點解定價唔同）

兩地相隔~27km,但**唔可以當同一注**:

1. **結算站唔同**——香港=天文台總部(尖沙咀市區,0.1°精度);深圳=?
   ⚠️**未驗證**。深圳市中心站同寶安機場(ZGSZ,METAR整數)差好遠,
   落注前一定要開market描述對清楚(倫敦錯用Heathrow就係教訓)。
2. **地理唔同**——天文台總部貼住維港,受海風調節;深圳市中心離開闊海遠啲,
   夏天日間高溫通常較高。
3. **bucket分界**——即使溫度接近,兩邊落喺唔同整數格好常見,
   即係話兩個market本質上係兩注唔同嘅嘢。

`spread_probe.js` 可以量實際差幾多(ERA5存檔,apples-to-apples):
Actions → Spread Probe → 揀兩個地點。睇「平均差」(系統性偏差,可以搬去
對方模型度)同「標準差」(每日波動,大=唔跟得貼,唔好靠一邊估另一邊)。
