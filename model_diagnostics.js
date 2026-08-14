/**
 * model_diagnostics.js
 * ------------------------------------------------------------
 * 用你已經儲落嘅 forecast_log,答三條從來未問過但直接影響落注嘅問題。
 *
 * ① σ準唔準?(最重要)
 *    你落注嘅bucket機率係用「6模型平均 ± 標準差」砌出嚟嘅常態分佈。
 *    但如果真實誤差比σ闊,即係每個%都過份自信——你會系統性
 *    高估熱門bucket、買貴咗。
 *    測法:z = (實測 − 平均) / σ。校準得好嘅話 std(z) 應該≈1。
 *    std(z)=1.5 即係話真實不確定性大50%,所有機率要重新計。
 *
 * ② 模型分歧大嗰陣,係咪真係錯得多?
 *    如果係 → 分歧大嗰日應該減注(而家個系統只係顯示「⚠分歧較大」,
 *    冇量化過影響)。
 *
 * ③ 6模型平均係咪最好?定係某一個模型單獨更準?
 *    平均係預設做法,但唔一定最優。
 *
 * ⚠️ bias用leave-one-out計(每日嘅bias由其他日子算),
 *    唔係in-sample,否則會高估自己準確度。
 *
 * 用法: node model_diagnostics.js [--city=hk|shanghai|...]
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const MODELS = ["gfs_seamless","ecmwf_ifs025","icon_seamless","ukmo_seamless","gem_seamless","jma_seamless"];
const SHORT = { gfs_seamless:"GFS", ecmwf_ifs025:"ECMWF", icon_seamless:"ICON", ukmo_seamless:"UKMO", gem_seamless:"GEM", jma_seamless:"JMA" };
const FILES = {
  hk: "forecast_log.csv", shanghai: "forecast_log_shanghai.csv", beijing: "forecast_log_beijing.csv",
  london: "forecast_log_london.csv", paris: "forecast_log_paris.csv", shenzhen: "forecast_log_shenzhen.csv",
};

function load(city) {
  const p = path.join(__dirname, FILES[city]);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").trim().split(/\r?\n/).slice(1)
    .map((l) => {
      const c = l.split(",");
      const f = {};
      MODELS.forEach((m, i) => { const v = parseFloat(c[i + 1]); if (!Number.isNaN(v)) f[m] = v; });
      const realized = parseFloat(c[7]);
      return { date: c[0], f, realized };
    })
    .filter((r) => !Number.isNaN(r.realized) && Object.keys(r.f).length >= 2);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

// leave-one-out bias:今日嘅校正只用其他日子算,唔偷睇自己
function looBias(rows, idx, model) {
  const diffs = [];
  rows.forEach((r, i) => {
    if (i === idx || r.f[model] === undefined) return;
    diffs.push(r.realized - r.f[model]);
  });
  return diffs.length >= 5 ? mean(diffs) : 0;
}

function analyse(city) {
  const rows = load(city);
  if (rows.length < 10) { console.log(`\n${city}: 得${rows.length}日數據,唔夠分析(要>=10)`); return; }

  const pts = rows.map((r, i) => {
    const vals = [], raw = [];
    for (const m of MODELS) {
      if (r.f[m] === undefined) continue;
      raw.push(r.f[m]);
      vals.push(r.f[m] + looBias(rows, i, m)); // 校正後
    }
    const em = mean(vals), es = std(vals);
    return {
      date: r.date, realized: r.realized, ensembleMean: em, ensembleStd: es,
      spread: Math.max(...raw) - Math.min(...raw),
      err: r.realized - em,
      z: es > 0 ? (r.realized - em) / es : 0,
      perModel: Object.fromEntries(MODELS.filter((m) => r.f[m] !== undefined)
        .map((m) => [m, r.realized - (r.f[m] + looBias(rows, i, m))])),
    };
  });

  console.log(`\n${"═".repeat(58)}\n📊 ${city.toUpperCase()} — ${pts.length}日完整數據 (leave-one-out校正)\n${"═".repeat(58)}`);

  // ---------- ① σ校準 ----------
  const zs = pts.map((p) => p.z).filter((z) => Number.isFinite(z));
  const zStd = std(zs), zMean = mean(zs);
  const within1 = zs.filter((z) => Math.abs(z) <= 1).length / zs.length;
  const within2 = zs.filter((z) => Math.abs(z) <= 2).length / zs.length;
  const errStd = std(pts.map((p) => p.err));
  const avgSigma = mean(pts.map((p) => p.ensembleStd));

  console.log("\n① σ準唔準?（最影響落注）");
  console.log(`   模型平均σ        ${avgSigma.toFixed(2)}°`);
  console.log(`   實際誤差標準差    ${errStd.toFixed(2)}°`);
  console.log(`   std(z)           ${zStd.toFixed(2)}   ← 1.0=啱啱好`);
  console.log(`   mean(z)          ${zMean >= 0 ? "+" : ""}${zMean.toFixed(2)}   ← 0=冇殘餘偏差`);
  console.log(`   落喺±1σ內        ${(within1*100).toFixed(0)}%  (理論68%)`);
  console.log(`   落喺±2σ內        ${(within2*100).toFixed(0)}%  (理論95%)`);

  const inflate = zStd;
  if (zStd > 1.25) {
    console.log(`\n   ⚠️ σ太窄:真實不確定性係模型講嘅 ${zStd.toFixed(2)} 倍。`);
    console.log(`      即係話你而家所有bucket機率都過份自信——熱門格畀高咗%,`);
    console.log(`      買貴咗;冷門格畀低咗%,錯過機會。`);
    console.log(`      建議:計機率之前將σ乘 ${inflate.toFixed(2)}。`);
  } else if (zStd < 0.8) {
    console.log(`\n   ℹ️ σ太闊(${zStd.toFixed(2)}):模型比自己以為嘅準,機率過份保守。`);
    console.log(`      建議:σ乘 ${inflate.toFixed(2)}(即係收窄)。`);
  } else {
    console.log(`\n   ✓ σ校準合理(${zStd.toFixed(2)}),機率可以照用。`);
  }
  if (Math.abs(zMean) > 0.3) {
    console.log(`   ⚠️ mean(z)=${zMean.toFixed(2)} 偏離0:bias校正之後仲有殘餘偏差,`);
    console.log(`      即係話個偏差可能唔係固定值(隨季節/天氣型態變)。`);
  }

  // ---------- ② 分歧預唔預測到錯誤 ----------
  console.log("\n② 模型分歧大,係咪真係錯得多?");
  const sorted = [...pts].sort((a, b) => a.spread - b.spread);
  const third = Math.floor(sorted.length / 3);
  const lowSp = sorted.slice(0, third), highSp = sorted.slice(-third);
  const maeLow = mean(lowSp.map((p) => Math.abs(p.err)));
  const maeHigh = mean(highSp.map((p) => Math.abs(p.err)));
  console.log(`   分歧最細1/3 (平均${mean(lowSp.map(p=>p.spread)).toFixed(1)}°): 平均誤差 ${maeLow.toFixed(2)}°`);
  console.log(`   分歧最大1/3 (平均${mean(highSp.map(p=>p.spread)).toFixed(1)}°): 平均誤差 ${maeHigh.toFixed(2)}°`);
  const ratio = maeLow > 0 ? maeHigh / maeLow : 1;
  if (ratio >= 1.3) {
    console.log(`   → 分歧大嗰啲日子誤差大 ${ratio.toFixed(1)} 倍。分歧係有用嘅風險訊號,`);
    console.log(`      分歧大嘅日應該減注(或者要求更大edge先入場)。`);
  } else if (ratio <= 0.8) {
    console.log(`   → 反直覺:分歧大反而錯得少。唔好用分歧做減注理由。`);
  } else {
    console.log(`   → 差別唔大(${ratio.toFixed(1)}倍)。分歧唔係好嘅風險訊號,`);
    console.log(`      個dashboard嘅「⚠分歧較大」提示參考價值有限。`);
  }

  // ---------- ③ 邊個模型最準 ----------
  console.log("\n③ 6模型平均 vs 個別模型（校正後平均絕對誤差）");
  const maes = [];
  for (const m of MODELS) {
    const e = pts.map((p) => p.perModel[m]).filter((v) => v !== undefined && Number.isFinite(v));
    if (e.length >= 10) maes.push({ m, mae: mean(e.map(Math.abs)), n: e.length });
  }
  const ensembleMae = mean(pts.map((p) => Math.abs(p.err)));
  maes.sort((a, b) => a.mae - b.mae);
  for (const x of maes) {
    const flag = x.mae < ensembleMae ? "  ← 好過平均" : "";
    console.log(`   ${SHORT[x.m].padEnd(6)} ${x.mae.toFixed(2)}°  (n=${x.n})${flag}`);
  }
  console.log(`   ${"6模型平均".padEnd(5)} ${ensembleMae.toFixed(2)}°`);
  const best = maes[0];
  if (best && best.mae < ensembleMae - 0.05) {
    console.log(`\n   → ${SHORT[best.m]} 單獨用比平均好 ${(ensembleMae - best.mae).toFixed(2)}°。`);
    console.log(`      但要小心:${pts.length}日樣本可能係噪音,睇多一兩個月先好改權重。`);
  } else {
    console.log(`\n   ✓ 冇單一模型明顯贏過平均——用平均係啱嘅(平均通常最穩陣)。`);
  }

  return { city, n: pts.length, zStd, ensembleMae, spreadRatio: ratio };
}

function main() {
  const arg = process.argv.find((a) => a.startsWith("--city="));
  const cities = arg ? [arg.split("=")[1]] : Object.keys(FILES);
  const summary = [];
  for (const c of cities) {
    if (!FILES[c]) { console.log(`唔識呢個城市: ${c}`); continue; }
    const r = analyse(c);
    if (r) summary.push(r);
  }
  if (summary.length > 1) {
    console.log(`\n${"═".repeat(58)}\n📋 總結\n${"═".repeat(58)}`);
    console.log("城市        日數  std(z)  平均誤差  分歧預測力");
    for (const s of summary) {
      console.log(`${s.city.padEnd(11)} ${String(s.n).padStart(3)}   ${s.zStd.toFixed(2)}    ${s.ensembleMae.toFixed(2)}°     ${s.spreadRatio.toFixed(1)}x`);
    }
    console.log("\nstd(z)>1.25 = 個城市嘅機率過份自信,要放闊σ先好落注");
  }
}

main();
