(function () {
  if (window.__NEXUS_STUDIO_LOADED__) return;
  window.__NEXUS_STUDIO_LOADED__ = true;

  const IndLib = window.NexusIndicators;

  // =========================================================================
  // 1. TRẠNG THÁI INDICATOR TÁCH RỜI & CỬA SỔ CALL LỆNH BẬT/TẮT
  // =========================================================================
  let indicatorStates = {
    engulf_v14: true,
    supertrend: false,
    call_window: true // Cửa sổ Ô Call Lệnh & Thống kê MTF (bật/tắt 1 chạm)
  };
  let stParams = { periods: 10, mult: 3.0 };
  let v14Config = Object.assign({}, IndLib.defaultV14Config);
  let customIndicators = [
    {
      id: "custom_ema_default",
      name: "EMA 20 / 50 Trend",
      enabled: false,
      code: IndLib.defaultCustomTemplate
    }
  ];

  // Trạng thái Dữ liệu & Replay
  let mtfCache = { symbol: "XAUUSD", digits: 2, data: {} };
  let activeTf = "M5";
  let fullCandles = [];
  let replayState = {
    active: false,
    index: 0,
    playing: false,
    speedMs: 500,
    timer: null,
    pickingCut: false
  };

  let chartRef = null;
  let candleSeriesRef = null;
  let futureAnchorSeries = null;
  let stUpSeries = null;
  let stDownSeries = null;
  let v14BoxSeries = [];
  let v14PriceLines = [];
  let customSeriesMap = {};

  let drawTool = "CURSOR";
  let pendingPoint = null;
  let userDrawings = [];

  // =========================================================================
  // 2. HOOK CHART + CHẶN GHI ĐÈ KHI REPLAY + MỞ KHÓA TRỤC TƯƠNG LAI
  // =========================================================================
  function patchCandleSeriesForReplay(series) {
    if (!series || series.__replayPatched) return;
    series.__replayPatched = true;
    const origSetData = series.setData.bind(series);
    const origUpdate = series.update.bind(series);

    series.__rawSetData = origSetData;
    series.__rawUpdate = origUpdate;

    // Khi đang bật Replay, chặn mọi luồng live từ index.html ghi đè chart!
    series.setData = function (data) {
      if (replayState.active) {
        return;
      }
      return origSetData(data);
    };

    series.update = function (bar) {
      if (replayState.active) {
        return;
      }
      return origUpdate(bar);
    };
  }

  function attachToChart(chart) {
    if (!chart || chart.__nexusHooked) return;
    chart.__nexusHooked = true;
    chartRef = chart;

    try {
      chart.timeScale().applyOptions({
        rightOffset: 80,
        fixRightEdge: false,
        shiftVisibleRangeOnNewBar: false
      });
    } catch (e) {}

    try {
      futureAnchorSeries = chart.addLineSeries({
        color: "rgba(0,0,0,0)",
        lineWidth: 1,
        visible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false
      });
    } catch (e) {}

    chart.subscribeClick((param) => {
      if (!param || !param.point) return;
      const series = findCandleSeries();
      if (!series) return;
      const price = series.coordinateToPrice(param.point.y);
      let clickTime = param.time;

      if (!clickTime && param.logical !== undefined && fullCandles.length >= 2) {
        const tfSec = IndLib.getTfSeconds(activeTf);
        const baseIdx = Math.min(fullCandles.length - 1, Math.max(0, Math.floor(param.logical)));
        const deltaBars = Math.round(param.logical) - baseIdx;
        clickTime = fullCandles[baseIdx].time + deltaBars * tfSec;
      }
      if (!clickTime || price === null || price === undefined) return;

      // Xử lý cắt thời gian Replay khi click lên bất kỳ cây nến nào
      if (replayState.pickingCut) {
        replayState.pickingCut = false;
        const cutIdx = fullCandles.findIndex(c => c.time >= clickTime);
        if (cutIdx >= 30) {
          replayState.active = true;
          replayState.index = cutIdx;
          updateReplayUI();
          renderAllActiveIndicators();
          updateToolbarStatus(`ĐÃ CẮT REPLAY TẠI NẾN #${cutIdx + 1}`);
        }
        return;
      }

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
    if (candleSeriesRef) patchCandleSeriesForReplay(candleSeriesRef);
    return { chart: chartRef, series: candleSeriesRef };
  }

  function findCandleSeries() {
    return findChartAndSeries().series;
  }

  function unlockFutureTimeAxis(candles) {
    const { chart } = findChartAndSeries();
    if (!chart || !futureAnchorSeries || !candles || candles.length === 0) return;
    const tfSec = IndLib.getTfSeconds(activeTf);
    const lastT = candles[candles.length - 1].time;
    const futureWhitespace = [];
    for (let k = 1; k <= 300; k++) {
      futureWhitespace.push({ time: lastT + k * tfSec });
    }
    try {
      futureAnchorSeries.setData(futureWhitespace);
      chart.timeScale().applyOptions({ rightOffset: 80, fixRightEdge: false });
    } catch (e) {}
  }

  // =========================================================================
  // 3. BỘ CÔNG CỤ VẼ HỖ TRỢ KÉO SANG TƯƠNG LAI
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
      updateToolbarStatus(`ĐIỂM 1: ${pt.price.toFixed(digits)} — CLICK ĐIỂM 2 (VẼ SANG TƯƠNG LAI THOẢI MÁI)`);
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
      if (pts[0].time === pts[1].time) pts[1].time += IndLib.getTfSeconds(activeTf);
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
      const tEnd = Math.max(p1.time, p2.time) + IndLib.getTfSeconds(activeTf) * 15;

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
    document.querySelectorAll(".nx-tool-btn[data-tool]").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    updateToolbarStatus(tool === "CURSOR" ? "READY" : `TOOL: ${tool} — CLICK TRÊN CHART`);
  };

  window.clearAllUserDrawings = function () {
    const { chart, series } = findChartAndSeries();
    userDrawings.forEach(d => {
      if (series && d.priceLines) d.priceLines.forEach(pl => { try { series.removePriceLine(pl); } catch (e) {} });
      if (chart && d.seriesList) d.seriesList.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
    });
    userDrawings = [];
    pendingPoint = null;
    updateToolbarStatus("ĐÃ XÓA NÉT VẼ TAY");
  };

  // =========================================================================
  // 4. BỘ QUẢN LÝ BẬT/TẮT TỪNG INDICATOR & CỬA SỔ CALL LỆNH
  // =========================================================================
  function clearAllLayers() {
    const { chart, series } = findChartAndSeries();
    if (chart) {
      if (stUpSeries) { try { chart.removeSeries(stUpSeries); } catch (e) {} stUpSeries = null; }
      if (stDownSeries) { try { chart.removeSeries(stDownSeries); } catch (e) {} stDownSeries = null; }
      v14BoxSeries.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
      Object.keys(customSeriesMap).forEach(id => {
        (customSeriesMap[id] || []).forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
      });
    }
    v14BoxSeries = [];
    customSeriesMap = {};
    if (series) {
      v14PriceLines.forEach(pl => { try { series.removePriceLine(pl); } catch (e) {} });
    }
    v14PriceLines = [];
  }

  function renderAllActiveIndicators() {
    const { chart, series } = findChartAndSeries();
    if (!chart || !series || fullCandles.length === 0) return;

    const visibleBars = replayState.active
      ? fullCandles.slice(0, Math.max(30, Math.min(fullCandles.length, replayState.index + 1)))
      : fullCandles;

    // Cập nhật đúng lát cắt nến lên chart bằng __rawSetData (không bị chặn bởi Replay patch)
    if (series.__rawSetData) {
      try { series.__rawSetData(visibleBars); } catch (e) {}
    }

    unlockFutureTimeAxis(visibleBars);
    clearAllLayers();

    let combinedMarkers = [];

    // 1. Supertrend (Tách rời)
    if (indicatorStates.supertrend) {
      const st = IndLib.evaluateSupertrend(visibleBars, stParams.periods, stParams.mult);
      stUpSeries = chart.addLineSeries({ color: "#10b981", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
      stDownSeries = chart.addLineSeries({ color: "#ef4444", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
      stUpSeries.setData(st.up);
      stDownSeries.setData(st.down);
    }

    // 2. Engulf Signal v14 MTF Filter (Tách rời)
    let latestV14Res = null;
    if (indicatorStates.engulf_v14) {
      latestV14Res = IndLib.evaluateEngulfV14(visibleBars, activeTf, mtfCache.data, v14Config);
      if (latestV14Res) {
        combinedMarkers = combinedMarkers.concat(latestV14Res.markers);

        if (v14Config.showBox) {
          latestV14Res.boxSegments.forEach(bx => {
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
              v14BoxSeries.push(ls);
            });
          });
        }

        if (v14Config.showSLTP && latestV14Res.lastSignalLevels) {
          const sig = latestV14Res.lastSignalLevels;
          const tfSec = IndLib.getTfSeconds(activeTf);
          const tFutureEnd = sig.time + 10 * tfSec;

          const slLine = chart.addLineSeries({ color: "#ef4444", lineWidth: 2, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
          slLine.setData([{ time: sig.time, value: sig.sl }, { time: tFutureEnd, value: sig.sl }]);
          v14BoxSeries.push(slLine);

          const tpLine = chart.addLineSeries({ color: "#10b981", lineWidth: 2, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
          tpLine.setData([{ time: sig.time, value: sig.tp }, { time: tFutureEnd, value: sig.tp }]);
          v14BoxSeries.push(tpLine);

          v14PriceLines.push(series.createPriceLine({
            price: sig.tp, color: "#10b981", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `TP (${sig.rr}R)`
          }));
          v14PriceLines.push(series.createPriceLine({
            price: sig.sl, color: "#ef4444", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "SL"
          }));
        }
      }
    }

    // 3. Custom Indicators do người dùng tự viết
    customIndicators.forEach(ind => {
      if (!ind.enabled) return;
      try {
        const fn = new Function("candles", ind.code);
        const out = fn(visibleBars);
        if (out && Array.isArray(out.lines)) {
          customSeriesMap[ind.id] = [];
          out.lines.forEach(l => {
            const s = chart.addLineSeries({
              color: l.color || "#38bdf8",
              lineWidth: l.width || 2,
              lastValueVisible: false,
              priceLineVisible: false
            });
            s.setData(l.data || []);
            customSeriesMap[ind.id].push(s);
          });
        }
        if (out && Array.isArray(out.markers)) {
          combinedMarkers = combinedMarkers.concat(out.markers);
        }
      } catch (err) {}
    });

    combinedMarkers.sort((a, b) => a.time - b.time);
    try { series.setMarkers(combinedMarkers); } catch (e) {}

    renderCallOrderWindow(latestV14Res);
    renderIndicatorLegendPills();
  }

  // =========================================================================
  // 5. CỬA SỔ "Ô CALL LỆNH & THỐNG KÊ MTF" CÓ THỂ BẬT / TẮT 1 CHẠM
  // =========================================================================
  function renderCallOrderWindow(res) {
    const win = document.getElementById("nx-call-window");
    if (!win) return;

    // Ẩn hoàn toàn cửa sổ nếu người dùng tắt "call_window" hoặc tắt "engulf_v14"
    if (!indicatorStates.call_window || !indicatorStates.engulf_v14 || !res) {
      win.style.display = "none";
      return;
    }
    win.style.display = "block";

    const body = document.getElementById("nx-call-window-body");
    if (!body) return;

    const digits = mtfCache.digits || 2;
    const s = res.stats;
    const closed = s.wins + s.losses;
    const wr = closed > 0 ? ((100 * s.wins) / closed).toFixed(0) + "%" : "-";
    const rrAvg = s.total > 0 ? "1:" + (s.sumRR / s.total).toFixed(1) : "-";
    const rNet = s.rWin - s.losses;
    const pNet = s.pWin - s.pLoss;

    // 1. Khối Ô Call Lệnh mới nhất
    let callCardHtml = "";
    const sig = res.lastSignalLevels;
    if (sig) {
      const isBuy = sig.side === "BUY";
      const badgeBg = sig.counter ? "#a855f7" : (isBuy ? "#10b981" : "#ef4444");
      const dtStr = new Date((sig.time + 7 * 3600) * 1000).toISOString().replace("T", " ").slice(5, 16);
      callCardHtml = `
        <div style="background:rgba(15,23,42,0.95); border:1px solid ${badgeBg}; padding:8px; margin-bottom:7px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
            <span style="background:${badgeBg}; color:#000; font-weight:900; padding:2px 6px; font-size:10.5px;">
              CALL ${sig.side} ${sig.counter ? "(NGHỊCH MTF)" : ""}
            </span>
            <span style="color:#94a3b8; font-size:9.5px;">${dtStr} · Phiên ${sig.sess}</span>
          </div>
          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:4px; font-size:10.5px; text-align:center; background:#050811; padding:5px; border:1px solid rgba(148,163,184,0.18);">
            <div><div style="color:#94a3b8; font-size:8.5px;">ENTRY</div><b style="color:#38bdf8;">${sig.entry.toFixed(digits)}</b></div>
            <div><div style="color:#94a3b8; font-size:8.5px;">SL</div><b style="color:#ef4444;">${sig.sl.toFixed(digits)}</b></div>
            <div><div style="color:#94a3b8; font-size:8.5px;">TP (${sig.rr}R)</div><b style="color:#10b981;">${sig.tp.toFixed(digits)}</b></div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:9.5px;">
            <span style="color:#cbd5e1;">Cách hiện tại: <b>${sig.barsAgo} nến</b></span>
            <button onclick="executeCallOrderToMT5('${sig.side}', ${sig.entry}, ${sig.sl}, ${sig.tp})" style="background:#ff9900; color:#000; border:none; padding:3px 8px; font-family:inherit; font-weight:800; font-size:9.5px; cursor:pointer;">
              ⚡ VÀO LỆNH MT5
            </button>
          </div>
        </div>
      `;
    } else {
      callCardHtml = `
        <div style="background:#050811; border:1px dashed rgba(148,163,184,0.3); padding:7px; margin-bottom:7px; color:#94a3b8; font-size:10px;">
          Chưa có lệnh thỏa điều kiện lọc hiện tại. Thử đổi bộ lọc bên dưới sang <b>"Tắt lọc (Tất cả B/S)"</b> để xem toàn bộ tín hiệu.
        </div>
      `;
    }

    // 2. Chẩn đoán trạng thái cây gốc đang theo dõi (giúp biết indicator đang phân tích hướng nào)
    const stp = res.liveSetup;
    const setupText = stp.dir === 1
      ? `<span style="color:#10b981;">ĐANG SĂN BUY (nến ${stp.barsInSetup}/${stp.minBarsIn})</span>`
      : (stp.dir === -1
        ? `<span style="color:#ef4444;">ĐANG SĂN SELL (nến ${stp.barsInSetup}/${stp.minBarsIn})</span>`
        : `<span style="color:#94a3b8;">CHỜ CÂY GỐC MỚI</span>`);

    // 3. Bộ chuyển nhanh chế độ lọc ngay trên cửa sổ
    const filterSelector = `
      <div style="margin-bottom:7px;">
        <div style="display:flex; justify-content:space-between; font-size:9.5px; margin-bottom:3px;">
          <span style="color:#94a3b8;">Trạng thái:</span>
          <b>${setupText}</b>
        </div>
        <select onchange="quickChangeV14Filter(this.value)" style="width:100%; background:#050811; color:#38bdf8; border:1px solid rgba(56,189,248,0.4); font-family:inherit; font-size:10px; padding:3px 5px;">
          <option value="FLT_OFF" ${v14Config.filterMode === "FLT_OFF" ? "selected" : ""}>Lọc: Tắt (Hiện tất cả BUY & SELL)</option>
          <option value="FLT_NOCTR" ${v14Config.filterMode === "FLT_NOCTR" ? "selected" : ""}>Lọc: Bỏ tín hiệu nghịch khung lớn</option>
          <option value="FLT_STRONG" ${v14Config.filterMode === "FLT_STRONG" ? "selected" : ""}>Lọc: Thuận mạnh (≥1 xong hoặc ≥2 cùng chiều)</option>
          <option value="FLT_DONE" ${v14Config.filterMode === "FLT_DONE" ? "selected" : ""}>Lọc: ≥1 khung lớn đã có tín hiệu</option>
          <option value="FLT_TWO" ${v14Config.filterMode === "FLT_TWO" ? "selected" : ""}>Lọc: ≥2 khung lớn cùng chiều</option>
        </select>
      </div>
    `;

    // 4. Bảng thống kê Backtest (chia rõ số lệnh BUY và SELL) & Minimap 5 khung
    let mtfRows = "";
    res.htfSummary.forEach(h => {
      if (!h.use) return;
      let bg = "rgba(71,85,105,0.35)";
      let stt = "—";
      if (!h.ok) {
        bg = "rgba(217,119,6,0.3)";
        stt = "bỏ qua";
      } else if (h.val > 0) {
        bg = Math.abs(h.val) === 2 ? "rgba(16,185,129,0.5)" : "rgba(16,185,129,0.2)";
        stt = "BUY " + (Math.abs(h.val) === 2 ? "✓" : "…");
      } else if (h.val < 0) {
        bg = Math.abs(h.val) === 2 ? "rgba(239,68,68,0.5)" : "rgba(239,68,68,0.2)";
        stt = "SELL " + (Math.abs(h.val) === 2 ? "✓" : "…");
      }
      mtfRows += `<tr style="background:${bg};"><td><b>${h.tf}</b></td><td>${stt}</td></tr>`;
    });

    body.innerHTML = `
      ${callCardHtml}
      ${filterSelector}
      <table style="width:100%; border-collapse:collapse; font-size:10px;">
        <tr style="background:#1e3a8a; color:#fff; font-weight:700;">
          <td>Backtest (${fullCandles.length} nến)</td>
          <td>${mtfCache.symbol} ${activeTf}</td>
        </tr>
        <tr>
          <td>Tổng lệnh</td>
          <td><b>${s.total}</b> (<span style="color:#10b981;">B:${s.buyCount}</span> · <span style="color:#ef4444;">S:${s.sellCount}</span>)</td>
        </tr>
        <tr>
          <td>Kết quả</td>
          <td><span style="color:#10b981;">✓${s.wins}</span> · <span style="color:#ef4444;">✗${s.losses}</span> · <span style="color:#fbbf24;">⏳${res.openCount}</span></td>
        </tr>
        <tr>
          <td>WR · RR</td>
          <td><b>${wr}</b> · ${rrAvg}</td>
        </tr>
        <tr>
          <td>Ròng R</td>
          <td style="color:${rNet >= 0 ? "#10b981" : "#ef4444"}; font-weight:800;">${rNet >= 0 ? "+" : ""}${rNet.toFixed(2)}R (${pNet >= 0 ? "+" : ""}${pNet.toFixed(1)})</td>
        </tr>
        <tr style="background:#1e3a8a; color:#fff; font-weight:700;">
          <td>Khung lớn</td>
          <td>Trạng thái vùng</td>
        </tr>
        ${mtfRows}
      </table>
    `;
  }

  window.quickChangeV14Filter = function (mode) {
    v14Config.filterMode = mode;
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  window.executeCallOrderToMT5 = async function (side, entry, sl, tp) {
    try {
      const res = await fetch("/api/trade/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: mtfCache.symbol,
          action: side,
          volume: 0.01,
          sl: Number(sl),
          tp: Number(tp),
          comment: "NEXUS_V14_CALL"
        })
      });
      const data = await res.json();
      updateToolbarStatus(`MT5 ORDER ${side}: ${data.status || JSON.stringify(data)}`);
    } catch (e) {
      updateToolbarStatus("LỖI GỬI LỆNH SANG MT5");
    }
  };

  // =========================================================================
  // 6. THANH THẺ INDICATOR & NÚT BẬT/TẮT CỬA SỔ CALL LỆNH
  // =========================================================================
  function renderIndicatorLegendPills() {
    const box = document.getElementById("nx-ind-pills-bar");
    if (!box) return;

    const makePill = (title, isOn, toggleFn, configFn, deleteFn) => {
      const eyeColor = isOn ? "#10b981" : "#64748b";
      const borderCol = isOn ? "rgba(16,185,129,0.55)" : "rgba(148,163,184,0.25)";
      const textCol = isOn ? "#f8fafc" : "#64748b";
      return `
        <div style="display:inline-flex; align-items:center; gap:5px; background:rgba(9,14,26,0.92); border:1px solid ${borderCol}; padding:3px 7px; font-size:10px; color:${textCol};">
          <button onclick="${toggleFn}" title="Bật / Tắt hiển thị trên biểu đồ" style="background:none; border:none; color:${eyeColor}; cursor:pointer; font-weight:800; padding:0;">
            ${isOn ? "👁 ON" : "🚫 OFF"}
          </button>
          <span style="font-weight:700;">${title}</span>
          ${configFn ? `<button onclick="${configFn}" title="Cài đặt" style="background:none; border:none; color:#38bdf8; cursor:pointer; padding:0 2px;">⚙</button>` : ""}
          ${deleteFn ? `<button onclick="${deleteFn}" title="Xóa" style="background:none; border:none; color:#ef4444; cursor:pointer; padding:0 2px;">✕</button>` : ""}
        </div>
      `;
    };

    let html = makePill(
      "Engulf v14 MTF",
      indicatorStates.engulf_v14,
      "toggleBuiltinIndicator('engulf_v14')",
      "openV14SettingsModal()",
      null
    );

    html += makePill(
      "Ô Call Lệnh & Bảng MTF",
      indicatorStates.call_window,
      "toggleBuiltinIndicator('call_window')",
      null,
      null
    );

    html += makePill(
      `Supertrend (${stParams.periods}, ${stParams.mult})`,
      indicatorStates.supertrend,
      "toggleBuiltinIndicator('supertrend')",
      "toggleSupertrendParams()",
      null
    );

    customIndicators.forEach(ind => {
      html += makePill(
        ind.name,
        ind.enabled,
        `toggleCustomIndicator('${ind.id}')`,
        `openCustomCreatorModal('${ind.id}')`,
        `deleteCustomIndicator('${ind.id}')`
      );
    });

    html += `
      <button onclick="openCustomCreatorModal(null)" style="background:#0f172a; border:1px dashed #38bdf8; color:#38bdf8; padding:3px 8px; font-family:inherit; font-size:10px; font-weight:700; cursor:pointer;">
        ＋ TẠO INDICATOR
      </button>
    `;

    box.innerHTML = html;
  }

  async function persistAllIndicatorSettings() {
    try {
      await fetch("/api/indicators/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          states: indicatorStates,
          st_params: stParams,
          v14_config: v14Config,
          custom_list: customIndicators
        })
      });
    } catch (e) {}
  }

  window.toggleBuiltinIndicator = function (key) {
    indicatorStates[key] = !indicatorStates[key];
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  window.toggleSupertrendParams = function () {
    const p = prompt("Nhập ATR Period cho Supertrend:", String(stParams.periods));
    if (p === null) return;
    const m = prompt("Nhập ATR Multiplier cho Supertrend:", String(stParams.mult));
    if (m === null) return;
    stParams.periods = Math.max(1, parseInt(p, 10) || 10);
    stParams.mult = Math.max(0.1, parseFloat(m) || 3.0);
    indicatorStates.supertrend = true;
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  window.toggleCustomIndicator = function (id) {
    const item = customIndicators.find(x => x.id === id);
    if (!item) return;
    item.enabled = !item.enabled;
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  window.deleteCustomIndicator = function (id) {
    customIndicators = customIndicators.filter(x => x.id !== id);
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  // =========================================================================
  // 7. BỘ ĐIỀU KHIỂN TUA THỜI GIAN BACKTEST (BAR REPLAY + THANH TRƯỢT)
  // =========================================================================
  function updateReplayUI() {
    const statusEl = document.getElementById("nx-replay-status");
    const playBtn = document.getElementById("nx-replay-play");
    const slider = document.getElementById("nx-replay-slider");

    if (slider && fullCandles.length > 30) {
      slider.min = 30;
      slider.max = fullCandles.length - 1;
      slider.value = replayState.active ? replayState.index : (fullCandles.length - 1);
    }

    if (!replayState.active) {
      if (statusEl) statusEl.innerText = "LIVE";
      if (playBtn) playBtn.innerText = "▶";
      return;
    }

    const curBar = fullCandles[replayState.index];
    const dtStr = curBar ? new Date((curBar.time + 7 * 3600) * 1000).toISOString().replace("T", " ").slice(5, 16) : "--";
    if (statusEl) statusEl.innerText = `${dtStr} (${replayState.index + 1}/${fullCandles.length})`;
    if (playBtn) playBtn.innerText = replayState.playing ? "❚❚" : "▶";
  }

  window.onReplaySliderInput = function (val) {
    const idx = parseInt(val, 10);
    if (isNaN(idx) || fullCandles.length < 35) return;
    replayState.active = true;
    replayState.index = Math.max(30, Math.min(fullCandles.length - 1, idx));
    updateReplayUI();
    renderAllActiveIndicators();
  };

  window.startPickReplayCut = function () {
    replayState.pickingCut = true;
    updateToolbarStatus("CLICK VÀO CÂY NẾN BẤT KỲ TRÊN CHART ĐỂ TUA VỀ ĐÓ...");
  };

  window.stepReplayBar = function (delta) {
    if (fullCandles.length < 35) return;
    if (!replayState.active) {
      replayState.active = true;
      replayState.index = Math.max(30, fullCandles.length - 30);
    }
    replayState.index = Math.max(30, Math.min(fullCandles.length - 1, replayState.index + delta));
    updateReplayUI();
    renderAllActiveIndicators();
  };

  window.toggleReplayPlay = function () {
    if (fullCandles.length < 35) return;
    if (!replayState.active) {
      replayState.active = true;
      replayState.index = Math.max(30, fullCandles.length - 120);
    }
    replayState.playing = !replayState.playing;
    if (replayState.playing) {
      replayState.timer = setInterval(() => {
        if (replayState.index < fullCandles.length - 1) {
          replayState.index += 1;
          updateReplayUI();
          renderAllActiveIndicators();
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

  window.cycleReplaySpeed = function () {
    const speeds = [500, 200, 60];
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
    updateReplayUI();
    renderAllActiveIndicators();
    updateToolbarStatus("ĐÃ QUAY LẠI THỜI GIAN THỰC");
  };

  window.switchStudioTimeframe = function (tf) {
    activeTf = tf;
    document.querySelectorAll(".nx-tf-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tf === tf);
    });
    if (mtfCache.data && mtfCache.data[tf] && mtfCache.data[tf].length > 30) {
      fullCandles = mtfCache.data[tf];
      if (replayState.active) {
        replayState.index = Math.min(fullCandles.length - 1, replayState.index);
      }
      updateReplayUI();
      renderAllActiveIndicators();
    }
  };

  // =========================================================================
  // 8. DỰNG GIAO DIỆN TOOLBAR + CỬA SỔ CALL LỆNH + CÁC MODAL CẤU HÌNH
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
        flex-direction: column;
        gap: 4px;
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 10px;
        color: #e2e8f0;
      }
      .nx-dock-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        background: rgba(7, 11, 19, 0.94);
        border: 1px solid rgba(255, 153, 0, 0.35);
        padding: 4px 8px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.75);
      }
      .nx-tool-btn, .nx-tf-btn {
        background: #0f172a;
        color: #cbd5e1;
        border: 1px solid rgba(148,163,184,0.28);
        padding: 3px 6px;
        font-family: inherit;
        font-size: 9.5px;
        cursor: pointer;
        font-weight: 700;
      }
      .nx-tool-btn:hover, .nx-tf-btn:hover { border-color: #ff9900; color: #fff; }
      .nx-tool-btn.active, .nx-tf-btn.active { background: #ff9900; color: #000; border-color: #ff9900; }
      .nx-sep { width: 1px; height: 15px; background: rgba(148,163,184,0.25); margin: 0 2px; }
      #nx-call-window {
        position: fixed;
        top: 108px;
        right: 365px;
        z-index: 99992;
        width: 255px;
        background: rgba(7, 11, 19, 0.94);
        border: 1px solid rgba(56, 189, 248, 0.45);
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 10px;
        color: #f8fafc;
        box-shadow: 0 12px 32px rgba(0,0,0,0.8);
      }
      #nx-call-window-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #0f172a;
        border-bottom: 1px solid rgba(56, 189, 248, 0.3);
        padding: 5px 8px;
        cursor: move;
      }
      #nx-call-window-body { padding: 7px; }
      #nx-call-window-body td { padding: 3px 6px; border: 1px solid rgba(148,163,184,0.18); font-variant-numeric: tabular-nums; }
      .nx-modal-backdrop {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 100005;
        background: rgba(2, 6, 14, 0.82);
        backdrop-filter: blur(5px);
        align-items: center;
        justify-content: center;
        font-family: 'JetBrains Mono', 'Consolas', monospace;
      }
      .nx-modal-card {
        width: 660px;
        max-width: 95vw;
        max-height: 88vh;
        overflow-y: auto;
        background: #090e1a;
        border: 1px solid #ff9900;
        padding: 16px 20px;
        color: #e2e8f0;
      }
      .nx-form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 12px 0; }
      .nx-field label { display: block; font-size: 9.5px; color: #94a3b8; margin-bottom: 3px; }
      .nx-field input, .nx-field select, .nx-modal-card textarea {
        width: 100%; background: #04070d; border: 1px solid rgba(56,189,248,0.4); color: #fff;
        font-family: inherit; font-size: 11px; padding: 5px 7px; box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);

    const dock = document.createElement("div");
    dock.id = "nx-studio-dock";
    dock.innerHTML = `
      <div class="nx-dock-row">
        <span style="color:#ff9900; font-weight:800;">TF:</span>
        <button class="nx-tf-btn" data-tf="M1" onclick="switchStudioTimeframe('M1')">M1</button>
        <button class="nx-tf-btn active" data-tf="M5" onclick="switchStudioTimeframe('M5')">M5</button>
        <button class="nx-tf-btn" data-tf="M15" onclick="switchStudioTimeframe('M15')">M15</button>
        <button class="nx-tf-btn" data-tf="M30" onclick="switchStudioTimeframe('M30')">M30</button>
        <button class="nx-tf-btn" data-tf="H1" onclick="switchStudioTimeframe('H1')">H1</button>
        <button class="nx-tf-btn" data-tf="H4" onclick="switchStudioTimeframe('H4')">H4</button>
        <div class="nx-sep"></div>
        <span style="color:#ff9900; font-weight:800;">DRAW:</span>
        <button class="nx-tool-btn active" data-tool="CURSOR" onclick="setDrawTool('CURSOR')">↖</button>
        <button class="nx-tool-btn" data-tool="TRENDLINE" onclick="setDrawTool('TRENDLINE')">LINE</button>
        <button class="nx-tool-btn" data-tool="HLINE" onclick="setDrawTool('HLINE')">H-LINE</button>
        <button class="nx-tool-btn" data-tool="LONG_BOX" onclick="setDrawTool('LONG_BOX')" style="color:#10b981;">LONG</button>
        <button class="nx-tool-btn" data-tool="SHORT_BOX" onclick="setDrawTool('SHORT_BOX')" style="color:#ef4444;">SHORT</button>
        <button class="nx-tool-btn" onclick="clearAllUserDrawings()">CLR</button>
        <div class="nx-sep"></div>
        <span style="color:#38bdf8; font-weight:800;">REPLAY:</span>
        <button class="nx-tool-btn" onclick="startPickReplayCut()" title="Click lên nến để cắt lùi thời gian">✂ CUT</button>
        <button class="nx-tool-btn" onclick="stepReplayBar(-10)" title="Tua lùi 10 nến">⏪-10</button>
        <button class="nx-tool-btn" onclick="stepReplayBar(-1)" title="Lùi 1 nến">|&lt;</button>
        <button class="nx-tool-btn" id="nx-replay-play" onclick="toggleReplayPlay()">▶</button>
        <button class="nx-tool-btn" onclick="stepReplayBar(1)" title="Tiến 1 nến">&gt;|</button>
        <button class="nx-tool-btn" onclick="stepReplayBar(10)" title="Tua tới 10 nến">+10⏩</button>
        <button class="nx-tool-btn" id="nx-replay-speed" onclick="cycleReplaySpeed()">1X</button>
        <input id="nx-replay-slider" type="range" min="30" max="1499" value="1499" oninput="onReplaySliderInput(this.value)" style="width:95px; accent-color:#38bdf8; cursor:pointer;" title="Kéo thanh trượt để tua ngược/xuôi thời gian backtest" />
        <button class="nx-tool-btn" onclick="exitReplayMode()" style="color:#fbbf24;">EXIT</button>
        <span id="nx-replay-status" style="color:#10b981; font-weight:700;">LIVE</span>
        <span id="nx-studio-msg" style="color:#94a3b8; margin-left:4px;"></span>
      </div>
      <div class="nx-dock-row" id="nx-ind-pills-bar" style="border-color:rgba(56,189,248,0.3);"></div>
    `;
    document.body.appendChild(dock);

    // Cửa sổ Ô Call Lệnh & Thống Kê MTF (Bật/Tắt được)
    const callWin = document.createElement("div");
    callWin.id = "nx-call-window";
    callWin.innerHTML = `
      <div id="nx-call-window-header">
        <b style="color:#38bdf8; font-size:10px;">📡 ENGULF V14 CALL LỆNH & MTF</b>
        <button onclick="toggleBuiltinIndicator('call_window')" title="Tắt cửa sổ báo lệnh này (bấm nút 'Ô Call Lệnh' trên thanh trên để bật lại)" style="background:none; border:1px solid rgba(239,68,68,0.5); color:#ef4444; font-family:inherit; font-size:9px; padding:1px 5px; cursor:pointer; font-weight:800;">
          TẮT [✕]
        </button>
      </div>
      <div id="nx-call-window-body">Đang tải dữ liệu 1.500 nến MT5...</div>
    `;
    document.body.appendChild(callWin);

    // Kéo thả di chuyển tự do cửa sổ Call Lệnh trên màn hình
    let isDragging = false, dragOffX = 0, dragOffY = 0;
    const hdr = document.getElementById("nx-call-window-header");
    hdr.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      isDragging = true;
      const rect = callWin.getBoundingClientRect();
      dragOffX = e.clientX - rect.left;
      dragOffY = e.clientY - rect.top;
    });
    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      callWin.style.left = Math.max(0, e.clientX - dragOffX) + "px";
      callWin.style.top = Math.max(0, e.clientY - dragOffY) + "px";
      callWin.style.right = "auto";
    });
    window.addEventListener("mouseup", () => { isDragging = false; });

    // Modal Cài đặt V14
    const v14Modal = document.createElement("div");
    v14Modal.id = "nx-v14-modal";
    v14Modal.className = "nx-modal-backdrop";
    v14Modal.innerHTML = `
      <div class="nx-modal-card">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,153,0,0.3); padding-bottom:8px;">
          <b style="color:#ff9900; font-size:12px;">CÀI ĐẶT: ENGULF SIGNAL V14 MTF FILTER</b>
          <button class="nx-tool-btn" onclick="document.getElementById('nx-v14-modal').style.display='none'">ĐÓNG [X]</button>
        </div>
        <div class="nx-form-grid">
          <div class="nx-field"><label>Cây thứ N sau cây gốc (minBarsIn)</label><input id="cfg-minBarsIn" type="number" min="2" /></div>
          <div class="nx-field"><label>Dung sai nhấn chìm (tol)</label><input id="cfg-tol" type="number" step="0.05" /></div>
          <div class="nx-field"><label>Cách tính nằm trong cây gốc</label>
            <select id="cfg-containMode"><option value="Thân nến">Thân nến</option><option value="Râu nến">Râu nến</option></select>
          </div>
          <div class="nx-field"><label>Bộ lọc xu hướng khung lớn</label>
            <select id="cfg-filterMode">
              <option value="FLT_OFF">Tắt - báo tất cả BUY & SELL</option>
              <option value="FLT_NOCTR">Bỏ nghịch xu hướng (tím)</option>
              <option value="FLT_STRONG">Thuận mạnh (≥1 xong hoặc ≥2 cùng chiều)</option>
              <option value="FLT_DONE">≥1 khung lớn đã có tín hiệu</option>
              <option value="FLT_TWO">≥2 khung lớn cùng chiều</option>
            </select>
          </div>
          <div class="nx-field"><label>RR Phiên Á / Âu / Mỹ</label>
            <div style="display:flex; gap:4px;">
              <input id="cfg-rrAsia" type="number" step="0.1" />
              <input id="cfg-rrEu" type="number" step="0.1" />
              <input id="cfg-rrUs" type="number" step="0.1" />
            </div>
          </div>
          <div class="nx-field"><label>Khoảng thống kê Backtest</label>
            <select id="cfg-statPer">
              <option value="Toàn bộ dữ liệu">Toàn bộ dữ liệu (1.500 nến)</option>
              <option value="Tuần này">Tuần này</option>
              <option value="Tháng này">Tháng này</option>
            </select>
          </div>
          <div class="nx-field"><label>Hiện tín hiệu bị lọc (chấm xám)</label>
            <select id="cfg-showFilt"><option value="false">Tắt</option><option value="true">Bật</option></select>
          </div>
          <div class="nx-field"><label>Vẽ vùng cây gốc (2 đường ngang)</label>
            <select id="cfg-showBox"><option value="true">Bật</option><option value="false">Tắt</option></select>
          </div>
          <div class="nx-field"><label>Vẽ đường SL / TP</label>
            <select id="cfg-showSLTP"><option value="true">Bật</option><option value="false">Tắt</option></select>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button class="nx-tool-btn" onclick="saveV14Settings()" style="background:#10b981; color:#000; border-color:#10b981; padding:6px 14px;">ÁP DỤNG & BACKTEST LẠI</button>
        </div>
      </div>
    `;
    document.body.appendChild(v14Modal);

    // Modal Tự tạo / sửa Custom Indicator
    const creatorModal = document.createElement("div");
    creatorModal.id = "nx-creator-modal";
    creatorModal.className = "nx-modal-backdrop";
    creatorModal.innerHTML = `
      <div class="nx-modal-card">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(56,189,248,0.35); padding-bottom:8px;">
          <b style="color:#38bdf8; font-size:12px;">TỰ TẠO / CHỈNH SỬA CUSTOM INDICATOR ĐỘC LẬP</b>
          <button class="nx-tool-btn" onclick="document.getElementById('nx-creator-modal').style.display='none'">ĐÓNG [X]</button>
        </div>
        <input id="custom-edit-id" type="hidden" />
        <div class="nx-field" style="margin:10px 0;">
          <label>Tên Indicator hiển thị trên thanh bật/tắt</label>
          <input id="custom-edit-name" type="text" />
        </div>
        <div class="nx-field">
          <label>Mã nguồn Indicator (Nhận mảng candles, trả về { lines: [...], markers: [...] })</label>
          <textarea id="custom-edit-code" rows="12"></textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
          <button class="nx-tool-btn" onclick="saveCustomIndicatorItem()" style="background:#38bdf8; color:#000; border-color:#38bdf8; padding:6px 14px;">LƯU & BẬT LÊN BIỂU ĐỒ</button>
        </div>
      </div>
    `;
    document.body.appendChild(creatorModal);

    renderIndicatorLegendPills();
  }

  window.openV14SettingsModal = function () {
    document.getElementById("cfg-minBarsIn").value = v14Config.minBarsIn;
    document.getElementById("cfg-tol").value = v14Config.tol;
    document.getElementById("cfg-containMode").value = v14Config.containMode;
    document.getElementById("cfg-filterMode").value = v14Config.filterMode;
    document.getElementById("cfg-rrAsia").value = v14Config.rrAsia;
    document.getElementById("cfg-rrEu").value = v14Config.rrEu;
    document.getElementById("cfg-rrUs").value = v14Config.rrUs;
    document.getElementById("cfg-statPer").value = v14Config.statPer;
    document.getElementById("cfg-showFilt").value = String(v14Config.showFilt);
    document.getElementById("cfg-showBox").value = String(v14Config.showBox);
    document.getElementById("cfg-showSLTP").value = String(v14Config.showSLTP);
    document.getElementById("nx-v14-modal").style.display = "flex";
  };

  window.saveV14Settings = function () {
    v14Config.minBarsIn = parseInt(document.getElementById("cfg-minBarsIn").value, 10) || 4;
    v14Config.tol = parseFloat(document.getElementById("cfg-tol").value) || 0.2;
    v14Config.containMode = document.getElementById("cfg-containMode").value;
    v14Config.filterMode = document.getElementById("cfg-filterMode").value;
    v14Config.rrAsia = parseFloat(document.getElementById("cfg-rrAsia").value) || 1.0;
    v14Config.rrEu = parseFloat(document.getElementById("cfg-rrEu").value) || 1.0;
    v14Config.rrUs = parseFloat(document.getElementById("cfg-rrUs").value) || 2.0;
    v14Config.statPer = document.getElementById("cfg-statPer").value;
    v14Config.showFilt = document.getElementById("cfg-showFilt").value === "true";
    v14Config.showBox = document.getElementById("cfg-showBox").value === "true";
    v14Config.showSLTP = document.getElementById("cfg-showSLTP").value === "true";
    indicatorStates.engulf_v14 = true;
    document.getElementById("nx-v14-modal").style.display = "none";
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  window.openCustomCreatorModal = function (id) {
    const existing = id ? customIndicators.find(x => x.id === id) : null;
    document.getElementById("custom-edit-id").value = existing ? existing.id : "";
    document.getElementById("custom-edit-name").value = existing ? existing.name : "Custom Indicator #" + (customIndicators.length + 1);
    document.getElementById("custom-edit-code").value = existing ? existing.code : IndLib.defaultCustomTemplate;
    document.getElementById("nx-creator-modal").style.display = "flex";
  };

  window.saveCustomIndicatorItem = function () {
    const editId = document.getElementById("custom-edit-id").value;
    const name = document.getElementById("custom-edit-name").value.trim() || "Custom Indicator";
    const code = document.getElementById("custom-edit-code").value;

    if (editId) {
      const item = customIndicators.find(x => x.id === editId);
      if (item) { item.name = name; item.code = code; item.enabled = true; }
    } else {
      customIndicators.push({ id: "custom_" + Date.now(), name, enabled: true, code });
    }

    document.getElementById("nx-creator-modal").style.display = "none";
    persistAllIndicatorSettings();
    renderAllActiveIndicators();
  };

  // =========================================================================
  // 9. ĐỒNG BỘ DỮ LIỆU ĐA KHUNG 1500 NẾN & KHỞI CHẠY
  // =========================================================================
  async function syncMultiTimeframeData() {
    if (replayState.active) return; // Đang Replay thì không tự đồng bộ làm nhảy chart
    try {
      const res = await fetch("/api/mt5/multi_tf?count=1500");
      const json = await res.json();
      if (json.status === "OK" && json.data) {
        mtfCache = json;
        if (json.data[activeTf] && json.data[activeTf].length > 30) {
          fullCandles = json.data[activeTf];
          updateReplayUI();
          renderAllActiveIndicators();
        }
      }
    } catch (e) {}
  }

  async function loadSavedIndicators() {
    try {
      const res = await fetch("/api/indicators/custom");
      const saved = await res.json();
      if (saved && saved.states) Object.assign(indicatorStates, saved.states);
      if (saved && saved.st_params) Object.assign(stParams, saved.st_params);
      if (saved && saved.v14_config && Object.keys(saved.v14_config).length > 0) {
        Object.assign(v14Config, saved.v14_config);
      }
      if (saved && Array.isArray(saved.custom_list) && saved.custom_list.length > 0) {
        customIndicators = saved.custom_list;
      }
    } catch (e) {}
  }

  injectStudioUI();
  loadSavedIndicators().then(() => {
    renderIndicatorLegendPills();
    syncMultiTimeframeData();
    setInterval(syncMultiTimeframeData, 4000);
  });
})();
