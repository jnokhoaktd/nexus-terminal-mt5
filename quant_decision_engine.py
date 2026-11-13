import numpy as np
import csv
import io
from datetime import datetime

class StrictScientificQuantEngine:
    def __init__(self, frac_d=0.40, conformal_alpha=0.10):
        self.frac_d = frac_d
        self.conformal_alpha = conformal_alpha
        self.primary_weights = np.zeros((7, 1))
        self.primary_bias = 0.0
        self.meta_weights = np.zeros((5, 1))
        self.conformal_q_sl = 1.25
        self.conformal_q_tp = 2.50
        self.trained_epochs = 0
        self.oos_win_rate = 0.0
        self.oos_brier = 0.25
        self.oos_samples = 0
        self.experiment_logs = []

    def fractional_diff_series(self, series, d=0.40, thresh=1e-3):
        weights = [1.0]
        k = 1
        while True:
            w = -weights[-1] * (d - k + 1) / k
            if abs(w) < thresh or k > 35:
                break
            weights.append(w)
            k += 1
        weights = np.array(weights[::-1])
        width = len(weights)
        arr = np.array(series, dtype=float)
        if len(arr) < width:
            return np.diff(arr, prepend=arr[0])
        out = np.zeros(len(arr))
        for i in range(width - 1, len(arr)):
            out[i] = np.dot(weights, arr[i - width + 1 : i + 1])
        out[:width - 1] = out[width - 1]
        return out

    def compute_vpin(self, closes, highs, lows, volumes, buckets=12):
        c = np.array(closes[-buckets:], dtype=float)
        h = np.array(highs[-buckets:], dtype=float)
        l = np.array(lows[-buckets:], dtype=float)
        v = np.array(volumes[-buckets:], dtype=float)
        rng = (h - l) + 1e-9
        buy_ratio = np.clip((c - l) / rng, 0.0, 1.0)
        vpin = np.sum(np.abs(v * buy_ratio - v * (1.0 - buy_ratio))) / (np.sum(v) + 1e-9)
        return float(np.clip(vpin, 0.0, 1.0))

    def compute_hawkes_branching(self, closes, beta=0.45):
        rets = np.abs(np.diff(np.log(np.array(closes[-30:], dtype=float) + 1e-9)))
        if len(rets) < 10:
            return 0.0
        thresh = np.percentile(rets, 70)
        events = (rets > thresh).astype(float)
        intensity = 0.0
        vals = []
        for ev in events:
            intensity = intensity * np.exp(-beta) + ev * 0.38
            vals.append(intensity)
        return float(np.clip(np.mean(vals[-6:]) / (beta + 0.55), 0.05, 0.98))

    def extract_features(self, closes, highs, lows, volumes, fdiff_arr):
        c = np.array(closes, dtype=float)
        fd = fdiff_arr[-1]
        fd_std = np.std(fdiff_arr[-25:]) + 1e-9
        fd_z = fd / fd_std

        ret_1 = np.log((c[-1] + 1e-9) / (c[-2] + 1e-9))
        ret_6 = np.log((c[-1] + 1e-9) / (c[-7] + 1e-9))

        ema_20 = np.mean(c[-20:])
        std_20 = np.std(c[-20:]) + 1e-9
        kalman_z = (c[-1] - ema_20) / std_20

        vpin = self.compute_vpin(closes, highs, lows, volumes, 12)
        hawkes_eta = self.compute_hawkes_branching(closes)

        rng = (np.array(highs[-10:]) - np.array(lows[-10:])) + 1e-9
        clv = ((np.array(closes[-10:]) - np.array(lows[-10:])) / rng) * 2.0 - 1.0
        cvd = float(np.sum(clv * np.array(volumes[-10:])) / (np.sum(volumes[-10:]) + 1e-9))

        feats = np.array([
            np.tanh(fd_z * 0.8),
            np.tanh(ret_1 * 450.0),
            np.tanh(ret_6 * 180.0),
            np.tanh(-kalman_z * 0.65),
            np.tanh(cvd * 2.6),
            np.tanh((vpin - 0.5) * 3.0),
            np.tanh((hawkes_eta - 0.5) * 2.5)
        ])
        return feats, fd_z, vpin, hawkes_eta, cvd, kalman_z

    def train_and_evaluate_strict(self, closes, highs, lows, volumes, epochs=250, lr=0.10):
        n = len(closes)
        if n < 80:
            return {"status": "insufficient_real_bars", "bars": n}

        fdiff_full = self.fractional_diff_series(closes, d=self.frac_d)
        X_all, Y_all, f_ups, f_dns = [], [], [], []

        # Triple-Barrier Labeling thực nghiệm
        for i in range(36, n - 8):
            feats, _, _, _, _, _ = self.extract_features(
                closes[:i+1], highs[:i+1], lows[:i+1], volumes[:i+1], fdiff_full[:i+1]
            )
            atr = np.mean([highs[j] - lows[j] for j in range(i-14, i)]) + 1e-9
            entry = closes[i]
            max_up = (np.max(highs[i+1:i+9]) - entry) / atr
            max_dn = (entry - np.min(lows[i+1:i+9])) / atr

            # Nhãn 1 nếu giá chạm +1.5 ATR trước -1.0 ATR trong 8 nến tiếp theo
            label = None
            for k in range(1, 9):
                if highs[i+k] >= entry + atr * 1.5:
                    label = 1.0
                    break
                if lows[i+k] <= entry - atr * 1.0:
                    label = 0.0
                    break
            if label is None:
                label = 1.0 if closes[i+8] > entry else 0.0

            X_all.append(feats)
            Y_all.append(label)
            f_ups.append(max_up)
            f_dns.append(max_dn)

        X_all = np.array(X_all)
        Y_all = np.array(Y_all).reshape(-1, 1)

        # Chia nghiêm ngặt theo thời gian: 70% In-Sample Train | 30% Out-of-Sample Test (không rò rỉ tương lai)
        split = int(len(X_all) * 0.70)
        X_tr, Y_tr = X_all[:split], Y_all[:split]
        X_oos, Y_oos = X_all[split:], Y_all[split:]

        np.random.seed(42)
        self.primary_weights = np.random.randn(7, 1) * 0.25
        self.primary_bias = 0.0

        for _ in range(epochs):
            logits = X_tr @ self.primary_weights + self.primary_bias
            preds = 1.0 / (1.0 + np.exp(-np.clip(logits, -15, 15)))
            self.primary_weights -= lr * ((X_tr.T @ (preds - Y_tr)) / len(X_tr) + 0.02 * self.primary_weights)
            self.primary_bias -= lr * np.mean(preds - Y_tr)

        # Đánh giá TRUNG THỰC trên tập Out-of-Sample (không kẹp sàn, không làm đẹp)
        oos_probs = 1.0 / (1.0 + np.exp(-np.clip(X_oos @ self.primary_weights + self.primary_bias, -15, 15)))
        oos_preds = (oos_probs >= 0.5).astype(float)
        self.oos_win_rate = round(float(np.mean(oos_preds == Y_oos)) * 100.0, 1)
        self.oos_brier = round(float(np.mean((oos_probs - Y_oos) ** 2)), 4)
        self.oos_samples = len(X_oos)

        # Meta-Labeling trên tập OOS
        meta_target = (oos_preds == Y_oos).astype(float)
        X_meta = np.hstack([np.abs(oos_probs - 0.5) * 2.0, X_oos[:, 4:7], np.ones((len(X_oos), 1))])
        self.meta_weights = np.zeros((5, 1))
        for _ in range(epochs):
            m_preds = 1.0 / (1.0 + np.exp(-np.clip(X_meta @ self.meta_weights, -15, 15)))
            self.meta_weights -= lr * ((X_meta.T @ (m_preds - meta_target)) / len(X_meta) + 0.02 * self.meta_weights)

        # Conformal Calibration thực nghiệm từ tập OOS
        cal_ups = np.array(f_ups[split:])
        cal_dns = np.array(f_dns[split:])
        adv_exc = np.where(oos_preds.flatten() == 1.0, cal_dns, cal_ups)
        fav_exc = np.where(oos_preds.flatten() == 1.0, cal_ups, cal_dns)

        self.conformal_q_sl = float(np.clip(np.quantile(adv_exc, 1.0 - self.conformal_alpha), 0.90, 2.20))
        self.conformal_q_tp = float(np.clip(np.quantile(fav_exc, 0.70), self.conformal_q_sl * 1.5, 4.00))
        self.trained_epochs += epochs

        return {
            "status": "trained_real_data",
            "epochs": self.trained_epochs,
            "oos_win_rate": self.oos_win_rate,
            "oos_brier": self.oos_brier,
            "oos_samples": self.oos_samples
        }

    def infer_strict(self, symbol, closes, highs, lows, volumes, last_bar_time, digits=2, colab_prob=None):
        if len(closes) < 80:
            return {"status": "INSUFFICIENT_BARS"}
        if self.trained_epochs == 0:
            self.train_and_evaluate_strict(closes, highs, lows, volumes, epochs=250)

        fdiff_arr = self.fractional_diff_series(closes, d=self.frac_d)
        feats, fd_z, vpin, hawkes_eta, cvd, kalman_z = self.extract_features(
            closes, highs, lows, volumes, fdiff_arr
        )

        # Nếu có xác suất từ Colab GPU thì ưu tiên dùng, nếu chưa thì dùng mô hình thống kê local
        if colab_prob is not None:
            prob_buy = float(colab_prob)
            model_source = "COLAB GPU (DeepQuantNet)"
        else:
            pri_logit = float((feats @ self.primary_weights)[0] + self.primary_bias)
            prob_buy = float(1.0 / (1.0 + np.exp(-np.clip(pri_logit, -15, 15))))
            model_source = "LOCAL STATS (7-FEAT)"

        # Vùng trung tính (46% - 54%): Không ép lệnh ảo, báo WAIT / NO EDGE
        if 0.46 <= prob_buy <= 0.54:
            action = "WAIT (NO EDGE)"
            is_buy = None
            raw_conf = round(max(prob_buy, 1.0 - prob_buy) * 100.0, 1)
        elif prob_buy > 0.54:
            action = "BUY"
            is_buy = True
            raw_conf = round(prob_buy * 100.0, 1)
        else:
            action = "SELL"
            is_buy = False
            raw_conf = round((1.0 - prob_buy) * 100.0, 1)

        trs = [max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1])) for i in range(-14, 0)]
        atr = float(np.mean(trs))
        entry = float(closes[-1])

        if is_buy is None:
            sl, tp, rr, kelly_lot = 0.0, 0.0, 0.0, 0.0
        else:
            sl_dist = atr * self.conformal_q_sl
            tp_dist = atr * self.conformal_q_tp
            sl = round(entry - sl_dist if is_buy else entry + sl_dist, digits)
            tp = round(entry + tp_dist if is_buy else entry - tp_dist, digits)
            rr = round(tp_dist / (sl_dist + 1e-9), 2)
            p = raw_conf / 100.0
            kelly_raw = (p * rr - (1.0 - p)) / (rr + 1e-9)
            kelly_lot = round(float(np.clip(kelly_raw * 0.25 * 0.5, 0.0, 0.50)), 2)

        sig = {
            "status": "REAL_MT5_OK",
            "data_source": f"REAL MT5 ({len(closes)} BARS)",
            "last_bar_time": last_bar_time,
            "model_source": model_source,
            "symbol": symbol,
            "action": action,
            "confidence": raw_conf,
            "entry": round(entry, digits),
            "tp": tp,
            "sl": sl,
            "rr": rr,
            "kelly_lot": kelly_lot,
            "frac_diff_z": round(fd_z, 2),
            "vpin": round(vpin * 100.0, 1),
            "hawkes_eta": round(hawkes_eta, 2),
            "oos_win_rate": self.oos_win_rate,
            "oos_brier": self.oos_brier,
            "oos_samples": self.oos_samples,
            "epochs": self.trained_epochs
        }
        if is_buy is not None:
            self.experiment_logs.append(sig)
            if len(self.experiment_logs) > 2000:
                self.experiment_logs.pop(0)
        return sig

    def export_csv(self):
        output = io.StringIO()
        if not self.experiment_logs:
            return "status,data_source,last_bar_time,model_source,symbol,action,confidence,entry,tp,sl,rr,kelly_lot,frac_diff_z,vpin,hawkes_eta,oos_win_rate,oos_brier,oos_samples,epochs\n"
        writer = csv.DictWriter(output, fieldnames=list(self.experiment_logs[0].keys()))
        writer.writeheader()
        writer.writerows(self.experiment_logs)
        return output.getvalue()

strict_brain = StrictScientificQuantEngine()
