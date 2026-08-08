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
Polymarket Gamma API     ┘   temperature/polymarket     (6城市tabs)
                         
                         GitHub Actions:
                         - daily-bias(朝晚): bias.json自動校正
                         - scan-cities(6hr): 全球49市場edge掃描
                         - temp-alerts(後備): history.csv記錄
```

## 檔案對照表

| 檔案 | 跑喺邊 | 做乜 |
|---|---|---|
| index.html | Netlify | dashboard:6城市/即時/機率/走勢圖/METAR趨勢/Edge表/🔒鎖定機會 |
| netlify/functions/temperature.js | Netlify | 代理HKO CSV+METAR(即時/歷史/任意機場)(解決CORS) |
| netlify/functions/polymarket.js | Netlify | 代理Gamma API:單城市現價+trending市場發現 |
| worker.js | Cloudflare | 主力警報:每分鐘,雙水喉+4警報+edge+中國METAR |
| daily_log.js | GitHub Actions | 朝07:15記預測/晚23:45記實測+計bias(HK+滬京倫巴深6城市) |
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

### 實測結果(ERA5 61日,2026-05-27→07-26)

**深圳寶安(ZGSZ) = 香港天文台總部 + 1.22°C，σ僅0.84°**
- 93%日子深圳較熱(61日得4日香港贏)——方向極穩定
- p10 +0.2° / p50 +1.3° / p90 +2.2°；極端日去到+3.2°
- **但只有8%日子落喺同一個整數bucket**

點用:
1. σ0.84°同模型自己嘅分歧(0.8-1.9°)同一量級 → 「香港預測+1.2°」係
   一個可用嘅深圳先驗,但要將σ加埋落去(√(σ模型²+0.84²))
2. 8%同bucket = **唔可以照抄香港嘅倉去深圳**,一定要用移咗位嘅分佈
   重新計bucket機率
3. ⚠️ERA5係模型格點,唔係實測站。真實站對站差異(城市熱島、微氣候)
   可能更大——呢個數字係方向參考,唔係精準offset

`spread_probe.js`:Actions → Spread Probe → 揀兩個地點(支援
hk/hk-airport/shenzhen/shenzhen-airport/guangzhou)。

## ⚠️ GitHub cron延遲實測（排schedule必讀）

2026-08實測:daily-bias個settle班排14:15 UTC,實際跑喺15:18–16:40 UTC,
**延遲63–145分鐘**。排schedule一定要留呢個buffer,尤其涉及「當地日界」嘅嘢:
- settle排22:15 HKT → 延遲後衝過香港午夜 → daily_log保險掣skip咗香港settle
  → 連續3日冇實測入賬(2026-08-03至05),而個系統靜靜雞冇聲出
- 已改排20:15 HKT(12:15 UTC),留3小時45分buffer

教訓:任何「要喺當地某日之內完成」嘅排程,buffer要照最壞延遲(~2.5小時)計。

## 「市場快過天文台」——點查

用戶長期直覺:Polymarket香港市場反應快過HKO公佈。`market_race.js` 就係
用嚟證實/推翻呢個直覺(Actions → Market Race,建議跑香港下晝12:00-17:00)。

已知嘅結構性延遲(要實測確認):
| 渠道 | 更新頻率 | 出街延遲 | 精度 |
|---|---|---|---|
| HKO 1分鐘CSV(dashboard用緊) | 每10分鐘 | ~8分鐘 | 0.1° |
| HKO rhrread | 每小時 | ~4分鐘 | 整數 |
| HKO網站內部JSON | ? | ? | ? |
| VHHH METAR | :00/:30(+SPECI) | 1-2分鐘 | 整數 |

即係話同一個觀測時刻,用METAR嘅人可能比用CSV嘅**早6-16分鐘**知。

但要留意三個非觀測解釋,唔好一見市場郁就當人哋有內幕:
1. **市場定價嘅係「今日最高溫」,唔係「而家幾多度」**——過咗高峰佢即刻鎖定,
   而HKO嘅「今日至今最高」欄要等下個發佈週期先反映
2. **模型跑新一輪**(GFS 00/06/12/18Z、ECMWF 00/12Z)落地會令成個預測重新定價,
   同觀測完全無關
3. **流動性薄**——一張大單就推得郁,可能係order flow唔係資訊

market_race會分辨到:如果「市場跟尾METAR、行先CSV」→ 答案就係渠道問題,
換水喉就追得返;如果「所有公開渠道都喺市場之後」→ 先至係真.行先。

## 2026-08-06 三個顯示bug（用戶截圖捉到）

朝早8:53個dashboard顯示「赤鱲角METAR 34.0° 下午03:00」——8點幾唔可能34度,
而個時間睇落似係啱啱。查完三個獨立問題:

1. **METAR揀錯報文**:aviationweather一個站可能返多份報文(唔保證順序),
   舊code係「最後入嘅贏」,所以攞到18個鐘前嗰份。改為一律揀obsTime最新。
2. **時間顯示呃人**:formatRelativeTime超過60分鐘就淨顯示個鐘數,
   一個18小時前嘅讀數顯示成「下午03:00」,完全睇唔出係舊。
   改為一律標明幾耐之前,>3小時加⚠️,跨日顯示「N日前」。
3. **未來1小時panel卡住**:pollHourNowcast喺`currentRealized`set之前
   被call(喺處理雨量嗰度),第一次poll實係null → 卡住「等緊即時讀數…」。
   改為喺currentRealized set咗之後先call。

## 紙上交易（放真錢之前必做）

`paper_trade.js` 用**真市價、真訊號**跑鎖定策略，但唔使真錢。
Actions會自動跑（各地見頂後掃訊號、每晚結算），成績入 `paper_trades.csv`。

保守假設（寧願低估自己）：
- 成交價 = 現價 + 2¢ 買賣差價
- 每注固定$10（唔用Kelly，避免後見之明放大回報）
- 3¢以下/97¢以上唔掂（流動性差）

**最重要嗰個指標**：如果有「已鎖」嘅注竟然輸咗，理論上唔應該發生——
即係結算源配錯、METAR攞到舊數據、或者bucket判斷有bug。報告會標紅提你。
呢個係放真錢之前一定要查清楚嘅嘢。

⚠️ 點解一定要先做呢步：2026-08-06發現METAR會攞到18個鐘前嘅舊報文，
即係鎖定訊號會用錯咗嘅「已實現max」計。如果嗰陣已經自動化，
佢會真金白銀買入假訊號。**機器唔會貪心，但機器同樣唔會覺得
「8點幾34度好似唔對路」**——自動化會放大數據錯誤，唔會過濾。

## ⚠️⚠️ σ校準：模型分歧 ≠ 預測誤差（2026-08-08 重大發現）

用56日香港數據做leave-one-out診斷，發現個**根本性問題**：

| 城市 | std(z) | 意思 |
|---|---|---|
| **香港** | **3.58** | 真實不確定性係模型σ嘅3.6倍 |
| 倫敦 | 1.92 | |
| 北京 | 1.35 | |
| 上海 | 0.92 | ✓正常 |
| 巴黎 | 0.58 | 反而過闊 |

香港只有**29%**結果落喺±1σ內（理論應該68%），39%落喺±2σ內（理論95%）。

**點解**：6模型嘅spread量度嘅係「模型之間爭議幾多」，唔係「預測有幾唔準」。
啲模型share住相似物理同初始場，所以佢哋一致唔代表啱。而城市差異好合理——
越市區/微氣候複雜嘅結算站，低估得越犀利（HKO總部係尖沙咀市區山丘，
模型預測嘅係~10km格點平均）。bias校正到平均偏差，但校正唔到
「每日偏差幾多」嘅波動。

**後果有幾嚴重**（實測同一日數據）：
```
σ未校準:  33°:70%  ← 你會以為好穩陣
σ校準後:  30°:4% 31°:11% 32°:19% 33°:23% 34°:21% 35°:13% 36°:6%
```
市場price 33° 喺60¢，你以為70%有+10%edge，實際只值23¢。**買貴3倍。**

**已修**：`daily_log.js` 每晚連 `sigmaScale` 一齊計入 `bias.json`（每個城市獨立），
dashboard（今日/明日/遠程城市）同 `scan_cities.js` 全部自動應用。
`model_diagnostics.js` 可以隨時重跑睇最新校準狀況。

註：🔒鎖定策略**唔受影響**——佢完全唔用模型機率，只用已實現事實。
呢個亦係點解紙上交易由鎖定策略開始係啱嘅。
