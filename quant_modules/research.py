import math
import numpy as np

def compute_alpha_signal(candles: list, cvd: float = 0.0):
    """
    Quant Research Engine: Tổng hợp đa nhân tố (Multi-Factor Alpha Model)
    - Factor 1: Z-Score Mean Reversion (Độ lệch chuẩn giá so với trung bình 20 phiên)
    - Factor 2: EMA Trend Momentum (EMA 9 vs EMA 21)
    - Factor 3: Orderflow Delta Confirmation (CVD dương/âm)
    """
    if not candles or len(candles) < 30:
        return {"signal": "HOLD", "confidence": 0.0, "z_score": 0.0, "reason": "Insufficient data"}

    closes = np.array([c["close"] for c in candles], dtype=float)
    
    # Z-Score (20 periods)
    window = closes[-20:]
    mean = np.mean(window)
    std = np.std(window)
    z_score = (closes[-1] - mean) / std if std > 0 else 0.0

    # EMA 9 & 21
    def ema(arr, period):
        alpha = 2 / (period + 1)
        out = np.zeros_like(arr)
        out[0] = arr[0]
        for i in range(1, len(arr)):
            out[i] = alpha * arr[i] + (1 - alpha) * out[i - 1]
        return out

    f_ema = ema(closes, 9)
    s_ema = ema(closes, 21)
    trend_bull = f_ema[-1] > s_ema[-1]
    trend_bear = f_ema[-1] < s_ema[-1]

    # Chấm điểm Alpha (-100 đến +100)
    score = 0.0
    reasons = []

    if trend_bull:
        score += 35
        reasons.append("EMA9>21")
    elif trend_bear:
        score -= 35
        reasons.append("EMA9<21")

    # Mean reversion pullbacks trong xu hướng hoặc quá mua/quá bán cực đại
    if z_score < -1.5:
        score += 40
        reasons.append(f"Oversold(Z={z_score:.2f})")
    elif z_score > 1.5:
        score -= 40
        reasons.append(f"Overbought(Z={z_score:.2f})")

    # Xác nhận dòng lệnh Orderflow CVD
    if cvd > 0:
        score += 25
        reasons.append("CVD+")
    elif cvd < 0:
        score -= 25
        reasons.append("CVD-")

    confidence = min(99.0, abs(score))
    if score >= 60:
        return {"signal": "BUY", "confidence": round(confidence, 1), "z_score": round(z_score, 2), "reason": " + ".join(reasons)}
    elif score <= -60:
        return {"signal": "SELL", "confidence": round(confidence, 1), "z_score": round(z_score, 2), "reason": " + ".join(reasons)}
    
    return {"signal": "HOLD", "confidence": round(confidence, 1), "z_score": round(z_score, 2), "reason": "No Edge (" + ", ".join(reasons) + ")"}

def run_vector_backtest(candles: list, fast_len: int = 9, slow_len: int = 21, z_thresh: float = 1.5):
    """
    Backtest mô hình Hybrid Quant (EMA Trend + Z-Score Mean Reversion)
    """
    if not candles or len(candles) < slow_len + 20:
        return {"error": "Không đủ dữ liệu nến để backtest"}

    closes = np.array([c["close"] for c in candles], dtype=float)
    times = [c["time"] for c in candles]

    def ema(arr, period):
        alpha = 2 / (period + 1)
        out = np.zeros_like(arr)
        out[0] = arr[0]
        for i in range(1, len(arr)):
            out[i] = alpha * arr[i] + (1 - alpha) * out[i - 1]
        return out

    fast_ema = ema(closes, fast_len)
    slow_ema = ema(closes, slow_len)

    position = 0
    entry_price = 0.0
    trades = []
    equity = 10000.0
    equity_curve = [{"time": times[0], "value": equity}]
    peak = equity
    max_dd = 0.0

    for i in range(max(slow_len, 20), len(closes)):
        price = closes[i]
        win = closes[i-20:i]
        std = np.std(win)
        z = (price - np.mean(win)) / std if std > 0 else 0.0

        buy_cond = (fast_ema[i] > slow_ema[i] and z < -0.5) or (z < -z_thresh)
        sell_cond = (fast_ema[i] < slow_ema[i] and z > 0.5) or (z > z_thresh)

        if buy_cond and position != 1:
            if position == -1:
                pnl = (entry_price - price) / entry_price * 10000.0
                trades.append(pnl)
                equity += pnl
            position = 1
            entry_price = price
        elif sell_cond and position != -1:
            if position == 1:
                pnl = (price - entry_price) / entry_price * 10000.0
                trades.append(pnl)
                equity += pnl
            position = -1
            entry_price = price

        peak = max(peak, equity)
        dd = (peak - equity) / peak * 100.0 if peak > 0 else 0.0
        max_dd = max(max_dd, dd)
        equity_curve.append({"time": times[i], "value": round(equity, 2)})

    wins = [t for t in trades if t > 0]
    losses = [t for t in trades if t <= 0]
    win_rate = (len(wins) / len(trades) * 100.0) if trades else 0.0
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (99.9 if gross_profit > 0 else 0.0)
    sharpe = (np.mean(trades) / np.std(trades) * math.sqrt(len(trades))) if len(trades) > 1 and np.std(trades) > 0 else 0.0

    return {
        "total_trades": len(trades),
        "win_rate": round(win_rate, 1),
        "profit_factor": round(profit_factor, 2),
        "max_drawdown": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
        "net_profit": round(equity - 10000.0, 2),
        "equity_curve": equity_curve
    }
