import math
import numpy as np

def kalman_filter_1d(prices: np.ndarray, process_var: float = 1e-4, measure_var: float = 1e-2):
    """
    Bộ lọc Kalman 1D ước lượng trạng thái giá trị thực ẩn (Latent Fair Value)
    và độ lệch chuẩn Innovation (Kalman Residual Z-Score).
    """
    n = len(prices)
    x_est = np.zeros(n)
    p_est = np.zeros(n)
    x_est[0] = prices[0]
    p_est[0] = 1.0

    for k in range(1, n):
        # Predict
        x_pred = x_est[k - 1]
        p_pred = p_est[k - 1] + process_var
        # Update
        kalman_gain = p_pred / (p_pred + measure_var)
        x_est[k] = x_pred + kalman_gain * (prices[k] - x_pred)
        p_est[k] = (1.0 - kalman_gain) * p_pred

    residuals = prices - x_est
    res_std = np.std(residuals[-20:]) if len(residuals) >= 20 else np.std(residuals)
    kalman_z = residuals[-1] / res_std if res_std > 0 else 0.0
    return x_est, float(kalman_z)

def garch_1_1_volatility(prices: np.ndarray):
    """
    Mô hình GARCH(1,1) ước lượng độ biến động có điều kiện (Conditional Volatility)
    và phát hiện chế độ thị trường (Low Vol Compression vs High Vol Expansion).
    """
    if len(prices) < 10:
        return np.ones(len(prices)), 1.0
    returns = np.diff(np.log(prices + 1e-9)) * 100.0
    omega, alpha, beta = 0.05, 0.15, 0.80
    var_t = np.zeros(len(returns))
    var_t[0] = np.var(returns) if np.var(returns) > 0 else 0.1

    for t in range(1, len(returns)):
        var_t[t] = omega + alpha * (returns[t - 1] ** 2) + beta * var_t[t - 1]

    vol_series = np.sqrt(var_t)
    vol_ratio = vol_series[-1] / (np.mean(vol_series) + 1e-9)
    return vol_series, float(vol_ratio)

def compute_alpha_signal(candles: list, cvd: float = 0.0):
    """
    Multi-Task Quant Research Engine:
    Task 1: Kalman Filter State Estimation (Độ lệch khỏi Fair Value)
    Task 2: GARCH(1,1) Volatility Regime Filter
    Task 3: EMA Momentum & Z-Score Mean Reversion
    Task 4: Orderflow CVD Imbalance
    """
    if not candles or len(candles) < 30:
        return {"signal": "HOLD", "confidence": 0.0, "z_score": 0.0, "kalman_z": 0.0, "garch_ratio": 1.0, "reason": "Insufficient data"}

    closes = np.array([c["close"] for c in candles], dtype=float)

    # Task 1: Kalman Filter
    k_est, kalman_z = kalman_filter_1d(closes)

    # Task 2: GARCH(1,1)
    _, garch_ratio = garch_1_1_volatility(closes)

    # Task 3: Rolling Z-Score & EMA
    window = closes[-20:]
    std = np.std(window)
    z_score = (closes[-1] - np.mean(window)) / std if std > 0 else 0.0

    def ema(arr, period):
        alpha = 2 / (period + 1)
        out = np.zeros_like(arr)
        out[0] = arr[0]
        for i in range(1, len(arr)):
            out[i] = alpha * arr[i] + (1 - alpha) * out[i - 1]
        return out

    f_ema = ema(closes, 9)
    s_ema = ema(closes, 21)

    score = 0.0
    reasons = []

    if f_ema[-1] > s_ema[-1]:
        score += 25
        reasons.append("EMA9>21")
    elif f_ema[-1] < s_ema[-1]:
        score -= 25
        reasons.append("EMA9<21")

    if kalman_z < -1.2 or z_score < -1.4:
        score += 35
        reasons.append(f"KalmanOversold(KZ={kalman_z:.2f})")
    elif kalman_z > 1.2 or z_score > 1.4:
        score -= 35
        reasons.append(f"KalmanOverbought(KZ={kalman_z:.2f})")

    if cvd > 0:
        score += 25
        reasons.append("CVD+")
    elif cvd < 0:
        score -= 25
        reasons.append("CVD-")

    # GARCH Regime Boost: Biến động mở rộng có kiểm soát
    if 0.8 <= garch_ratio <= 1.8:
        score *= 1.15
        reasons.append(f"GARCH_OK({garch_ratio:.2f})")

    confidence = min(99.0, abs(score))
    if score >= 60:
        return {
            "signal": "BUY", "confidence": round(confidence, 1),
            "z_score": round(z_score, 2), "kalman_z": round(kalman_z, 2),
            "garch_ratio": round(garch_ratio, 2), "reason": " + ".join(reasons)
        }
    elif score <= -60:
        return {
            "signal": "SELL", "confidence": round(confidence, 1),
            "z_score": round(z_score, 2), "kalman_z": round(kalman_z, 2),
            "garch_ratio": round(garch_ratio, 2), "reason": " + ".join(reasons)
        }

    return {
        "signal": "HOLD", "confidence": round(confidence, 1),
        "z_score": round(z_score, 2), "kalman_z": round(kalman_z, 2),
        "garch_ratio": round(garch_ratio, 2), "reason": "Scanning (" + ", ".join(reasons) + ")"
    }

def run_vector_backtest(candles: list, fast_len: int = 9, slow_len: int = 21, z_thresh: float = 1.5):
    if not candles or len(candles) < slow_len + 20:
        return {"error": "Không đủ dữ liệu nến để backtest"}

    closes = np.array([c["close"] for c in candles], dtype=float)
    times = [c["time"] for c in candles]
    k_est, _ = kalman_filter_1d(closes)

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
        k_diff = price - k_est[i]

        buy_cond = (fast_ema[i] > slow_ema[i] and k_diff < 0) or (z < -z_thresh)
        sell_cond = (fast_ema[i] < slow_ema[i] and k_diff > 0) or (z > z_thresh)

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
