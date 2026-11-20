(function () {
  if (window.NexusIndicators) return;

  function getTfSeconds(tf) {
    const m = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
    return m[tf] || 300;
  }

  // =========================================================================
  // THUẬT TOÁN 1: ENGULF SIGNAL V14 MTF FILTER (CHUYỂN THỂ TỪ PINE SCRIPT V6)
  // =========================================================================
  const defaultV14Config = {
    minBarsIn: 4,
    tol: 0.2,
    containMode: "Thân nến", // "Thân nến" | "Râu nến"
    minMult: 0.0,
    showBox: true,
    showSLTP: true,
    labelStyle: "Chữ B/S nhỏ", // "Chữ B/S nhỏ" | "Tam giác nhỏ" | "Chấm tròn"
    use1: true, tf1: "M15",
    use2: true, tf2: "M30",
    use3: true, tf3: "H1",
    use4: true, tf4: "H4",
    use5: true, tf5: "D1",
    htfConfirmed: true,
    filterMode: "FLT_STRONG", // FLT_OFF | FLT_NOCTR | FLT_STRONG | FLT_DONE | FLT_TWO
    minNbF: 0,
    showFilt: false,
    rrAsia: 1.0,
    rrEu: 1.0,
    rrUs: 2.0,
    tradeAsia: true,
    tradeEU: true,
    tradeUS: true,
    statPer: "Toàn bộ dữ liệu", // "Tuần này" | "Tháng này" | "Toàn bộ dữ liệu"
    statLot: 0.0,
    statPV: 100.0,
    showStat: true,
    showTbl: true
  };

  function computeHTFStates(bars, cfg) {
    const states = new Array(bars.length).fill(0);
    let d = 0, bi = -1, hi = 0, lo = 0, bHi = 0, bLo = 0, sg = 0;

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const bd = Math.abs(b.close - b.open);
      let avgBdPrev = null;
      if (i >= 20) {
        let sum = 0;
        for (let j = i - 20; j < i; j++) sum += Math.abs(bars[j].close - bars[j].open);
        avgBdPrev = sum / 20;
      }

      const bu = b.close > b.open;
      const be = b.close < b.open;
      const prev = i > 0 ? bars[i - 1] : b;
      const buE = i > 0 && bu && prev.close <= prev.open && b.close > prev.open && b.open <= prev.close + cfg.tol * bd;
      const beE = i > 0 && be && prev.close >= prev.open && b.close < prev.open && b.open >= prev.close - cfg.tol * bd;

      const hiR = cfg.containMode === "Thân nến" ? Math.max(b.open, b.close) : b.high;
      const loR = cfg.containMode === "Thân nến" ? Math.min(b.open, b.close) : b.low;

      if (d !== 0 && i > bi) {
        const out = hiR > hi || loR < lo;
        const can = d === 1 ? (be && b.close < bLo) : (bu && b.close > bHi);
        if (out || can) {
          d = 0;
          sg = 0;
        } else if (i - bi >= cfg.minBarsIn) {
          if (d === 1 && buE) sg = 1;
          if (d === -1 && beE) sg = 1;
        }
      }

      const bigE = cfg.minMult === 0.0 || (avgBdPrev !== null && bd >= cfg.minMult * avgBdPrev);
      if (d === 0 && (bu || be) && bigE) {
        d = bu ? 1 : -1;
        bi = i;
        hi = b.high;
        lo = b.low;
        bHi = Math.max(b.open, b.close);
        bLo = Math.min(b.open, b.close);
        sg = 0;
      }

      let res = 0;
      if (d !== 0 && i - bi >= cfg.minBarsIn) {
        res = sg === 1 ? 2 * d : d;
      }
      states[i] = res;
    }
    return states;
  }

  function getSessionInfoUTC7(unixSec, cfg) {
    const vnDate = new Date((unixSec + 7 * 3600) * 1000);
    const hhmm = vnDate.getUTCHours() * 100 + vnDate.getUTCMinutes();
    const inUS = hhmm >= 2000 || hhmm < 400;
    const inEU = !inUS && hhmm >= 1400 && hhmm < 2000;
    if (inUS) return { sess: "US", rr: cfg.rrUs, ok: cfg.tradeUS };
    if (inEU) return { sess: "EU", rr: cfg.rrEu, ok: cfg.tradeEU };
    return { sess: "Asia", rr: cfg.rrAsia, ok: cfg.tradeAsia };
  }

  function evaluateEngulfV14(visibleBars, activeTf, mtfData, cfg) {
    const n = visibleBars.length;
    if (n < 25) return null;

    const curSec = getTfSeconds(activeTf);
    const htfConfigs = [
      { use: cfg.use1, tf: cfg.tf1 },
      { use: cfg.use2, tf: cfg.tf2 },
      { use: cfg.use3, tf: cfg.tf3 },
      { use: cfg.use4, tf: cfg.tf4 },
      { use: cfg.use5, tf: cfg.tf5 }
    ];

    const precomputedHTF = htfConfigs.map(item => {
      const tfSec = getTfSeconds(item.tf);
      const ok = item.use && tfSec > curSec;
      const bars = (ok && mtfData && mtfData[item.tf]) ? mtfData[item.tf] : [];
      const states = bars.length > 0 ? computeHTFStates(bars, cfg) : [];
      return { use: item.use, ok, tf: item.tf, tfSec, bars, states };
    });

    function lookupHTFAtTime(htfObj, curBarTime) {
      if (!htfObj.ok || htfObj.bars.length === 0) return 0;
      let idx = -1;
      for (let j = htfObj.bars.length - 1; j >= 0; j--) {
        const barOpen = htfObj.bars[j].time;
        const barClose = barOpen + htfObj.tfSec;
        if (cfg.htfConfirmed) {
          if (barClose <= curBarTime + curSec) { idx = j; break; }
        } else {
          if (barOpen <= curBarTime) { idx = j; break; }
        }
      }
      return idx >= 0 ? htfObj.states[idx] : 0;
    }

    let dir = 0, baseIdx = -1, bHigh = 0, bLow = 0, bBodyHi = 0, bBodyLo = 0, trkHigh = 0, trkLow = 0, baseCol = "#10b981";
    const markers = [];
    const boxSegments = [];
    let currentBox = null;
    let lastSignalLevels = null;

    const openOrders = [];
    let stats = { total: 0, wins: 0, losses: 0, rWin: 0, pWin: 0, pLoss: 0, sumRR: 0 };

    const nowSec = visibleBars[n - 1].time;
    const startOfWeek = nowSec - 7 * 86400;
    const startOfMonth = nowSec - 30 * 86400;

    function inStatWindow(entryTime) {
      if (cfg.statPer === "Tuần này") return entryTime >= startOfWeek;
      if (cfg.statPer === "Tháng này") return entryTime >= startOfMonth;
      return true;
    }

    let latestHtfVals = [0, 0, 0, 0, 0];

    for (let i = 0; i < n; i++) {
      const b = visibleBars[i];
      const body = Math.abs(b.close - b.open);
      let avgBodyPrev = null;
      if (i >= 20) {
        let s = 0;
        for (let j = i - 20; j < i; j++) s += Math.abs(visibleBars[j].close - visibleBars[j].open);
        avgBodyPrev = s / 20;
      }
      const isBull = b.close > b.open;
      const isBear = b.close < b.open;
      const prev = i > 0 ? visibleBars[i - 1] : b;

      const bullEng = i > 0 && isBull && prev.close <= prev.open && b.close > prev.open && b.open <= prev.close + cfg.tol * body;
      const bearEng = i > 0 && isBear && prev.close >= prev.open && b.close < prev.open && b.open >= prev.close - cfg.tol * body;

      for (let k = openOrders.length - 1; k >= 0; k--) {
        const ord = openOrders[k];
        const hitSL = ord.dir === 1 ? b.low <= ord.sl : b.high >= ord.sl;
        const hitTP = ord.dir === 1 ? b.high >= ord.tp : b.low <= ord.tp;
        if (hitSL || hitTP) {
          const win = !hitSL;
          const dist = win ? Math.abs(ord.tp - ord.en) : Math.abs(ord.en - ord.sl);
          if (ord.counted) {
            if (win) {
              stats.wins += 1;
              stats.rWin += ord.rr;
              stats.pWin += dist;
            } else {
              stats.losses += 1;
              stats.pLoss += dist;
            }
          }
          openOrders.splice(k, 1);
        }
      }

      const hiRef = cfg.containMode === "Thân nến" ? Math.max(b.open, b.close) : b.high;
      const loRef = cfg.containMode === "Thân nến" ? Math.min(b.open, b.close) : b.low;

      const active = dir !== 0 && i > baseIdx;
      const outside = active && (hiRef > bHigh || loRef < bLow);
      const cancel = active && (dir === 1 ? (isBear && b.close < bBodyLo) : (isBull && b.close > bBodyHi));
      const valid = active && !outside && !cancel;
      const enough = valid && (i - baseIdx) >= cfg.minBarsIn;

      const { sess, rr, ok: sessOk } = getSessionInfoUTC7(b.time, cfg);
      const buySig = enough && dir === 1 && bullEng && sessOk;
      const sellSig = enough && dir === -1 && bearEng && sessOk;

      const hVals = precomputedHTF.map(obj => lookupHTFAtTime(obj, b.time));
      if (i === n - 1) latestHtfVals = hVals;

      if (buySig || sellSig) {
        const dVals = hVals.map(v => v > 0 ? 1 : (v < 0 ? -1 : 0));
        const counter = dVals.some(dv => (buySig && dv === -1) || (sellSig && dv === 1));
        const sigDir = buySig ? 1 : -1;
        const sameCnt = dVals.filter(dv => dv === sigDir).length;
        const doneCnt = hVals.filter(hv => hv === 2 * sigDir).length;

        let trendOk = true;
        if (cfg.filterMode === "FLT_NOCTR") trendOk = !counter;
        else if (cfg.filterMode === "FLT_STRONG") trendOk = !counter && (doneCnt >= 1 || sameCnt >= 2);
        else if (cfg.filterMode === "FLT_DONE") trendOk = !counter && doneCnt >= 1;
        else if (cfg.filterMode === "FLT_TWO") trendOk = !counter && sameCnt >= 2;

        const nbOk = cfg.minNbF === 0 || (i - baseIdx) >= cfg.minNbF;
        const passF = trendOk && nbOk;

        const slP = buySig ? Math.min(trkLow, b.low) : Math.max(trkHigh, b.high);
        const risk = Math.abs(b.close - slP);
        const tpP = buySig ? b.close + rr * risk : b.close - rr * risk;

        if (risk > 0 && passF) {
          const sigColor = counter ? "#a855f7" : (buySig ? "#10b981" : "#ef4444");
          const shape = cfg.labelStyle === "Tam giác nhỏ"
            ? (buySig ? "arrowUp" : "arrowDown")
            : (cfg.labelStyle === "Chấm tròn" ? "circle" : (buySig ? "arrowUp" : "arrowDown"));
          const text = cfg.labelStyle === "Chữ B/S nhỏ" ? (buySig ? "B" : "S") : "";

          markers.push({
            time: b.time,
            position: buySig ? "belowBar" : "aboveBar",
            color: sigColor,
            shape: shape,
            text: text
          });

          const counted = inStatWindow(b.time);
          openOrders.push({ dir: sigDir, en: b.close, sl: slP, tp: tpP, rr, counted });
          if (counted) {
            stats.total += 1;
            stats.sumRR += rr;
          }

          lastSignalLevels = {
            side: buySig ? "BUY" : "SELL",
            entry: b.close,
            sl: slP,
            tp: tpP,
            rr: rr,
            sess: sess,
            time: b.time,
            counter: counter
          };
        } else if (risk > 0 && !passF && cfg.showFilt) {
          markers.push({
            time: b.time,
            position: buySig ? "belowBar" : "aboveBar",
            color: "#64748b",
            shape: "circle",
            text: ""
          });
        }
      }

      if (active) {
        if (outside || cancel) {
          dir = 0;
          currentBox = null;
        } else {
          trkHigh = Math.max(trkHigh, b.high);
          trkLow = Math.min(trkLow, b.low);
          if (cfg.showBox) {
            if (i - baseIdx === cfg.minBarsIn) {
              currentBox = { t1: visibleBars[baseIdx].time, t2: b.time, hi: bHigh, lo: bLow, col: baseCol };
              boxSegments.push(currentBox);
            } else if (i - baseIdx > cfg.minBarsIn && currentBox) {
              currentBox.t2 = b.time;
            }
          }
        }
      }

      const bigEnough = cfg.minMult === 0.0 || (avgBodyPrev !== null && body >= cfg.minMult * avgBodyPrev);
      if (dir === 0 && (isBull || isBear) && bigEnough) {
        dir = isBull ? 1 : -1;
        baseIdx = i;
        bHigh = b.high;
        bLow = b.low;
        bBodyHi = Math.max(b.open, b.close);
        bBodyLo = Math.min(b.open, b.close);
        trkHigh = b.high;
        trkLow = b.low;
        baseCol = isBull ? "#10b981" : "#ef4444";
      }
    }

    return {
      markers,
      boxSegments: boxSegments.slice(-12),
      lastSignalLevels,
      stats,
      openCount: openOrders.length,
      htfSummary: htfConfigs.map((c, idx) => ({
        use: c.use,
        ok: precomputedHTF[idx].ok,
        tf: c.tf,
        val: latestHtfVals[idx]
      }))
    };
  }

  // =========================================================================
  // THUẬT TOÁN 2: SUPERTREND ĐỘC LẬP (ATR 10, MULT 3.0)
  // =========================================================================
  function evaluateSupertrend(visibleBars, periods = 10, mult = 3.0) {
    const n = visibleBars.length;
    if (n < 5) return { up: [], down: [] };
    const tr = new Array(n).fill(0);
    const atr = new Array(n).fill(0);
    const upArr = [], dnArr = [];
    let upPrev = 0, dnPrev = 0, trend = 1;

    for (let i = 0; i < n; i++) {
      const b = visibleBars[i];
      const prevC = i > 0 ? visibleBars[i - 1].close : b.close;
      tr[i] = Math.max(b.high - b.low, Math.abs(b.high - prevC), Math.abs(b.low - prevC));
      if (i < periods) {
        atr[i] = tr.slice(0, i + 1).reduce((a, x) => a + x, 0) / (i + 1);
      } else {
        atr[i] = (atr[i - 1] * (periods - 1) + tr[i]) / periods;
      }
      const hl2 = (b.high + b.low) / 2;
      let up = hl2 - mult * atr[i];
      let dn = hl2 + mult * atr[i];
      if (i > 0) {
        up = visibleBars[i - 1].close > upPrev ? Math.max(up, upPrev) : up;
        dn = visibleBars[i - 1].close < dnPrev ? Math.min(dn, dnPrev) : dn;
        if (trend === -1 && b.close > dnPrev) trend = 1;
        else if (trend === 1 && b.close < upPrev) trend = -1;
      }
      upPrev = up;
      dnPrev = dn;
      upArr.push(trend === 1 ? { time: b.time, value: up } : { time: b.time });
      dnArr.push(trend === -1 ? { time: b.time, value: dn } : { time: b.time });
    }
    return { up: upArr, down: dnArr };
  }

  // =========================================================================
  // MẪU CODE MẶC ĐỊNH KHI NGƯỜI DÙNG TỰ TẠO INDICATOR MỚI
  // =========================================================================
  const defaultCustomTemplate = `// Tự tạo Indicator của bạn từ mảng candles [{time, open, high, low, close, volume}]
// Trả về:
//   lines: [{ color: "#38bdf8", width: 2, data: [{time, value}] }]
//   markers: [{ time, position: "belowBar"|"aboveBar", color: "#10b981", shape: "arrowUp"|"arrowDown"|"circle", text: "BUY" }]
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr[0].close;
  return arr.map((c, idx) => {
    ema = idx === 0 ? c.close : c.close * k + ema * (1 - k);
    return { time: c.time, value: ema };
  });
}
const ema20 = calcEMA(candles, 20);
const ema50 = calcEMA(candles, 50);
return {
  lines: [
    { color: "#38bdf8", width: 2, data: ema20 },
    { color: "#f59e0b", width: 2, data: ema50 }
  ],
  markers: []
};`;

  window.NexusIndicators = {
    defaultV14Config,
    defaultCustomTemplate,
    getTfSeconds,
    evaluateEngulfV14,
    evaluateSupertrend
  };
})();
