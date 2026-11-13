# Module mở rộng cho Quant Model, Footprint & Orderflow
# Sau này bạn chỉ cần import các hàm tính Delta, CVD, Imbalance hoặc tín hiệu ML vào đây

def compute_orderflow_metrics(ticks_data):
    """
    Placeholder tính toán Buy/Sell Volume Delta từ mảng ticks MT5
    """
    if not ticks_data:
        return {"delta": 0, "buy_vol": 0, "sell_vol": 0}
    buy_vol = sum(t["volume"] for t in ticks_data if t["flag"] == "BUY")
    sell_vol = sum(t["volume"] for t in ticks_data if t["flag"] == "SELL")
    return {
        "delta": round(buy_vol - sell_vol, 2),
        "buy_vol": round(buy_vol, 2),
        "sell_vol": round(sell_vol, 2)
    }
