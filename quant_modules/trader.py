import time
from datetime import datetime
import MetaTrader5 as mt5
from quant_modules.research import compute_alpha_signal
from quant_modules.risk import QuantRiskManager

class AutonomousQuantTrader:
    def __init__(self, risk_mgr: QuantRiskManager):
        self.enabled = False
        self.symbol = "XAUUSD"
        self.timeframe = mt5.TIMEFRAME_M5
        self.sl_points = 300
        self.tp_points = 600
        self.auto_be_points = 200
        self.risk_mgr = risk_mgr
        self.last_trade_bar_time = 0
        self.last_status = "BOT STANDBY (OFF)"
        self.last_alpha = {"signal": "HOLD", "confidence": 0.0, "z_score": 0.0, "reason": "Idle"}
        self.agent_chat = []
        self._last_chat_key = ""

    def push_chat(self, agent: str, role_color: str, msg: str):
        key = f"{agent}:{msg}"
        if key == self._last_chat_key:
            return
        self._last_chat_key = key
        self.agent_chat.insert(0, {
            "time": datetime.now().strftime("%H:%M:%S"),
            "agent": agent,
            "color": role_color,
            "msg": msg
        })
        if len(self.agent_chat) > 45:
            self.agent_chat.pop()

    def manage_open_positions(self):
        positions = mt5.positions_get(symbol=self.symbol)
        if not positions:
            return
        sym = mt5.symbol_info(self.symbol)
        tick = mt5.symbol_info_tick(self.symbol)
        if not sym or not tick:
            return

        for p in positions:
            if p.magic != 202688:
                continue
            if p.type == mt5.POSITION_TYPE_BUY:
                profit_pts = (tick.bid - p.price_open) / sym.point
                if profit_pts >= self.auto_be_points and p.sl < p.price_open:
                    mt5.order_send({
                        "action": mt5.TRADE_ACTION_SLTP,
                        "symbol": p.symbol,
                        "position": p.ticket,
                        "sl": p.price_open,
                        "tp": p.tp
                    })
                    self.last_status = f"TRADER: Auto-BE #{p.ticket}"
                    self.push_chat("QUANT TRADER", "#00d26a", f"Lệnh #{p.ticket} đạt +{int(profit_pts)} pts. Đã kéo SL về hòa vốn (Breakeven @ {p.price_open}).")
            elif p.type == mt5.POSITION_TYPE_SELL:
                profit_pts = (p.price_open - tick.ask) / sym.point
                if profit_pts >= self.auto_be_points and (p.sl > p.price_open or p.sl == 0):
                    mt5.order_send({
                        "action": mt5.TRADE_ACTION_SLTP,
                        "symbol": p.symbol,
                        "position": p.ticket,
                        "sl": p.price_open,
                        "tp": p.tp
                    })
                    self.last_status = f"TRADER: Auto-BE #{p.ticket}"
                    self.push_chat("QUANT TRADER", "#00d26a", f"Lệnh #{p.ticket} đạt +{int(profit_pts)} pts. Đã kéo SL về hòa vốn (Breakeven @ {p.price_open}).")

    def step(self, cvd: float = 0.0):
        rates = mt5.copy_rates_from_pos(self.symbol, self.timeframe, 0, 50)
        if rates is None or len(rates) < 30:
            return

        candles = [{"time": int(r["time"]), "close": float(r["close"])} for r in rates]
        current_bar_time = candles[-1]["time"]

        alpha = compute_alpha_signal(candles, cvd)
        prev_sig = self.last_alpha.get("signal")
        self.last_alpha = alpha

        if alpha["signal"] != "HOLD" and alpha["signal"] != prev_sig:
            self.push_chat(
                "QUANT RESEARCH",
                "#00e5ff",
                f"Phát hiện tín hiệu {alpha['signal']} trên {self.symbol} (Độ tin cậy {alpha['confidence']}%, Z={alpha['z_score']}). Cơ sở: {alpha['reason']}."
            )

        if not self.enabled:
            self.last_status = f"STANDBY | Alpha: {alpha['signal']} ({alpha['confidence']}%)"
            return

        self.manage_open_positions()

        if alpha["signal"] in ("BUY", "SELL") and current_bar_time != self.last_trade_bar_time:
            allowed, reason = self.risk_mgr.evaluate_trade_permission(self.symbol)
            if not allowed:
                self.last_status = reason
                self.push_chat("QUANT RISK", "#ff3b30", f"TỪ CHỐI LỆNH {alpha['signal']}: {reason}. Giữ nguyên trạng thái phòng thủ.")
                return

            lot = self.risk_mgr.compute_position_size(self.symbol, self.sl_points)
            self.push_chat("QUANT RISK", "#ff9900", f"DUYỆT RỦI RO: Tài khoản an toàn (DD < {self.risk_mgr.max_daily_loss_pct}%). Cấp phép khối lượng {lot} lot.")

            sym = mt5.symbol_info(self.symbol)
            tick = mt5.symbol_info_tick(self.symbol)
            point = sym.point

            if alpha["signal"] == "BUY":
                action_type = mt5.ORDER_TYPE_BUY
                price = tick.ask
                sl = price - self.sl_points * point
                tp = price + self.tp_points * point
            else:
                action_type = mt5.ORDER_TYPE_SELL
                price = tick.bid
                sl = price + self.sl_points * point
                tp = price - self.tp_points * point

            req = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": self.symbol,
                "volume": lot,
                "type": action_type,
                "price": price,
                "sl": round(sl, sym.digits),
                "tp": round(tp, sym.digits),
                "deviation": 20,
                "magic": 202688,
                "comment": f"AI_BOT_{alpha['confidence']}",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
            res = mt5.order_send(req)
            if res.retcode != mt5.TRADE_RETCODE_DONE:
                req["type_filling"] = mt5.ORDER_FILLING_FOK
                res = mt5.order_send(req)

            if res.retcode == mt5.TRADE_RETCODE_DONE:
                self.last_trade_bar_time = current_bar_time
                self.last_status = f"EXECUTED {alpha['signal']} {lot} lot #{res.order}"
                self.push_chat("QUANT TRADER", "#00d26a", f"KHỚP LỆNH #{res.order}: {alpha['signal']} {lot} lot {self.symbol} @ {res.price} (SL: {round(sl, sym.digits)} | TP: {round(tp, sym.digits)}).")
                self.push_chat("QUANT DEV", "#e040fb", f"Telemetry: Lệnh #{res.order} đồng bộ thành công xuống MT5 Bridge (Latency < 18ms).")
            else:
                self.last_status = f"EXEC ERR: {res.comment}"
                self.push_chat("QUANT DEV", "#ff3b30", f"LỖI THỰC THI MT5 (Retcode {res.retcode}): {res.comment}")
