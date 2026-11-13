import os
import numpy as np
import MetaTrader5 as mt5

def frac_diff(series, d=0.40, thresh=1e-3):
    weights = [1.0]
    k = 1
    while True:
        w = -weights[-1] * (d - k + 1) / k
        if abs(w) < thresh or k > 40:
            break
        weights.append(w)
        k += 1
    weights = np.array(weights[::-1])
    width = len(weights)
    out = np.zeros_like(series, dtype=np.float64)
    for i in range(width - 1, len(series)):
        out[i] = np.dot(weights, series[i - width + 1 : i + 1])
    out[:width - 1] = out[width - 1]
    return out

def rolling_zscore(arr, win=48):
    out = np.zeros_like(arr, dtype=np.float64)
    for i in range(win, len(arr)):
        seg = arr[i - win : i + 1]
        out[i] = (arr[i] - np.mean(seg)) / (np.std(seg) + 1e-9)
    return out

def build_dataset(target_bars=35000, seq_len=48, horizon=8):
    if not mt5.initialize():
        raise RuntimeError("Khong ket noi duoc MT5. Hay mo phan mem MT5 truoc!")

    symbol = None
    for cand in ["XAUUSD", "XAUUSDm", "GOLD", "BTCUSD", "BTCUSDm", "EURUSD", "EURUSDm"]:
        mt5.symbol_select(cand, True)
        r = mt5.copy_rates_from_pos(cand, mt5.TIMEFRAME_M15, 0, target_bars)
        if r is not None and len(r) >= 4000:
            symbol = cand
            rates = r
            break

    if symbol is None:
        for s in (mt5.symbols_get() or []):
            if s.visible:
                mt5.symbol_select(s.name, True)
                r = mt5.copy_rates_from_pos(s.name, mt5.TIMEFRAME_M15, 0, target_bars)
                if r is not None and len(r) >= 4000:
                    symbol = s.name
                    rates = r
                    break

    if symbol is None:
        raise RuntimeError("Khong lay duoc du 4,000 nen M15 lich su tu MT5!")

    print(f"[1/4] Da tai {len(rates)} nen M15 that cua ma {symbol}...")

    o = np.array([x['open'] for x in rates], dtype=np.float64)
    h = np.array([x['high'] for x in rates], dtype=np.float64)
    l = np.array([x['low'] for x in rates], dtype=np.float64)
    c = np.array([x['close'] for x in rates], dtype=np.float64)
    v = np.array([x['tick_volume'] for x in rates], dtype=np.float64)
    t = np.array([x['time'] for x in rates], dtype=np.int64)

    fd_z = np.clip(rolling_zscore(frac_diff(np.log(c + 1e-9), d=0.40), 60), -5, 5)
    ret_1 = np.clip(rolling_zscore(np.diff(np.log(c + 1e-9), prepend=np.log(c[0])), 48), -5, 5)
    ret_4 = np.clip(rolling_zscore(np.log((c + 1e-9) / (np.roll(c, 4) + 1e-9)), 48), -5, 5)
    ret_12 = np.clip(rolling_zscore(np.log((c + 1e-9) / (np.roll(c, 12) + 1e-9)), 48), -5, 5)

    gk_var = 0.5 * (np.log((h + 1e-9) / (l + 1e-9)) ** 2) - (2 * np.log(2) - 1) * (np.log((c + 1e-9) / (o + 1e-9)) ** 2)
    gk_z = np.clip(rolling_zscore(np.sqrt(np.maximum(gk_var, 1e-12)), 48), -5, 5)

    rng = (h - l) + 1e-9
    clv = ((c - l) / rng) * 2.0 - 1.0
    vol_z = np.clip(rolling_zscore(np.log(v + 1.0), 48), -5, 5)
    signed_vol_z = np.clip(rolling_zscore(clv * v, 48), -5, 5)

    upper_wick = (h - np.maximum(o, c)) / rng
    lower_wick = (np.minimum(o, c) - l) / rng

    hours = np.array([(ts % 86400) / 3600.0 for ts in t])
    sin_hour = np.sin(2 * np.pi * hours / 24.0)
    cos_hour = np.cos(2 * np.pi * hours / 24.0)

    feat_matrix = np.column_stack([
        fd_z, ret_1, ret_4, ret_12,
        gk_z, clv, vol_z, signed_vol_z,
        upper_wick, lower_wick, sin_hour, cos_hour
    ]).astype(np.float32)

    tr = np.maximum(h - l, np.maximum(np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))))
    atr = np.convolve(tr, np.ones(14) / 14.0, mode='same')

    print("[2/4] Dang gan nhan Triple-Barrier khung M15 & tinh trong so doc lap mau...")
    X_seqs, Y_labels, Y_returns, touch_times = [], [], [], []

    for i in range(80, len(c) - horizon - 1):
        cur_atr = atr[i]
        if cur_atr <= 0:
            continue
        entry = c[i]
        tp_level = entry + 1.8 * cur_atr
        sl_level = entry - 1.0 * cur_atr

        label = None
        touch_idx = i + horizon
        realized_r = 0.0

        for k in range(1, horizon + 1):
            if h[i + k] >= tp_level and l[i + k] <= sl_level:
                label = 0.0
                touch_idx = i + k
                realized_r = -1.0
                break
            elif h[i + k] >= tp_level:
                label = 1.0
                touch_idx = i + k
                realized_r = 1.8
                break
            elif l[i + k] <= sl_level:
                label = 0.0
                touch_idx = i + k
                realized_r = -1.0
                break

        if label is None:
            diff_r = (c[i + horizon] - entry) / cur_atr
            label = 1.0 if diff_r > 0.30 else 0.0
            realized_r = float(np.clip(diff_r, -1.0, 1.8))

        X_seqs.append(feat_matrix[i - seq_len + 1 : i + 1])
        Y_labels.append(label)
        Y_returns.append(realized_r)
        touch_times.append((i, touch_idx))

    X_seqs = np.array(X_seqs, dtype=np.float32)
    Y_labels = np.array(Y_labels, dtype=np.float32)
    Y_returns = np.array(Y_returns, dtype=np.float32)

    concurrency = np.zeros(len(c), dtype=np.float32)
    for s_i, e_i in touch_times:
        concurrency[s_i : e_i + 1] += 1.0

    sample_weights = np.zeros(len(touch_times), dtype=np.float32)
    for idx, (s_i, e_i) in enumerate(touch_times):
        avg_conc = np.mean(concurrency[s_i : e_i + 1])
        sample_weights[idx] = (1.0 / max(1.0, avg_conc)) * (0.5 + min(1.5, abs(Y_returns[idx])))

    sample_weights = sample_weights / np.mean(sample_weights)

    out_path = os.path.join("data", "nexus_m15_dataset.npz")
    np.savez_compressed(
        out_path,
        X=X_seqs, y=Y_labels, returns=Y_returns, weights=sample_weights,
        symbol=symbol, seq_len=seq_len
    )
    print(f"[3/4] HOAN TAT! Da luu {len(X_seqs)} mau M15 that tai: {os.path.abspath(out_path)}")
    print(f"[4/4] Ty le nhan BUY (1.0): {np.mean(Y_labels)*100:.2f}% | Dung luong: {os.path.getsize(out_path)/(1024*1024):.2f} MB")
    mt5.shutdown()

if __name__ == "__main__":
    build_dataset()
