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

### 補記（2026-08-20）：兩個跟進問題

**① 香港個 `sigmaScale` 由頭到尾冇寫入 `bias.json`。**
`computeBias()` 一直有計，但 `settleAndWriteBias()` 個 output object 冇寫落去。
結果係5個遠程城市全部有σ校準，得香港——即係真正落注嗰個——冇。
Dashboard 讀唔到就當1，個階梯繼續過份自信（29°C 報 79%）。
呢種 bug 唔會有錯誤訊息，所以 `nightly_check.js` 加咗直接驗 bias.json 有冇齊σ校準欄。

**② 淨係「乘個倍數」係錯嘅補救法。**
香港 `corr(模型σ, |實際誤差|) = −0.15` — 模型分歧喺香港**完全冇 per-day 預測力**。
乘 3.4 之後：模型σ=0.20 嘅日變 0.68°（仲係過份自信，真實誤差std係1.63°），
模型σ=1.68 嘅日變 5.7°（階梯攤到 25–34°C，完全冇資訊）。等於將噪音放大3.4倍。

正解係睇 corr 決定信 per-day 定信常數：

```
σ² = w·(模型σ × sigmaScale)² + (1−w)·sigmaAbs²      w = clamp(corr, 0, 1)
```

| 城市 | sigmaAbs | sigmaScale | corr(σ,\|誤差\|) → w | 效果 |
|---|---|---|---|---|
| 香港 | 1.63° | 3.40 | −0.15 → **0** | 直接用常數 1.63°，唔理當日分歧 |
| 上海 | 0.86° | 0.91 | +0.53 | 分歧真係有訊號，一半跟 per-day |
| 巴黎 | 0.64° | 0.86 | +0.41 | 一半跟 per-day |
| 北京 | 0.99° | 1.08 | +0.21 | 主要跟常數 |
| 倫敦 | 0.80° | 1.54 | +0.20 | 主要跟常數 |

聽日 mean=29.6° 三個做法對比：

```
未校準  σ=0.80  → 28°:20%  29°:46%  30°:27%
×3.4    σ=2.72  → 25°:5% … 29°:15% … 34°:3%     ← 攤到冇資訊
新方案  σ=1.63  → 27°:11%  28°:19%  29°:24%  30°:21%  31°:12%
```

**分歧有冇用係逐個城市唔同嘅，唔可以一刀切。**

註：🔒鎖定策略**唔受影響**——佢完全唔用模型機率，只用已實現事實。
呢個亦係點解紙上交易由鎖定策略開始係啱嘅。

## 🩺 Polymarket 健康狀態（`/api/pmstatus`）

**2026-08-24 加**：Polymarket down 咗，連交易都做唔到，但個 dashboard 淨係寫
「今日market未搵到」—— 同「市場未開盤」「slug變咗」一模一樣嘅一句。
分唔清係人哋 down 咗定自己壞咗，就會去查錯方向。

個 endpoint 分開探三樣，**唔夾埋一齊報**：

| 探邊個 | 答到咩 |
|---|---|
| `status.polymarket.com` (Statuspage v2) | 總體狀態、進行中事故、**維護窗口（幾時開始／幾時完）** |
| `gamma-api` | 市場數據 —— dashboard 啲價、edge、鎖定全部靠佢 |
| `clob` | **交易 API** —— 落單、order book |

**②③ 一定要分開探**：見過好多次數據 API 正常但交易 API 死，
個網睇落乜事都冇，但你就係落唔到單。

頭條排序（**維護排喺 API 死咗之前**）：

```
🔧 Polymarket 維護緊(交易停) · 預計8月25日 04:00完     ← 維護緊 + 交易停
🔧 Polymarket 維護緊 · 預計8月25日 04:00完            ← 維護緊但交易仲通
⚠️ Polymarket 數據同交易都連唔到
⚠️ 交易API唔通(落唔到單)
⚠️ 市場數據API唔通(下面啲價會空白)
⚠️ Polymarket 有事故
Polymarket 正常(有排期維護)
Polymarket API通(官方狀態頁讀唔到)                    ← 唔會扮綠燈，亦唔會扮有事
Polymarket 正常
```

維護緊嘅時候 clob 一定唔通。如果照排「交易API唔通」喺前面，
就係**報咗個症狀、藏起個原因同「幾時完」**—— 同呢個 repo 一路要修
嗰種「一句 log 冚晒幾個死因」係同一個病。

其他原則：

- **永遠唔會 default 做綠燈。** 狀態頁讀唔到就講「讀唔到」，唔會當「冇事故」。
- 我哋自己個 function 死咗 ≠ Polymarket 死咗，兩件事分開講。
- 交易 API 應機 **唔等於**你落到單（仲要睇錢包同簽名）—— 唔好講死。
- 平時縮成一行、靜色；出事先撐開變紅。正常唔應該霸位。
- Edge / 🔒 panel 攞唔到市場嗰陣，會補一句「（Polymarket數據API而家唔通,唔關你事）」。

⚠️ 呢個 sandbox 個 proxy 封晒 `polymarket.com` / `status.polymarket.com`（403），
所以真實 response shape 驗證唔到。全部 defensive parse，
另外用 8 個 mock 情境行過真 code（`onRequest` + 頭條邏輯）確認過分類啱。

## ⚠️ 市場跟VHHH、結算跟HKO — 兩者之間個楔子

如果 `market_race.js` 證實市場跟住VHHH METAR郁（快6-16分鐘），
但結算源係HKO總部，噉兩個站之間嘅差距就唔係學術問題，而係錢：

| 情況 | 意思 |
|---|---|
| **VHHH過關，HKO冇** | 市場以為鎖咗推上90¢+，但結算唔會中 → **跟市場買 = 買咗個唔存在嘅鎖定** |
| **HKO過關，VHHH冇** | 你（睇結算源）已經知鎖咗，市場（睇代理）未反應 → **買得平** |

VHHH係機場、HKO總部係尖沙咀市區，兩者差1-2°C（README一早記低）。
一個1°嘅系統性楔子，喺整數bucket世界入面足以令兩邊講完全唔同嘅故事。

**你個系統已經企啱邊**：香港嘅🔒鎖定判斷用HKO maxmin CSV（結算源本身），
VHHH只係顯示參考。所以你唔會中「假鎖」嗰個伏。

`station_wedge.js` 量度呢個楔子：逐個整數關口統計「假鎖幾多日 / 早知幾多日」。
daily_log每晚settle順手記低兩邊當日最高（→ `station_wedge.csv`），
數據自動累積，過幾日就跑得出。

⚠️ 呢套分析嘅前提係「市場真係跟VHHH」——**先跑 market_race.js 證實咗
先好當真**。如果市場其實跟HKO網站JSON（都快過開放數據），
噉個楔子就唔存在，要另外諗。

## 兩個關鍵對比（2026-08-13加）

### 🔑 鎖定 vs 模型（`paper_trade.js`）

紙上交易同時跑兩類訊號，**分開記帳**，因為佢哋答唔同問題：

| 訊號 | 靠乜 | 賺唔賺錢代表 |
|---|---|---|
| 🔒 LOCK | 已實現事實，唔用模型 | 結算源配得啱唔啱 |
| 📊 MODEL | 完全靠模型機率(edge≥12點) | 你有冇真預測edge |

報告會直接判：模型都賺 → 值得調模型(規模大過鎖定好多)；
模型打和/蝕 → 鎖定先係你嘅真edge，唔好花時間調模型。

### 🎯 模型 vs 市場（`calibration_log.csv`）

以前個log只記「模型話幾多% + 中唔中」——答到「模型準唔準」，
答唔到「**模型有冇贏過市場**」。而家順手記埋當時市價，
用Brier score對比（越細越準）：

- 打和 → 你冇model edge，專心做鎖定
- 模型贏 → 有真edge，值得繼續調
- 市場贏 → 跟模型落注會蝕俾市場，model訊號要停

⚠️ 市價由2026-08-13起先開始記，要20+個配對樣本先出對比。
舊格式(4欄)向後兼容，唔會爛。

> **⚠️ 2026-08-20 教訓：加欄一樣可以靜靜哋整爛個 feedback loop。**
> `daily_log.js` 加咗 `marketPrice` 由4欄變5欄，但 `index.html` 個 parser
> 仲讀住「第4欄=hit」。結果70個已結算樣本全部被 filter 走，可靠度表變
> 「累積緊（0/20個樣本）」——冇報錯、冇紅字，個表就係空白。
> 已改成兩種格式都食得，而 `nightly_check.js` 加咗一項：照 dashboard
> 嘅規矩讀一次 calibration_log，讀到0個就當問題報。
> **教訓：改CSV schema要同時搵晒所有 reader，唔係淨係改 writer。**

> **⚠️ 2026-08-22 續集：嗰欄市價，開咗10日一格都冇記到。**
> 92行全部空白。原因唔喺 schema，而喺**時間**：`recordCalibForecast()` 喺
> forecast 班跑，即係香港 07:15 —— 但香港 market 通常當日下晝先開盤
> （dashboard 自己個 panel 都寫住「聽日market未開(通常當日下晝先開盤)」）。
> 7點鐘去 `gamma-api` 攞，個 event 根本未存在，永遠 `{}`。
> 「模型 vs 市場」由開波嗰日起就係死嘅，冇任何錯誤訊息。
> **已修**：另開 `--mode=market` 班，香港 13:00 同 16:00 各跑一次，
> 淨係填返仲空白嗰啲格（已有價嘅唔覆蓋——保住最早嗰個報價，
> 資訊優勢最細，同 07:15 出嘅模型比先公道）。
> `nightly_check.js` 加咗一項：市價欄成片空白就報。
> **教訓：一個 job 攞唔攞到數據，除咗睇 code 啱唔啱，仲要睇佢幾點跑。**

> **⚠️ 2026-08-23 續集之二：改咗時間，一樣攞唔到。**
> 新嘅 `market` 班確認有跑（05:30 UTC 同 08:19 UTC 兩次，都 success），
> 但兩次都印「market未開盤/攞唔到價」。而前一日 16:51 HKT，dashboard
> 明明見到 `31°C @ 99¢` —— 即係 16:19 HKT 個 market 一定存在。
>
> 分別喺兩條路唔同步：`functions/api/polymarket.js`（dashboard 行嗰條）
> 一早有個 **title fallback**，佢自己個 comment 寫住「slug命中唔到→掃
> weather tag用title配對（應對slug格式唔同嘅城市）」——作者早就知 slug 會 miss。
> `daily_log.js` 嗰條**冇**，一 miss 就靜靜哋 `return {}`。
> **已修**：daily_log 補返同一個 fallback，加多一班 15:00 HKT。
>
> **仲有個更闊嘅教訓**：原本嗰句「市場未開盤/攞唔到價」一句冚晒三個
> 完全唔同嘅死因（API 唔通 / slug 格式變 / bucket label 變），
> 所以查咗成日先知係邊個。而家會 print 返 status code、試過嘅 slug、
> weather tag 攞返幾多個 event、見到嘅 label 係乜。
> **一句分唔清死因嘅 log，本身就係 bug。**
>
> ⚠️ 唔會排更夜嘅班：香港高溫 14-15 時見頂，再夜嘅市價已經接近結算價，
> 攞返嚟同 07:15 出嘅模型比就係送分，個 Brier 對比會變廢數。
> 攞唔到寧願冇，唔好攞個唔公道嘅價。

### 已知現況（70個真實樣本）

可靠度表已經獨立證實咗σ問題：
```
0-10%:  講5%  實際15% ↑低機率反而低估
10-25%: 講18% 實際14% ✓準
25-50%: 講34% 實際25% ↓過份自信
50-75%: 講57% 實際0%  ↓過份自信
```
低機率準、高信心完全唔中 = σ太窄嘅典型特徵，同 `model_diagnostics.js`
算出嘅 std(z)=3.58 **兩個獨立方法得出同一結論**。
