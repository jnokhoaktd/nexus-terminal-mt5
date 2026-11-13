import urllib.request
import json
import numpy as np

class ColabDeepQuantBridge:
    def __init__(self):
        self.colab_url = ""
        self.connected = False
        self.last_prediction = {
            "source": "LOCAL_CPU_FALLBACK",
            "prob_up": 50.0,
            "prob_down": 50.0,
            "regime": "NEUTRAL",
            "expected_move_pts": 0.0
        }

    def set_url(self, url: str):
        clean = url.strip().rstrip("/")
        self.colab_url = clean
        if not clean:
            self.connected = False
            return False, "Colab URL cleared (Local fallback active)"
        try:
            req = urllib.request.Request(f"{clean}/health", method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    self.connected = True
                    return True, f"Connected to Colab GPU Node: {clean}"
        except Exception as e:
            self.connected = False
            return False, f"Colab unreachable ({str(e)[:45]}). Using local fallback."
        return False, "Connection failed"

    def infer(self, candles: list, cvd: float = 0.0):
        """Gửi tensor chuỗi thời gian sang Google Colab GPU để suy luận Deep Learning"""
        if self.connected and self.colab_url:
            try:
                payload = json.dumps({"candles": candles[-64:], "cvd": cvd}).encode("utf-8")
                req = urllib.request.Request(
                    f"{self.colab_url}/predict",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=2.5) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    data["source"] = "COLAB_T4_GPU"
                    self.last_prediction = data
                    return data
            except Exception:
                self.connected = False

        # Local lightweight statistical neural proxy khi chưa kết nối Colab
        if len(candles) >= 20:
            closes = np.array([c["close"] for c in candles[-20:]], dtype=float)
            rets = np.diff(closes)
            momentum = np.mean(rets[-5:]) / (np.std(rets) + 1e-9)
            sigmoid = 1.0 / (1.0 + np.exp(-momentum * 1.4))
            prob_up = round(float(sigmoid * 100.0), 1)
            prob_down = round(100.0 - prob_up, 1)
            regime = "BULLISH_EXPANSION" if prob_up > 60 else ("BEARISH_EXPANSION" if prob_down > 60 else "MEAN_REVERTING")
            self.last_prediction = {
                "source": "LOCAL_QUANT_PROXY",
                "prob_up": prob_up,
                "prob_down": prob_down,
                "regime": regime,
                "expected_move_pts": round(float(np.std(rets) * 2.5), 2)
            }
        return self.last_prediction

def build_footprint_profile(candles: list, bins: int = 18):
    """
    Xây dựng cấu trúc Footprint & Volume Profile (Bid x Ask theo từng mức giá)
    Tìm Point of Control (POC) và các vùng mất cân bằng thanh khoản (Imbalance).
    """
    if not candles or len(candles) < 10:
        return {"levels": [], "poc_price": 0.0, "total_delta": 0.0}

    recent = candles[-30:]
    low_min = min(c["low"] for c in recent)
    high_max = max(c["high"] for c in recent)
    if high_max <= low_min:
        return {"levels": [], "poc_price": low_min, "total_delta": 0.0}

    step = (high_max - low_min) / bins
    levels = []
    for i in range(bins):
        p_low = low_min + i * step
        p_high = p_low + step
        p_mid = (p_low + p_high) / 2.0
        levels.append({"price": round(p_mid, 2), "bid_vol": 0.0, "ask_vol": 0.0, "total": 0.0, "imbalance": "NONE"})

    for c in recent:
        vol = float(c.get("volume", 10.0))
        is_bull = c["close"] >= c["open"]
        # Phân bổ khối lượng vào các mức giá mà cây nến đi qua
        touched = [lv for lv in levels if c["low"] <= lv["price"] <= c["high"]]
        if not touched:
            closest = min(levels, key=lambda lv: abs(lv["price"] - c["close"]))
            touched = [closest]
        share = vol / len(touched)
        for lv in touched:
            if is_bull:
                lv["ask_vol"] += share * 0.68
                lv["bid_vol"] += share * 0.32
            else:
                lv["bid_vol"] += share * 0.68
                lv["ask_vol"] += share * 0.32

    poc_lv = max(levels, key=lambda x: x["bid_vol"] + x["ask_vol"])
    total_delta = 0.0
    for lv in levels:
        lv["bid_vol"] = round(lv["bid_vol"], 1)
        lv["ask_vol"] = round(lv["ask_vol"], 1)
        lv["total"] = round(lv["bid_vol"] + lv["ask_vol"], 1)
        total_delta += (lv["ask_vol"] - lv["bid_vol"])
        if lv["ask_vol"] > lv["bid_vol"] * 1.8 and lv["ask_vol"] > 5:
            lv["imbalance"] = "BUY_IMB"
        elif lv["bid_vol"] > lv["ask_vol"] * 1.8 and lv["bid_vol"] > 5:
            lv["imbalance"] = "SELL_IMB"

    return {
        "levels": list(reversed(levels)),
        "poc_price": poc_lv["price"],
        "total_delta": round(total_delta, 1)
    }
