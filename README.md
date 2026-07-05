# HK Weather Dashboard — Polymarket香港溫度市場輔助系統

即時溫度 + 6模型機率分佈 + bias自動校正 + Telegram警報。

## 檔案結構

```
├── index.html                          # 手機dashboard（Netlify自動部署）
├── netlify.toml                        # Netlify設定
├── netlify/functions/temperature.js    # 代理天文台CSV（解決CORS）
├── alert.js                            # Telegram警報（4種事件+Polymarket連結）
├── daily_log.js                        # 每日記錄預測vs實測 → 自動計bias
└── .github/workflows/
    ├── temp-alerts.yml                 # 每5分鐘：警報+history.csv記錄
    └── daily-bias.yml                  # 朝早07:15記錄預測 / 夜晚23:45結算+計bias
```

## 自動產生嘅數據檔（唔使自己整）

- `history.csv` — 每5分鐘嘅溫度記錄（現時/今日max/今日min）
- `forecast_log.csv` — 每日「6模型預測 vs 實測結果」對照表
- `bias.json` — 每個模型嘅系統性偏差（累積7日數據後開始出）
- `alert_state.json` — 警報系統內部state

## 首次設定

1. **Telegram warning（可選但強烈建議）**
   - @BotFather 開bot → 攞 `TG_BOT_TOKEN`
   - 同個bot講句嘢 → 開 `https://api.telegram.org/bot<TOKEN>/getUpdates` 攞 `TG_CHAT_ID`
   - Repo → Settings → Secrets and variables → Actions → 加呢兩個secrets

2. **手動觸發一次測試**
   - Actions tab → "Daily Bias Pipeline" → Run workflow → mode=forecast
   - Actions tab → "HK Temp Alerts" → Run workflow

## Bias校正點運作

- 每朝07:15記錄「今日6模型嘅預測」
- 每晚23:45記錄「今日實測最高溫」，計 `bias = 實測 − 預測` 嘅平均
- Dashboard自動由 `bias.json` 讀取，用「校正後」數值計機率
- **數據未夠7日之前**，dashboard顯示嘅係raw模型（會偏凍2-3°C，見過往記錄），呢段時間唔好直接信個%落單

## ⚠️ 交易警示

- 模型喺颱風/雷暴日可以錯5σ（2026-07-05實例：模型平均30.5° vs 實開33°）
- 「模型% vs 市場價」有大差距時，先假設係自己模型錯，唔係市場錯
- 呢個系統係決策輔助，唔係財務建議
