import MetaTrader5 as mt5

class QuantRiskManager:
    def __init__(self):
        self.max_daily_loss_pct = 3.0   # Khóa bot nếu lỗ trong ngày vượt 3% Equity
        self.max_open_positions = 2     # Tối đa 2 lệnh mở cùng lúc
        self.max_spread_points = 50     # Chặn vào lệnh nếu spread giãn quá 50 points
        self.risk_per_trade_pct = 0.5   # Rủi ro mặc định 0.5% mỗi lệnh tự động

    def evaluate_trade_permission(self, symbol: str):
        acc = mt5.account_info()
        sym = mt5.symbol_info(symbol)
        if not acc or not sym:
            return False, "MT5 Account/Symbol unavailable"

        # 1. Kiểm tra giới hạn lỗ ngày (Floating PnL)
        if acc.balance > 0:
            daily_dd_pct = (-acc.profit / acc.balance) * 100.0 if acc.profit < 0 else 0.0
            if daily_dd_pct >= self.max_daily_loss_pct:
                return False, f"RISK HALT: Daily Drawdown {daily_dd_pct:.2f}% >= {self.max_daily_loss_pct}%"

        # 2. Kiểm tra số lượng lệnh đang mở
        positions = mt5.positions_get(symbol=symbol)
        if positions and len(positions) >= self.max_open_positions:
            return False, f"RISK HALT: Max positions ({self.max_open_positions}) reached for {symbol}"

        # 3. Kiểm tra Spread thị trường
        if sym.spread > self.max_spread_points:
            return False, f"RISK HALT: High spread ({sym.spread} > {self.max_spread_points} pts)"

        return True, "APPROVED"

    def compute_position_size(self, symbol: str, sl_points: int, custom_risk_pct: float = None) -> float:
        acc = mt5.account_info()
        sym = mt5.symbol_info(symbol)
        if not acc or not sym or sl_points <= 0:
            return sym.volume_min if sym else 0.01

        risk_pct = custom_risk_pct if custom_risk_pct is not None else self.risk_per_trade_pct
        risk_money = acc.equity * (risk_pct / 100.0)
        tick_value = sym.trade_tick_value
        tick_size = sym.trade_tick_size
        if tick_value <= 0 or tick_size <= 0:
            return sym.volume_min

        point_val = tick_value * (sym.point / tick_size)
        raw_lot = risk_money / (sl_points * point_val)
        step = sym.volume_step
        lot = round(raw_lot / step) * step
        return round(max(sym.volume_min, min(sym.volume_max, lot)), 2)
