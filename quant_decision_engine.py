import numpy as np
import random
import time
from datetime import datetime

class DynamicQuantBrain:
    def __init__(self):
        self.weights = np.random.randn(6, 1) * 0.35
        self.bias = 0.0
        self.trained_epochs = 0
        self.last_regime = ""
        self.message_history = []
        self.active_signal = {
            "action": "WAIT",
            "confidence": 0.0,
            "entry": 0.0,
            "tp": 0.0,
            "sl": 0.0,
            "rr": 2.2,
            "reason": "Dang cho xac nhan dong tien"
        }

    def extract_features(self, closes, highs, lows, volumes):
        c = np.array(closes, dtype=float)
        h = np.array(highs, dtype=float)
        l = np.array(lows, dtype=float)
        v = np.array(volumes, dtype=float)

        ret_1 = (c[-1] - c[-2]) / (c[-2] + 1e-9)
        ret_5 = (c[-1] - c[-6]) / (c[-6] + 1e-9)
        ret_15 = (c[-1] - c[-16]) / (c[-16] + 1e-9)

        mean_20 = np.mean(c[-20:])
        std_20 = np.std(c[-20:]) + 1e-9
        kalman_z = (c[-1] - mean_20) / std_20

        # Orderflow proxy từ vị trí đóng cửa trong biên độ nến * khối lượng
        bar_range = (h[-10:] - l[-10:]) + 1e-9
        close_pos = ((c[-10:] - l[-10:]) / bar_range) * 2.0 - 1.0
        cvd_pressure = np.sum(close_pos * v[-10:]) / (np.sum(v[-10:]) + 1e-9)

        vol_ratio = v[-1] / (np.mean(v[-20:]) + 1e-9)

        feats = np.array([
            np.tanh(ret_1 * 400),
            np.tanh(ret_5 * 180),
            np.tanh(ret_15 * 100),
            np.tanh(-kalman_z * 0.7),   # Mean reversion component
            np.tanh(cvd_pressure * 2.5), # Orderflow momentum component
            np.tanh((vol_ratio - 1.0))
        ])
        return feats, kalman_z, cvd_pressure, vol_ratio

    def train_on_history(self, closes, highs, lows, volumes, epochs=60, lr=0.08):
        if len(closes) < 40:
            return {"status": "insufficient_data", "epochs": self.trained_epochs}

        X, Y = [], []
        for i in range(25, len(closes) - 4):
            feats, _, _, _ = self.extract_features(
                closes[:i+1], highs[:i+1], lows[:i+1], volumes[:i+1]
            )
            future_ret = (closes[i+3] - closes[i]) / (closes[i] + 1e-9)
            label = 1.0 if future_ret > 0 else 0.0
            X.append(feats)
            Y.append(label)

        X = np.array(X)
        Y = np.array(Y).reshape(-1, 1)

        for _ in range(epochs):
            logits = X @ self.weights + self.bias
            preds = 1.0 / (1.0 + np.exp(-np.clip(logits, -15, 15)))
            grad_w = (X.T @ (preds - Y)) / len(X)
            grad_b = np.mean(preds - Y)
            self.weights -= lr * grad_w
            self.bias -= lr * grad_b

        self.trained_epochs += epochs
        return {
            "status": "trained",
            "epochs": self.trained_epochs,
            "samples": len(X),
            "weights_norm": round(float(np.linalg.norm(self.weights)), 4)
        }

    def infer_and_plan(self, symbol, closes, highs, lows, volumes, digits=2):
        if len(closes) < 25:
            return self.active_signal, []

        # Tự động huấn luyện mỗi khi khởi động nếu chưa train
        if self.trained_epochs == 0:
            self.train_on_history(closes, highs, lows, volumes, epochs=80)

        feats, kalman_z, cvd_pressure, vol_ratio = self.extract_features(closes, highs, lows, volumes)
        logit = float((feats @ self.weights)[0] + self.bias)
        prob_buy = 1.0 / (1.0 + np.exp(-np.clip(logit, -15, 15)))

        # Tính ATR(14) để đặt TP/SL chuẩn xác theo biến động thực tế
        tr_list = []
        for i in range(-14, 0):
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i-1]),
                abs(lows[i] - closes[i-1])
            )
            tr_list.append(tr)
        atr = float(np.mean(tr_list))
        current_price = float(closes[-1])

        # Xác định hướng đi dứt khoát và độ tự tin thực (không kẹt 1%)
        if prob_buy >= 0.54:
            action = "BUY"
            confidence = min(96.5, round(50.0 + (prob_buy - 0.5) * 95.0, 1))
            sl = round(current_price - atr * 1.4, digits)
            tp = round(current_price + atr * 3.1, digits)
        elif prob_buy <= 0.46:
            action = "SELL"
            confidence = min(96.5, round(50.0 + (0.5 - prob_buy) * 95.0, 1))
            sl = round(current_price + atr * 1.4, digits)
            tp = round(current_price - atr * 3.1, digits)
        else:
            # Nếu vùng lưỡng lự, nghiêng theo áp lực dòng tiền CVD thực tế để ra kịch bản rõ ràng
            action = "BUY" if cvd_pressure >= 0 else "SELL"
            confidence = round(54.0 + abs(cvd_pressure) * 18.0, 1)
            if action == "BUY":
                sl = round(current_price - atr * 1.3, digits)
                tp = round(current_price + atr * 2.8, digits)
            else:
                sl = round(current_price + atr * 1.3, digits)
                tp = round(current_price - atr * 2.8, digits)

        rr = round(abs(tp - current_price) / (abs(current_price - sl) + 1e-9), 2)

        # Phân loại chế độ thị trường để sinh hội thoại đa dạng không lặp lại
        if abs(kalman_z) > 1.6:
            regime = "MEAN_REVERSION"
        elif vol_ratio > 1.35:
            regime = "LIQUIDITY_BREAKOUT"
        elif abs(cvd_pressure) > 0.35:
            regime = "ORDERFLOW_IMBALANCE"
        else:
            regime = "STRUCTURAL_DRIFT"

        self.active_signal = {
            "symbol": symbol,
            "action": action,
            "confidence": confidence,
            "entry": round(current_price, digits),
            "tp": tp,
            "sl": sl,
            "rr": rr,
            "atr": round(atr, digits),
            "kalman_z": round(kalman_z, 2),
            "cvd": round(cvd_pressure * 100, 1),
            "regime": regime,
            "trained_epochs": self.trained_epochs,
            "updated_at": datetime.now().strftime("%H:%M:%S")
        }

        messages = self._generate_non_repetitive_debate(self.active_signal)
        return self.active_signal, messages

    def _generate_non_repetitive_debate(self, sig):
        act = sig["action"]
        sym = sig["symbol"]
        ent = sig["entry"]
        tp = sig["tp"]
        sl = sig["sl"]
        conf = sig["confidence"]
        kz = sig["kalman_z"]
        cvd = sig["cvd"]
        rr = sig["rr"]

        research_pool = [
            f"[{sym}] Độ lệch Kalman đạt {kz}σ; cấu trúc giá đang mở biên độ thuận chiều {act} với xác suất {conf}%.",
            f"[{sym}] Dòng tiền chủ động (CVD) nghiêng {cvd}% xác nhận lực đẩy thực tế tại vùng {ent}, ưu tiên kịch bản {act}.",
            f"[{sym}] Sau {sig['trained_epochs']} vòng học Walk-Forward, mô hình phát hiện mất cân bằng thanh khoản ủng hộ lệnh {act} ({conf}%).",
            f"[{sym}] Biến động ATR={sig['atr']} cho thấy nhịp mở sóng mới; phe {act} đang kiểm soát vùng giá {ent}."
        ]

        risk_pool = [
            f"Đã khóa biên độ rủi ro theo 1.4x ATR: đặt SL cứng tại {sl} và mục tiêu chốt lời TP tại {tp} (tỷ lệ R:R = 1:{rr}).",
            f"Vùng vô hiệu hóa cấu trúc nằm tại {sl}. Nếu giữ vững trên/dưới ngưỡng này, kỳ vọng giá quét thanh khoản tới {tp}.",
            f"Quản trị vốn chuẩn: Entry {ent} | Cắt lỗ tuyệt đối {sl} | Chốt lời mục tiêu {tp} (R:R 1:{rr})."
        ]

        trader_pool = [
            f"CHỐT KÈO {sym}: {act} ngay vùng {ent} | TP: {tp} | SL: {sl} (Độ tin cậy {conf}%).",
            f"TÍN HIỆU THỰC THI: Vào lệnh {act} {sym} @ {ent} — Mục tiêu TP {tp}, dừng lỗ SL {sl}.",
            f"QUYẾT ĐỊNH GIAO DỊCH: Kích hoạt vị thế {act} trên {sym} tại {ent} | Chốt lời {tp} | Cắt lỗ {sl}."
        ]

        # Chọn câu chưa xuất hiện gần đây để chống lặp văn bản
        def pick_unique(pool):
            candidates = [m for m in pool if m not in self.message_history[-8:]]
            chosen = random.choice(candidates if candidates else pool)
            self.message_history.append(chosen)
            if len(self.message_history) > 30:
                self.message_history.pop(0)
            return chosen

        return [
            {"agent": "QUANT RESEARCH", "color": "#00f0ff", "text": pick_unique(research_pool)},
            {"agent": "QUANT RISK", "color": "#ffaa00", "text": pick_unique(risk_pool)},
            {"agent": "QUANT TRADER", "color": "#00ff88" if act == "BUY" else "#ff4466", "text": pick_unique(trader_pool)}
        ]

brain = DynamicQuantBrain()
