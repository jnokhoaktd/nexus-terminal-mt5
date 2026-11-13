import math
import numpy as np

def run_vector_backtest(candles: list, fast_len: int = 9, slow_len: int = 21):
    """
    Backtest nhanh chiến lược EMA Crossover trên dữ liệu nến thật từ MT5
    """
    if not candles or len(candles) < slow_len + 5:
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

    position = 0 # 1: Long, -1: Short
    entry_price = 0.0
    trades = []
    equity = 10000.0
    equity_curve = [{"time": times[0], "value": equity}]
    peak = equity
    max_dd = 0.0

    for i in range(slow_len, len(closes)):
        price = closes[i]
        # Tín hiệu Long
        if fast_ema[i - 1] <= slow_ema[i - 1] and fast_ema[i] > slow_ema[i]:
            if position == -1:
                pnl = (entry_price - price) / entry_price * 10000.0
                trades.append(pnl)
                equity += pnl
            position = 1
            entry_price = price
        # Tín hiệu Short
        elif fast_ema[i - 1] >= slow_ema[i - 1] and fast_ema[i] < slow_ema[i]:
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
