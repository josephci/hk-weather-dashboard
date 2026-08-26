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
