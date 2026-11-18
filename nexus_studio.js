(function () {
  if (window.__NEXUS_STUDIO_LOADED__) return;
  window.__NEXUS_STUDIO_LOADED__ = true;

  // =========================================================================
  // 1. STATE & DEFAULT CONFIG (KHỚP 100% VỚI ENGULF SIGNAL V14 MTF FILTER)
  // =========================================================================
  const defaultV14Config = {
    enabled: true,
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
    stShow: true,
    stPeriods: 10,
    stMult: 3.0,
    rrAsia: 1.0,
    rrEu: 1.0,
    rrUs: 2.0,
    tradeAsia: true,
    tradeEU: true,
    tradeUS: true,
    statPer: "Toàn bộ dữ liệu", // "Tuần này" | "Tháng này" | "Toàn bộ dữ liệu"
    statUnit: "R + Giá",
    statLot: 0.0,
    statPV: 100.0,
    showStat: true,
    showTbl: true
  };

  let v14Config = Object.assign({}, defaultV14Config);
  let customScripts = [
    {
      name: "EMA 20 / 50 Trend Filter",
      enabled: false,
      code: `// Hàm nhận mảng candles [{time, open, high, low, close, volume}]
// Trả về { lines: [{ color, data: [{time, value}] }], markers: [] }
function calcEMA(arr, p) {
  const k = 2 / (p + 1);
  let ema = arr[0].close;
  return arr.map((c, i) => {
    ema = i === 0 ? c.close : c.close * k + ema * (1 - k);
    return { time: c.time, value: ema };
  });
}
return {
  lines: [
    { color: "#38bdf8", width: 1, data: calcEMA(candles, 20) },
    { color: "#f59e0b", width: 1, data: calcEMA(candles, 50) }
  ],
  markers: []
};`
    }
  ];

  // Multi-TF & Replay State
  let mtfCache = { symbol: "XAUUSD", digits: 2, data: {} };
  let activeTf = "M5";
  let fullCandles = [];
  let replayState = {
    active: false,
    index: 0,
    playing: false,
    speedMs: 600,
    timer: null,
    pickingCut: false
  };

  // Chart & Drawing State
  let chartRef = null;
  let candleSeriesRef = null;
  let futureAnchorSeries = null;
  let stUpSeries = null;
  let stDownSeries = null;
  let extraLineSeries = [];
  let customLineSeries = [];

  let drawTool = "CURSOR"; // CURSOR | TRENDLINE | HLINE | LONG_BOX | SHORT_BOX
  let pendingPoint = null;
  let userDrawings = []; // { id, type, p1, p2, seriesList, priceLines }

  // =========================================================================
  // 2. HOOK LIGHTWEIGHT CHARTS ĐỂ BẮT CHART & MỞ KHÓA TRỤC THỜI GIAN TƯƠNG LAI
  // =========================================================================
  function attachToChart(chart) {
    if (!chart || chart.__nexusHooked) return;
    chart.__nexusHooked = true;
    chartRef = chart;

    // Mở khóa kéo tự do sang vùng trống tương lai bên phải
    try {
      chart.timeScale().applyOptions({
        rightOffset: 65,
        fixRightEdge: false,
        shiftVisibleRangeOnNewBar: false
      });
    } catch (e) {}

    // Tạo series neo thời gian tương lai vô hình (giúp vẽ tới tương lai mà không lỗi tick real-time)
    try {
      futureAnchorSeries = chart.addLineSeries({
        color: "rgba(0,0,0,0)",
        lineWidth: 1,
        visible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false
      });
      stUpSeries = chart.addLineSeries({
        color: "#10b981",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false
      });
      stDownSeries = chart.addLineSeries({
        color: "#ef4444",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false
      });
    } catch (e) {}

    // Lắng nghe click trên chart để cắt Replay hoặc vẽ Tool sang tương lai
    chart.subscribeClick((param) => {
      if (!param || !param.point) return;
      const series = findCandleSeries();
      if (!series) return;
      const price = series.coordinateToPrice(param.point.y);
      let clickTime = param.time;

      // Nếu click vào vùng tương lai sâu chưa có param.time, nội suy timestamp từ logical index
      if (!clickTime && param.logical !== undefined && fullCandles.length >= 2) {
        const tfSec = getTfSeconds(activeTf);
        const baseIdx = Math.min(fullCandles.length - 1, Math.max(0, Math.floor(param.logical)));
        const deltaBars = Math.round(param.logical) - baseIdx;
        clickTime = fullCandles[baseIdx].time + deltaBars * tfSec;
      }
      if (!clickTime || price === null || price === undefined) return;

      // Chế độ chọn điểm cắt Replay trên biểu đồ
      if (replayState.pickingCut) {
        replayState.pickingCut = false;
        const cutIdx = fullCandles.findIndex(c => c.time >= clickTime);
        if (cutIdx >= 30) {
          replayState.active = true;
          replayState.index = cutIdx;
          updateReplayUI();
          recomputeAndRenderAll();
        }
        return;
      }

      // Chế độ vẽ công cụ (hỗ trợ tọa độ tương lai 100%)
      if (drawTool !== "CURSOR") {
        handleChartDrawClick({ time: clickTime, price: Number(price) });
      }
    });
  }

  function hookLightweightChartsGlobal() {
    if (window.LightweightCharts && !window.LightweightCharts.__nexusPatched) {
      const origCreate = window.LightweightCharts.createChart;
      window.LightweightCharts.createChart = function (...args) {
        const c = origCreate.apply(this, args);
        attachToChart(c);
        return c;
      };
      window.LightweightCharts.__nexusPatched = true;
    }
  }
  hookLightweightChartsGlobal();

  function findChartAndSeries() {
    hookLightweightChartsGlobal();
    if (!chartRef) {
      for (const k of Object.keys(window)) {
        try {
          const v = window[k];
          if (v && typeof v === "object" && typeof v.timeScale === "function" && typeof v.addLineSeries === "function") {
            attachToChart(v);
            break;
          }
        } catch (e) {}
      }
    }
    if (!candleSeriesRef) {
      if (typeof candleSeries !== "undefined" && candleSeries && typeof candleSeries.createPriceLine === "function") {
        candleSeriesRef = candleSeries;
      } else {
        for (const k of Object.keys(window)) {
          try {
            const v = window[k];
            if (v && typeof v === "object" && typeof v.createPriceLine === "function" && typeof v.setMarkers === "function") {
              candleSeriesRef = v;
              break;
            }
          } catch (e) {}
        }
      }
    }
    return { chart: chartRef, series: candleSeriesRef };
  }

  function findCandleSeries() {
    return findChartAndSeries().series;
  }

  function getTfSeconds(tf) {
    const m = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
    return m[tf] || 300;
  }

  // Bơm 240 mốc thời gian tương lai vào futureAnchorSeries để mở khóa trục X
  function unlockFutureTimeAxis(candles) {
    const { chart } = findChartAndSeries();
    if (!chart || !futureAnchorSeries || !candles || candles.length === 0) return;
    const tfSec = getTfSeconds(activeTf);
    const lastT = candles[candles.length - 1].time;
    const futureWhitespace = [];
    for (let k = 1; k <= 240; k++) {
      futureWhitespace.push({ time: lastT + k * tfSec });
    }
    try {
      futureAnchorSeries.setData(futureWhitespace);
      chart.timeScale().applyOptions({ rightOffset: 65, fixRightEdge: false });
    } catch (e) {}
  }

  // =========================================================================
  // 3. BỘ CÔNG CỤ VẼ HỖ TRỢ KÉO SANG TƯƠNG LAI (TRENDLINE, HLINE, TP/SL BOX)
  // =========================================================================
  function handleChartDrawClick(pt) {
    const { chart, series } = findChartAndSeries();
    if (!chart || !series) return;
    const digits = mtfCache.digits || 2;

    if (drawTool === "HLINE") {
      const pl = series.createPriceLine({
        price: pt.price,
        color: "#ff9900",
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `LVL ${pt.price.toFixed(digits)}`
      });
      userDrawings.push({ id: Date.now(), type: "HLINE", priceLines: [pl], seriesList: [] });
      setDrawTool("CURSOR");
      return;
    }

    if (!pendingPoint) {
      pendingPoint = pt;
      updateToolbarStatus(`ĐÃ CHỌN ĐIỂM 1 (${pt.price.toFixed(digits)}) — CLICK ĐIỂM 2 (CÓ THỂ CHỌN Ở TƯƠNG LAI)...`);
      return;
    }

    const p1 = pendingPoint;
    const p2 = pt;
    pendingPoint = null;

    if (drawTool === "TRENDLINE") {
      const line = chart.addLineSeries({
        color: "#38bdf8",
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false
      });
      const pts = p1.time <= p2.time
        ? [{ time: p1.time, value: p1.price }, { time: p2.time, value: p2.price }]
        : [{ time: p2.time, value: p2.price }, { time: p1.time, value: p1.price }];
      if (pts[0].time === pts[1].time) pts[1].time += getTfSeconds(activeTf);
      line.setData(pts);
      userDrawings.push({ id: Date.now(), type: "TRENDLINE", priceLines: [], seriesList: [line] });
    } else if (drawTool === "LONG_BOX" || drawTool === "SHORT_BOX") {
      const isLong = drawTool === "LONG_BOX";
      const entry = p1.price;
      const sl = p2.price;
      const risk = Math.abs(entry - sl) || (entry * 0.001);
      const validSl = isLong ? Math.min(entry - risk * 0.2, sl) : Math.max(entry + risk * 0.2, sl);
      const actualRisk = Math.abs(entry - validSl);
      const tp = isLong ? (entry + actualRisk * 2.0) : (entry - actualRisk * 2.0);

      const tStart = Math.min(p1.time, p2.time);
      const tEnd = Math.max(p1.time, p2.time) + getTfSeconds(activeTf) * 12;

      const makeSeg = (val, col, style) => {
        const s = chart.addLineSeries({
          color: col,
          lineWidth: 2,
          lineStyle: style,
          lastValueVisible: true,
          priceLineVisible: false
        });
        s.setData([{ time: tStart, value: val }, { time: tEnd, value: val }]);
        return s;
      };

      const sEnt = makeSeg(entry, "#38bdf8", 0);
      const sTp = makeSeg(tp, "#10b981", 2);
      const sSl = makeSeg(validSl, "#ef4444", 2);
      userDrawings.push({ id: Date.now(), type: drawTool, priceLines: [], seriesList: [sEnt, sTp, sSl] });
    }

    setDrawTool("CURSOR");
  }

  window.setDrawTool = function (tool) {
    drawTool = tool;
    pendingPoint = null;
    document.querySelectorAll(".nx-tool-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    updateToolbarStatus(tool === "CURSOR" ? "READY (FUTURE AXIS UNLOCKED)" : `TOOL: ${tool} — CLICK TRÊN CHART (HỖ TRỢ VẼ TƯƠNG LAI)`);
  };

  window.clearAllUserDrawings = function () {
    const { chart, series } = findChartAndSeries();
    userDrawings.forEach(d => {
      if (series && d.priceLines) d.priceLines.forEach(pl => { try { series.removePriceLine(pl); } catch (e) {} });
      if (chart && d.seriesList) d.seriesList.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
    });
    userDrawings = [];
    pendingPoint = null;
    updateToolbarStatus("ĐÃ XÓA TOÀN BỘ NÉT VẼ");
  };

  // =========================================================================
  // 4. THUẬT TOÁN ENGULF SIGNAL V14 MTF FILTER + SUPERTREND (PORT TỪ PINE V6)
  // =========================================================================
  function computeHTFStates(bars, cfg) {
    // Trả về mảng state cho từng bar của khung lớn:
    // 0 = không có vùng | 1 = vùng BUY hình thành | 2 = vùng BUY đã có tín hiệu
    // -1 = vùng SELL hình thành | -2 = vùng SELL đã có tín hiệu
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
    // Chuyển sang giờ Việt Nam (UTC+7)
    const vnDate = new Date((unixSec + 7 * 3600) * 1000);
    const hhmm = vnDate.getUTCHours() * 100 + vnDate.getUTCMinutes();
    const inUS = hhmm >= 2000 || hhmm < 400;
    const inEU = !inUS && hhmm >= 1400 && hhmm < 2000;
    if (inUS) return { sess: "US", rr: cfg.rrUs, ok: cfg.tradeUS };
    if (inEU) return { sess: "EU", rr: cfg.rrEu, ok: cfg.tradeEU };
    return { sess: "Asia", rr: cfg.rrAsia, ok: cfg.tradeAsia };
  }

  function runEngulfV14Engine(visibleBars, cfg) {
    const n = visibleBars.length;
    if (n < 25) return null;

    // 1. Tính Supertrend (ATR 10, Mult 3.0)
    const tr = new Array(n).fill(0);
    const atr = new Array(n).fill(0);
    const stUp = [], stDn = [];
    let upPrev = 0, dnPrev = 0, trend = 1;

    for (let i = 0; i < n; i++) {
      const b = visibleBars[i];
      const prevC = i > 0 ? visibleBars[i - 1].close : b.close;
      tr[i] = Math.max(b.high - b.low, Math.abs(b.high - prevC), Math.abs(b.low - prevC));
      if (i < cfg.stPeriods) {
        atr[i] = tr.slice(0, i + 1).reduce((a, x) => a + x, 0) / (i + 1);
      } else {
        atr[i] = (atr[i - 1] * (cfg.stPeriods - 1) + tr[i]) / cfg.stPeriods;
      }
      const hl2 = (b.high + b.low) / 2;
      let up = hl2 - cfg.stMult * atr[i];
      let dn = hl2 + cfg.stMult * atr[i];
      if (i > 0) {
        up = visibleBars[i - 1].close > upPrev ? Math.max(up, upPrev) : up;
        dn = visibleBars[i - 1].close < dnPrev ? Math.min(dn, dnPrev) : dn;
        if (trend === -1 && b.close > dnPrev) trend = 1;
        else if (trend === 1 && b.close < upPrev) trend = -1;
      }
      upPrev = up;
      dnPrev = dn;

      if (cfg.stShow) {
        stUp.push(trend === 1 ? { time: b.time, value: up } : { time: b.time });
        stDn.push(trend === -1 ? { time: b.time, value: dn } : { time: b.time });
      }
    }

    // 2. Chuẩn bị trạng thái MTF (không rò rỉ tương lai khi tua Replay)
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
      const bars = (ok && mtfCache.data[item.tf]) ? mtfCache.data[item.tf] : [];
      const states = bars.length > 0 ? computeHTFStates(bars, cfg) : [];
      return { use: item.use, ok, tf: item.tf, tfSec, bars, states };
    });

    function lookupHTFAtTime(htfObj, curBarTime) {
      if (!htfObj.ok || htfObj.bars.length === 0) return 0;
      // Tìm nến HTF tại hoặc ngay trước thời điểm hiện tại (chống lookahead)
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

    // 3. Chạy vòng lặp mô phỏng từng cây nến giống hệt Pine Script v6
    let dir = 0, baseIdx = -1, bHigh = 0, bLow = 0, bBodyHi = 0, bBodyLo = 0, trkHigh = 0, trkLow = 0, baseCol = "#10b981";
    const markers = [];
    const boxSegments = [];
    let currentBox = null;
    let lastSignalLevels = null;

    // Quản lý lệnh & Thống kê kết quả
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

      // Kiểm tra các lệnh đang chạy chạm SL hay TP (chạm cả 2 trong 1 nến tính THUA thận trọng)
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

      if ((buySig || sellSig)) {
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

      // Cập nhật setup khi nến đóng
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
      stUp,
      stDn,
      markers,
      boxSegments: boxSegments.slice(-12), // Giữ 12 vùng gần nhất để chart nhẹ mượt
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
  // 5. RENDER INDICATOR LÊN CHART + BẢNG MINIMAP & THỐNG KÊ V14
  // =========================================================================
  let v14PriceLines = [];

  function clearExtraSeries() {
    const { chart, series } = findChartAndSeries();
    if (chart) {
      extraLineSeries.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
      customLineSeries.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
    }
    extraLineSeries = [];
    customLineSeries = [];
    if (series) {
      v14PriceLines.forEach(pl => { try { series.removePriceLine(pl); } catch (e) {} });
    }
    v14PriceLines = [];
  }

  function recomputeAndRenderAll() {
    const { chart, series } = findChartAndSeries();
    if (!chart || !series || fullCandles.length === 0) return;

    const visibleBars = replayState.active
      ? fullCandles.slice(0, Math.max(30, Math.min(fullCandles.length, replayState.index + 1)))
      : fullCandles;

    // Cập nhật nến lên chart khi đang trong chế độ Replay
    if (replayState.active) {
      try { series.setData(visibleBars); } catch (e) {}
    }

    // Luôn mở khóa 240 nến tương lai bên phải
    unlockFutureTimeAxis(visibleBars);
    clearExtraSeries();

    if (!v14Config.enabled) {
      try {
        series.setMarkers([]);
        if (stUpSeries) stUpSeries.setData([]);
        if (stDownSeries) stDownSeries.setData([]);
      } catch (e) {}
      return;
    }

    const res = runEngulfV14Engine(visibleBars, v14Config);
    if (!res) return;

    try {
      if (stUpSeries) stUpSeries.setData(v14Config.stShow ? res.stUp : []);
      if (stDownSeries) stDownSeries.setData(v14Config.stShow ? res.stDn : []);
      series.setMarkers(res.markers);
    } catch (e) {}

    // Vẽ vùng cây gốc (2 đường trên/dưới)
    if (v14Config.showBox) {
      res.boxSegments.forEach(bx => {
        if (bx.t1 >= bx.t2) return;
        [bx.hi, bx.lo].forEach(lvl => {
          const ls = chart.addLineSeries({
            color: bx.col,
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false
          });
          ls.setData([{ time: bx.t1, value: lvl }, { time: bx.t2, value: lvl }]);
          extraLineSeries.push(ls);
        });
      });
    }

    // Vẽ đường SL / TP của tín hiệu mới nhất kéo dài +10 nến sang TƯƠNG LAI
    if (v14Config.showSLTP && res.lastSignalLevels) {
      const sig = res.lastSignalLevels;
      const digits = mtfCache.digits || 2;
      const tfSec = getTfSeconds(activeTf);
      const tFutureEnd = sig.time + 10 * tfSec;

      const slLine = chart.addLineSeries({
        color: "#ef4444",
        lineWidth: 2,
        lineStyle: 2,
        lastValueVisible: false,
        priceLineVisible: false
      });
      slLine.setData([{ time: sig.time, value: sig.sl }, { time: tFutureEnd, value: sig.sl }]);
      extraLineSeries.push(slLine);

      const tpLine = chart.addLineSeries({
        color: "#10b981",
        lineWidth: 2,
        lineStyle: 2,
        lastValueVisible: false,
        priceLineVisible: false
      });
      tpLine.setData([{ time: sig.time, value: sig.tp }, { time: tFutureEnd, value: sig.tp }]);
      extraLineSeries.push(tpLine);

      v14PriceLines.push(series.createPriceLine({
        price: sig.tp,
        color: "#10b981",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `V14 TP (${sig.rr}R)`
      }));
      v14PriceLines.push(series.createPriceLine({
        price: sig.sl,
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `V14 SL`
      }));
    }

    // Chạy các Custom Indicator Script do người dùng tự viết
    customScripts.forEach(sc => {
      if (!sc.enabled) return;
      try {
        const fn = new Function("candles", sc.code);
        const out = fn(visibleBars);
        if (out && Array.isArray(out.lines)) {
          out.lines.forEach(l => {
            const s = chart.addLineSeries({
              color: l.color || "#38bdf8",
              lineWidth: l.width || 1,
              lastValueVisible: false,
              priceLineVisible: false
            });
            s.setData(l.data || []);
            customLineSeries.push(s);
          });
        }
      } catch (err) {}
    });

    renderStatsAndMtfTable(res);
  }

  function renderStatsAndMtfTable(res) {
    const tbl = document.getElementById("nx-v14-table-body");
    if (!tbl) return;
    const s = res.stats;
    const closed = s.wins + s.losses;
    const wr = closed > 0 ? ((100 * s.wins) / closed).toFixed(0) + "%" : "-";
    const rrAvg = s.total > 0 ? "1:" + (s.sumRR / s.total).toFixed(1) : "-";
    const rNet = s.rWin - s.losses;
    const pNet = s.pWin - s.pLoss;
    const avgR = closed > 0 ? `${rNet >= 0 ? "+" : ""}${(rNet / closed).toFixed(2)}R/lệnh` : "";

    const fmtVal = (rV, pV, sign) => {
      let txt = `${sign}${rV.toFixed(2)}R | ${sign}${pV.toFixed(1)}`;
      if (v14Config.statLot > 0) {
        txt += ` | ${sign}${(pV * v14Config.statPV * v14Config.statLot).toFixed(0)}$`;
      }
      return txt;
    };

    let html = `
      <tr style="background:#1e3a8a; color:#fff; font-weight:700;">
        <td>${v14Config.statPer}</td>
        <td>${mtfCache.symbol} ${activeTf}</td>
      </tr>
      <tr>
        <td>Lệnh</td>
        <td>${s.total} &nbsp;<span style="color:#10b981;">✓${s.wins}</span> <span style="color:#ef4444;">✗${s.losses}</span> <span style="color:#fbbf24;">⏳${res.openCount}</span></td>
      </tr>
      <tr>
        <td>WR · RR</td>
        <td><b>${wr}</b> · ${rrAvg} ${avgR ? "· " + avgR : ""}</td>
      </tr>
      <tr>
        <td>Thắng</td>
        <td style="color:#10b981;">${fmtVal(s.rWin, s.pWin, "+")}</td>
      </tr>
      <tr>
        <td>Thua</td>
        <td style="color:#ef4444;">${fmtVal(s.losses, s.pLoss, "-")}</td>
      </tr>
      <tr>
        <td>Ròng</td>
        <td style="color:${pNet >= 0 ? "#10b981" : "#ef4444"}; font-weight:700;">${fmtVal(Math.abs(rNet), Math.abs(pNet), pNet >= 0 ? "+" : "-")}</td>
      </tr>
      <tr style="background:#1e3a8a; color:#fff; font-weight:700;">
        <td>Khung</td>
        <td>Trạng thái vùng MTF</td>
      </tr>
    `;

    res.htfSummary.forEach(h => {
      if (!h.use) return;
      let bg = "rgba(71,85,105,0.45)";
      let stt = "—";
      if (!h.ok) {
        bg = "rgba(217,119,6,0.35)";
        stt = "bỏ qua";
      } else if (h.val > 0) {
        bg = Math.abs(h.val) === 2 ? "rgba(16,185,129,0.55)" : "rgba(16,185,129,0.22)";
        stt = "BUY " + (Math.abs(h.val) === 2 ? "✓" : "…");
      } else if (h.val < 0) {
        bg = Math.abs(h.val) === 2 ? "rgba(239,68,68,0.55)" : "rgba(239,68,68,0.22)";
        stt = "SELL " + (Math.abs(h.val) === 2 ? "✓" : "…");
      }
      html += `<tr style="background:${bg};"><td><b>${h.tf}</b></td><td>${stt}</td></tr>`;
    });

    tbl.innerHTML = html;
  }

  // =========================================================================
  // 6. BAR REPLAY CONTROLLER (TUA THỜI GIAN BACKTEST)
  // =========================================================================
  function updateReplayUI() {
    const bar = document.getElementById("nx-replay-controls");
    const statusEl = document.getElementById("nx-replay-status");
    const playBtn = document.getElementById("nx-replay-play");
    if (!bar) return;

    if (!replayState.active) {
      if (statusEl) statusEl.innerText = "LIVE REALTIME";
      if (playBtn) playBtn.innerText = "▶ PLAY";
      return;
    }

    const curBar = fullCandles[replayState.index];
    const dtStr = curBar ? new Date((curBar.time + 7 * 3600) * 1000).toISOString().replace("T", " ").slice(0, 16) : "--";
    if (statusEl) statusEl.innerText = `REPLAY: ${dtStr} (${replayState.index + 1}/${fullCandles.length})`;
    if (playBtn) playBtn.innerText = replayState.playing ? "❚❚ PAUSE" : "▶ PLAY";
  }

  window.startPickReplayCut = function () {
    replayState.pickingCut = true;
    updateToolbarStatus("CLICK VÀO CÂY NẾN TRÊN BIỂU ĐỒ ĐỂ CẮT THỜI GIAN BACKTEST...");
  };

  window.toggleReplayPlay = function () {
    if (!replayState.active && fullCandles.length > 60) {
      replayState.active = true;
      replayState.index = Math.max(40, fullCandles.length - 80);
    }
    replayState.playing = !replayState.playing;
    if (replayState.playing) {
      replayState.timer = setInterval(() => {
        if (replayState.index < fullCandles.length - 1) {
          replayState.index += 1;
          updateReplayUI();
          recomputeAndRenderAll();
        } else {
          replayState.playing = false;
          clearInterval(replayState.timer);
          updateReplayUI();
        }
      }, replayState.speedMs);
    } else {
      clearInterval(replayState.timer);
    }
    updateReplayUI();
  };

  window.stepReplayBar = function (delta) {
    if (!replayState.active && fullCandles.length > 60) {
      replayState.active = true;
      replayState.index = Math.max(40, fullCandles.length - 50);
    }
    replayState.index = Math.max(30, Math.min(fullCandles.length - 1, replayState.index + delta));
    updateReplayUI();
    recomputeAndRenderAll();
  };

  window.cycleReplaySpeed = function () {
    const speeds = [600, 250, 80];
    const labels = ["1X", "3X", "10X"];
    const nextIdx = (speeds.indexOf(replayState.speedMs) + 1) % speeds.length;
    replayState.speedMs = speeds[nextIdx];
    const btn = document.getElementById("nx-replay-speed");
    if (btn) btn.innerText = labels[nextIdx];
    if (replayState.playing) {
      clearInterval(replayState.timer);
      replayState.playing = false;
      window.toggleReplayPlay();
    }
  };

  window.exitReplayMode = function () {
    replayState.active = false;
    replayState.playing = false;
    replayState.pickingCut = false;
    clearInterval(replayState.timer);
    const series = findCandleSeries();
    if (series && fullCandles.length > 0) {
      try { series.setData(fullCandles); } catch (e) {}
    }
    updateReplayUI();
    recomputeAndRenderAll();
    updateToolbarStatus("ĐÃ QUAY LẠI DỮ LIỆU THỜI GIAN THỰC");
  };

  // =========================================================================
  // 7. GIAO DIỆN TOOLBAR VẼ + REPLAY + CUSTOM INDICATOR IDE MODAL
  // =========================================================================
  function updateToolbarStatus(msg) {
    const el = document.getElementById("nx-studio-msg");
    if (el) el.innerText = msg;
  }

  function injectStudioUI() {
    if (document.getElementById("nx-studio-dock")) return;

    const style = document.createElement("style");
    style.innerHTML = `
      #nx-studio-dock {
        position: fixed;
        top: 40px;
        left: 14px;
        z-index: 99998;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        background: rgba(7, 11, 19, 0.94);
        border: 1px solid rgba(255, 153, 0, 0.4);
        padding: 5px 10px;
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 10px;
        color: #e2e8f0;
        box-shadow: 0 8px 24px rgba(0,0,0,0.75);
      }
      .nx-tool-btn {
        background: #0f172a;
        color: #cbd5e1;
        border: 1px solid rgba(148,163,184,0.28);
        padding: 3px 7px;
        font-family: inherit;
        font-size: 9.5px;
        cursor: pointer;
        font-weight: 700;
      }
      .nx-tool-btn:hover { border-color: #ff9900; color: #fff; }
      .nx-tool-btn.active { background: #ff9900; color: #000; border-color: #ff9900; }
      .nx-sep { width: 1px; height: 16px; background: rgba(148,163,184,0.25); margin: 0 2px; }
      #nx-v14-minimap {
        position: fixed;
        top: 82px;
        right: 365px;
        z-index: 99990;
        background: rgba(7, 11, 19, 0.92);
        border: 1px solid rgba(148,163,184,0.3);
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 10px;
        color: #f8fafc;
        min-width: 215px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.7);
      }
      #nx-v14-minimap table { width: 100%; border-collapse: collapse; }
      #nx-v14-minimap td { padding: 3px 7px; border: 1px solid rgba(148,163,184,0.18); font-variant-numeric: tabular-nums; }
      #nx-ind-modal {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 100005;
        background: rgba(2, 6, 14, 0.82);
        backdrop-filter: blur(6px);
        align-items: center;
        justify-content: center;
        font-family: 'JetBrains Mono', 'Consolas', monospace;
      }
      .nx-modal-card {
        width: 720px;
        max-width: 95vw;
        max-height: 88vh;
        overflow-y: auto;
        background: #090e1a;
        border: 1px solid #ff9900;
        padding: 16px 20px;
        color: #e2e8f0;
      }
      .nx-form-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin: 12px 0;
      }
      .nx-field label { display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; }
      .nx-field input, .nx-field select, .nx-modal-card textarea {
        width: 100%;
        background: #04070d;
        border: 1px solid rgba(56,189,248,0.4);
        color: #fff;
        font-family: inherit;
        font-size: 11px;
        padding: 4px 6px;
      }
    `;
    document.head.appendChild(style);

    const dock = document.createElement("div");
    dock.id = "nx-studio-dock";
    dock.innerHTML = `
      <span style="color:#ff9900; font-weight:800;">TOOLS:</span>
      <button class="nx-tool-btn active" data-tool="CURSOR" onclick="setDrawTool('CURSOR')">CURSOR</button>
      <button class="nx-tool-btn" data-tool="TRENDLINE" onclick="setDrawTool('TRENDLINE')">LINE</button>
      <button class="nx-tool-btn" data-tool="HLINE" onclick="setDrawTool('HLINE')">H-LINE</button>
      <button class="nx-tool-btn" data-tool="LONG_BOX" onclick="setDrawTool('LONG_BOX')" style="color:#10b981;">LONG TP/SL</button>
      <button class="nx-tool-btn" data-tool="SHORT_BOX" onclick="setDrawTool('SHORT_BOX')" style="color:#ef4444;">SHORT TP/SL</button>
      <button class="nx-tool-btn" onclick="clearAllUserDrawings()" title="Xóa toàn bộ nét vẽ">CLR</button>
      <div class="nx-sep"></div>
      <span style="color:#38bdf8; font-weight:800;">REPLAY:</span>
      <button class="nx-tool-btn" onclick="startPickReplayCut()" title="Click lên nến bất kỳ để cắt thời gian backtest">✂ CUT</button>
      <button class="nx-tool-btn" onclick="stepReplayBar(-1)">|&lt;</button>
      <button class="nx-tool-btn" id="nx-replay-play" onclick="toggleReplayPlay()">▶ PLAY</button>
      <button class="nx-tool-btn" onclick="stepReplayBar(1)">&gt;|</button>
      <button class="nx-tool-btn" id="nx-replay-speed" onclick="cycleReplaySpeed()">1X</button>
      <button class="nx-tool-btn" onclick="exitReplayMode()" style="color:#fbbf24;">EXIT</button>
      <div class="nx-sep"></div>
      <button class="nx-tool-btn" onclick="openIndicatorIDE()" style="border-color:#10b981; color:#10b981;">⚙ INDICATOR IDE (v14)</button>
      <span id="nx-replay-status" style="color:#94a3b8; margin-left:4px;">LIVE REALTIME</span>
      <span id="nx-studio-msg" style="color:#38bdf8; margin-left:6px;">FUTURE AXIS UNLOCKED</span>
    `;
    document.body.appendChild(dock);

    const minimap = document.createElement("div");
    minimap.id = "nx-v14-minimap";
    minimap.innerHTML = `<table><tbody id="nx-v14-table-body"><tr><td>Loading Engulf v14 MTF...</td></tr></tbody></table>`;
    document.body.appendChild(minimap);

    const modal = document.createElement("div");
    modal.id = "nx-ind-modal";
    modal.innerHTML = `
      <div class="nx-modal-card">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,153,0,0.3); padding-bottom:8px;">
          <b style="color:#ff9900; font-size:13px;">ENGULF SIGNAL V14 MTF FILTER & CUSTOM INDICATOR STUDIO</b>
          <button class="nx-tool-btn" onclick="closeIndicatorIDE()">ĐÓNG [X]</button>
        </div>

        <div class="nx-form-grid">
          <div class="nx-field"><label>Cây thứ N sau cây gốc (minBarsIn)</label><input id="cfg-minBarsIn" type="number" value="4" min="2" /></div>
          <div class="nx-field"><label>Dung sai nhấn chìm (tol)</label><input id="cfg-tol" type="number" step="0.05" value="0.2" /></div>
          <div class="nx-field"><label>Cách tính nằm trong cây gốc</label>
            <select id="cfg-containMode"><option value="Thân nến">Thân nến</option><option value="Râu nến">Râu nến</option></select>
          </div>
          <div class="nx-field"><label>Bộ lọc xu hướng khung lớn</label>
            <select id="cfg-filterMode">
              <option value="FLT_STRONG">Thuận mạnh (≥1 xong hoặc ≥2 cùng chiều)</option>
              <option value="FLT_OFF">Tắt - báo tất cả</option>
              <option value="FLT_NOCTR">Bỏ nghịch xu hướng (tím)</option>
              <option value="FLT_DONE">≥1 khung lớn đã có tín hiệu</option>
              <option value="FLT_TWO">≥2 khung lớn cùng chiều</option>
            </select>
          </div>
          <div class="nx-field"><label>RR Phiên Á / Âu / Mỹ</label>
            <div style="display:flex; gap:4px;">
              <input id="cfg-rrAsia" type="number" step="0.1" value="1.0" title="RR Á" />
              <input id="cfg-rrEu" type="number" step="0.1" value="1.0" title="RR Âu" />
              <input id="cfg-rrUs" type="number" step="0.1" value="2.0" title="RR Mỹ" />
            </div>
          </div>
          <div class="nx-field"><label>Khoảng thống kê Backtest</label>
            <select id="cfg-statPer">
              <option value="Toàn bộ dữ liệu">Toàn bộ dữ liệu</option>
              <option value="Tuần này">Tuần này</option>
              <option value="Tháng này">Tháng này</option>
            </select>
          </div>
          <div class="nx-field"><label>Số Lot quy tiền (0 = tắt)</label><input id="cfg-statLot" type="number" step="0.01" value="0.0" /></div>
          <div class="nx-field"><label>Hiện tín hiệu bị lọc (chấm xám)</label>
            <select id="cfg-showFilt"><option value="false">Tắt</option><option value="true">Bật</option></select>
          </div>
          <div class="nx-field"><label>Vẽ Supertrend (ATR 10, 3.0)</label>
            <select id="cfg-stShow"><option value="true">Bật</option><option value="false">Tắt</option></select>
          </div>
        </div>

        <div style="margin-top:10px; border-top:1px solid rgba(148,163,184,0.2); padding-top:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <b style="color:#38bdf8; font-size:11px;">TỰ VIẾT CUSTOM INDICATOR BỔ SUNG (CHẠY TRỰC TIẾP TRÊN CHART)</b>
            <label style="font-size:10px; color:#10b981;"><input id="cfg-customEnabled" type="checkbox" /> Kích hoạt Indicator tự viết</label>
          </div>
          <textarea id="cfg-customCode" rows="8"></textarea>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
          <button class="nx-tool-btn" onclick="saveAndApplyIndicatorSettings()" style="background:#10b981; color:#000; border-color:#10b981; padding:6px 14px;">LƯU & ÁP DỤNG LÊN CHART</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  window.openIndicatorIDE = function () {
    const m = document.getElementById("nx-ind-modal");
    if (!m) return;
    document.getElementById("cfg-minBarsIn").value = v14Config.minBarsIn;
    document.getElementById("cfg-tol").value = v14Config.tol;
    document.getElementById("cfg-containMode").value = v14Config.containMode;
    document.getElementById("cfg-filterMode").value = v14Config.filterMode;
    document.getElementById("cfg-rrAsia").value = v14Config.rrAsia;
    document.getElementById("cfg-rrEu").value = v14Config.rrEu;
    document.getElementById("cfg-rrUs").value = v14Config.rrUs;
    document.getElementById("cfg-statPer").value = v14Config.statPer;
    document.getElementById("cfg-statLot").value = v14Config.statLot;
    document.getElementById("cfg-showFilt").value = String(v14Config.showFilt);
    document.getElementById("cfg-stShow").value = String(v14Config.stShow);
    document.getElementById("cfg-customEnabled").checked = customScripts[0].enabled;
    document.getElementById("cfg-customCode").value = customScripts[0].code;
    m.style.display = "flex";
  };

  window.closeIndicatorIDE = function () {
    const m = document.getElementById("nx-ind-modal");
    if (m) m.style.display = "none";
  };

  window.saveAndApplyIndicatorSettings = async function () {
    v14Config.minBarsIn = parseInt(document.getElementById("cfg-minBarsIn").value, 10) || 4;
    v14Config.tol = parseFloat(document.getElementById("cfg-tol").value) || 0.2;
    v14Config.containMode = document.getElementById("cfg-containMode").value;
    v14Config.filterMode = document.getElementById("cfg-filterMode").value;
    v14Config.rrAsia = parseFloat(document.getElementById("cfg-rrAsia").value) || 1.0;
    v14Config.rrEu = parseFloat(document.getElementById("cfg-rrEu").value) || 1.0;
    v14Config.rrUs = parseFloat(document.getElementById("cfg-rrUs").value) || 2.0;
    v14Config.statPer = document.getElementById("cfg-statPer").value;
    v14Config.statLot = parseFloat(document.getElementById("cfg-statLot").value) || 0.0;
    v14Config.showFilt = document.getElementById("cfg-showFilt").value === "true";
    v14Config.stShow = document.getElementById("cfg-stShow").value === "true";

    customScripts[0].enabled = document.getElementById("cfg-customEnabled").checked;
    customScripts[0].code = document.getElementById("cfg-customCode").value;

    try {
      await fetch("/api/indicators/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active_config: v14Config, custom_scripts: customScripts })
      });
    } catch (e) {}

    window.closeIndicatorIDE();
    recomputeAndRenderAll();
  };

  // =========================================================================
  // 8. ĐỒNG BỘ DỮ LIỆU ĐA KHUNG (MTF) & KHỞI CHẠY
  // =========================================================================
  async function syncMultiTimeframeData() {
    if (replayState.active) return; // Không ghi đè dữ liệu khi đang tua Replay
    try {
      const res = await fetch("/api/mt5/multi_tf?count=400");
      const json = await res.json();
      if (json.status === "OK" && json.data) {
        mtfCache = json;
        // Phát hiện khung thời gian đang chọn trên giao diện
        const tfMatch = document.body.innerText.match(/\b(M1|M5|M15|M30|H1|H4|D1)\b/);
        if (tfMatch && json.data[tfMatch[0]] && json.data[tfMatch[0]].length > 30) {
          activeTf = tfMatch[0];
        }
        if (json.data[activeTf] && json.data[activeTf].length > 30) {
          fullCandles = json.data[activeTf];
          recomputeAndRenderAll();
        }
      }
    } catch (e) {}
  }

  async function loadSavedIndicators() {
    try {
      const res = await fetch("/api/indicators/custom");
      const saved = await res.json();
      if (saved && saved.active_config && Object.keys(saved.active_config).length > 0) {
        Object.assign(v14Config, saved.active_config);
      }
      if (saved && Array.isArray(saved.custom_scripts) && saved.custom_scripts.length > 0) {
        customScripts = saved.custom_scripts;
      }
    } catch (e) {}
  }

  injectStudioUI();
  loadSavedIndicators().then(() => {
    syncMultiTimeframeData();
    setInterval(syncMultiTimeframeData, 4000);
  });
})();
