# 喺呢個repo做嘢嘅規矩

呢個係一個真金白銀落注嘅系統(Polymarket溫度市場)。
**寫錯一個數 = 蝕錢**,唔係「跑唔到」咁簡單。下面啲規矩全部係實際撞過板換返嚟。

## 語言

- 同用戶對話一律用**廣東話**。
- Code comment都寫廣東話,而且要寫**點解**同**幾時發現**,唔係寫個function做乜。
  好example:`// ⚠️2026-08-20發現:corr(模型σ,|誤差|)=−0.15,乘倍數等於放大噪音`
  廢example:`// 計算標準差`

## Git / PR

- 喺 `claude/github-optimization-uk-tab-m5h4ld` 開發,commit,push。
- **push完即刻查有冇開住嘅PR**(`list_pull_requests state=open`)。
  呢個repo嘅branch係長期重用嘅——上一個PR merge咗之後,個branch仲喺度,
  再push上去就會變成「commit喺度但冇PR可以merge」。
  PR #6/#7/#8/#9/#13 全部中過呢個伏,用戶問過兩次「點解merged唔到」。
  **冇open PR就開一個新嘅,唔好當push完就完事。**
- Push前 `git merge origin/main`——啲data檔(`forecast_log*.csv`、`bias.json`、
  `calibration_log.csv`)每日俾bot更新緊,唔merge就會攞住舊數據做分析,
  跑健康檢查會出一堆假警報。

## 呢個repo最大嘅危險:靜靜哋壞

**乜都唔會throw。** 個log照寫、個panel照render、Actions照綠色,
但入面個數係錯嘅或者空嘅。已知中過嘅:

| 壞咗嘅嘢 | 點解冇人知 | 幾耐先發現 |
|---|---|---|
| calibration_log 4欄變5欄,dashboard仲讀第4欄 | 個表顯示「累積緊(0/20)」,似正常 | 靠用戶睇screenshot |
| 香港`sigmaScale`冇寫入bias.json | 讀唔到就當1,個階梯照出數 | 一路都係咁 |
| 市價欄記咗10日,一格都冇入到數 | forecast班07:15跑,但market下晝先開盤 | 92行0市價先發現 |
| `sampleDays`每次settle虛報+1 | `!== ""`對`undefined`係true | 「1日數據」但一個預測都冇 |
| METAR「最後一份report」攞咗18個鐘前嗰份 | 有個數顯示,睇落正常 | 靠screenshot個時間 |

**所以:每次修好一樣嘢,順手喺 `nightly_check.js` 加一項驗返個結果。**
唔係驗個檔存唔存在,係**照consumer嘅規矩讀一次,睇讀唔讀到嘢**。
呢個repo已經有幾次係「加咗個check先至知一路都壞緊」。

### 一句分唔清死因嘅log,本身就係bug

市價班寫住「市場未開盤/攞唔到價」,一句冚晒三個完全唔同嘅死因:
API唔通、slug格式變咗、bucket label變咗。結果查咗成日先知係slug miss。
**Error message要print到證據**——status code、試過嘅slug、攞返嚟幾多個event、
見到嘅label係乜。分唔到「未開」同「格式變咗」就等於冇log。

## 落結論之前一定要用真數據跑

唔好靠睇code推論。呢個project每一個真發現都係跑數跑返嚟嘅,
而且我自己「諗啱咗」嘅嘢俾真數據推翻過唔止一次:

- 軌跡指標本來計 `finalMax − 當前溫度`,夜晚讀數會當成upside → 跑真數據先見到。
- 新加嘅健康檢查一出就false-positive倫敦/巴黎(時區「昨日」),
  同埋由舊掃到新令舊嘅好row冚住新嘅壞row → 兩個bug都係跑真數據先見到。
- σ問題本來以為「乘個倍數」就搞掂 → 量咗corr先知香港乘倍數係放大噪音。

`forecast_log*.csv`、`calibration_log.csv`、`bias.json` 全部喺repo度,
一個 `node -e` 就跑到。**冇跑過就唔好講「已修」。**

## 改一個writer = 搵晒所有reader

CSV schema、bias.json欄位、function return shape——改之前 `grep` 晒
所有讀嗰樣嘢嘅地方(`index.html`、`paper_trade.js`、`scan_cities.js`、
`nightly_check.js`、各個probe script)。
`calibration_log` 加一欄就係因為冇做呢步,靜咗個feedback loop十日。

## 唔好整假信心

個系統嘅價值係「話你知你知幾多」,唔係「話你知你好勁」。

- 唔好顯示 100% / 0%(除非係已發生嘅事實)。四捨五入出嚟嘅「模100% vs 市99¢ = +1% edge」
  會引人去追一個唔存在嘅edge。
- 唔好用「大概率」呢類字眼扮有把握——計個數出嚟。
- 樣本唔夠就照直講「唔夠」,唔好出個似模似樣嘅表。
- 一個warning冇預測力就唔好出(香港嘅「⚠分歧較大」corr=−0.15,出咗只會蠶食信任)。

## 加校正之前,先確認個校正嘅形狀啱唔啱

量到「唔準」唔等於知道「點修」。
香港 std(z)=3.4 係真嘅,但 `σ × 3.4` 係錯嘅修法,因為 corr(σ,|誤差|)=−0.15
——per-day嗰個訊號根本係噪音,乘大咗只會兩邊都錯。
**先量個relationship,再揀個correction。**

## 天文台總部溫度嘅速度上限(2026-09-09量完,唔使再查)

用戶問過「點解撳更新都唔係最新data」。查到底,答案係**冇得再快**,
記低喺度免得下次再花幾個鐘重做。

| 源 | 密度 | 個**讀數**幾舊 | 精度 |
|---|---|---|---|
| `rhrread` | 淨係正整點 | **~3.6分** ← 真係最快 | 整數 |
| `latest_1min_temperature.csv` | **10分鐘一格**(個名呃人) | 7.8–9.0分 | 0.1° |
| AWS-GIS `latestReadings_AWS1_v2.txt` | 10分鐘一格 | 7.7–8.7分 | 0.1° |
| 網站JSON `DYN_DAT_MINDS_RHRREAD` | 公報每個鐘 :02 + 加插 | **~12分(公報新,數據舊)** | 整數 |

### ⚠️2026-09-13訂正:網站JSON根本唔快,我09-08量錯咗

09-08我寫「網站JSON 1.2分,快CSV 7.4分」。**錯。**
我量嘅係「份公報幾時出現」,唔係「入面個讀數幾舊」。兩樣完全唔同。

2026-09-13 12:11實證,同一刻:
```
網站JSON (BulletinTime 12:02)  溫度=30  濕度=69
CSV / AWS-GIS / 天文台首頁      溫度=29.8 濕度=70   (12:00觀測)
```
**濕度分得開**:69同70兩個都係整數,唔存在捨入差異 → 網站JSON嗰組數
係**另一個時刻**(多數係11:50)嘅觀測,唔係12:00。

即係:所有總部源都喺同一個10分鐘grid上,冇一條真係搶先。
網站JSON個新timestamp係假象——公報係新,入面啲數係舊。

**唯一真嘅速度優勢係 rhrread**:正整點嗰個讀數約 :03–:04 就攞到,
比CSV嗰個同一時刻嘅0.1°早約5分鐘。代價係整數,而且一個鐘先一次。

⚠️同類錯誤已經犯過三次(捨入驗證嘅「有分辨力樣本」、grid放大成假差距、
呢次公報時間當觀測時間)。**以後見到「某源快」,先問:
快嘅係個timestamp,定係入面個讀數?搵一個唔會捨入嘅欄(例如濕度)去驗。**

### 2026-09-13:搵齊晒,冇更快嘅小數源(唔使再搵)

用戶追問「會唔會有精準到小數點而又快嘅源你未搵到」。掘到底:

**三條獨立小數源,70分鐘race各n=8,全部同1分鐘CSV打和(中位+0.0分)**
```
region.json  +0.0 +0.0 +0.0 +0.7 +0.0 -0.7 +1.1 +0.0   中位 +0.0
AWS-GIS      +0.0 +0.4 +0.0 +0.4 +0.0 -0.3 +1.1 -0.4   中位 +0.0
```
唔係巧合——佢哋食緊同一個10分鐘grid。**0.1°精度嘅硬地板已經確認。**

淘汰名單(唔使再試):`latest_5min/10min_temperature.csv`、`.json`變體、
資料夾listing、`_uc`變體、MyObservatory、`/wxinfo/aws/`(403)、
`maps.weather.gov.hk/ocf/dat/`(403)、`DYN_DAT_MINDS_TEMP.json`(404)。

**⭐但搵到 `https://www.hko.gov.hk/wxinfo/json/region.json`**
(由首頁 `old_index.js` 掘出嚟——首頁自己嗰3個JS之前一直係漏網,
`/wxinfo/json/` 呢個資料夾根本冇人知存在)。天文台首頁個小數就係佢餵。

價值**唔係速度**,係:
- `today.max`(結算嗰個數)嘅**第二條獨立源**,而且喺唔同host
  (`www.hko.gov.hk` vs `data.weather.gov.hk`)——兩邊唔夾即刻知
- 溫度同max/min都有小數、`btime`係完整YYYYMMDDHHMM(冇歧義)
- 一個3.6KB檔有齊全港站

`latestReadings_AWS1_v2.txt` = 「分區天氣資訊平台」自己食嗰條線
(爬 `irwip-map-config.js` 掘出嚟)。**實測同CSV打和** —— 換過去冇著數。

⚠️用戶見過「天文台站頁11:40 vs 我哋11:30」,睇落差成10分鐘。
**唔係。**因為數據10分鐘一格,兩邊到貨爭20秒都會睇落爭成格。
11:48撳=18分鐘前,11:49撳=9分鐘前,條線冇變過。
**以後見到呢類「差成一格」嘅報告,先問係咪踩正到貨界線,唔好即刻當有快源。**

到貨滯後 n=23,穩定喺 7.7–9.1 分,冇一次例外 → 個countdown用 8.6 分算係啱嘅。

實務結論:0.1°精度嘅數,任何人都要等 stamp+8.4分。想快就只有整數,
而整數最快嗰條係 **rhrread**(正整點 :03–:04 攞到)——**唔係網站JSON**
(見上面09-13訂正)。呢個先係edge窗口嘅真正形狀。

## 其他實際教訓

- **Cron唔可以靠「而家幾點」判斷mode。** GitHub Actions實測延遲63–145分鐘,
  23:15排程試過00:07先行。一律用 `github.event.schedule`。
- **結算源 ≠ 最快嘅源。** 香港結算跟HKO總部,但最快嘅公開數據係赤鱲角VHHH METAR
  (快6–16分鐘,但差1–2°C)。邊個source用嚟做乜要分得好清楚。
- **Cloudflare Workers `fetch()` 預設食edge cache**,攞即時數據一定要 `cache:"no-store"`。
- **呢個sandbox個proxy封咗 polymarket.com(403)。** 驗唔到就話驗唔到,
  唔好靠估講「應該冇問題」。

## 用戶點用呢個系統

用戶主要喺**iPhone Safari**睇,經常直接影screenshot問「係咪仲有問題」。
即係話:**顯示出嚟嘅嘢就係產品**。一個數顯示錯、一句話寫得誤導,
同計錯數一樣咁嚴重。睇screenshot嗰陣要逐個panel對返個code同真數據,
唔好淨係答佢問嗰樣。
