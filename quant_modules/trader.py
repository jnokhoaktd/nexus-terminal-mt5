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
                        "action": mt5.TRADE_ACTION_SLTP, "symbol": p.symbol,
                        "position": p.ticket, "sl": p.price_open, "tp": p.tp
                    })
                    self.last_status = f"TRADER: Auto-BE #{p.ticket}"
                    self.push_chat("QUANT TRADER", "#10b981", f"Lệnh #{p.ticket} đạt +{int(profit_pts)} pts -> Kéo SL về hòa vốn @ {p.price_open}.")
            elif p.type == mt5.POSITION_TYPE_SELL:
                profit_pts = (p.price_open - tick.ask) / sym.point
                if profit_pts >= self.auto_be_points and (p.sl > p.price_open or p.sl == 0):
                    mt5.order_send({
                        "action": mt5.TRADE_ACTION_SLTP, "symbol": p.symbol,
                        "position": p.ticket, "sl": p.price_open, "tp": p.tp
                    })
                    self.last_status = f"TRADER: Auto-BE #{p.ticket}"
                    self.push_chat("QUANT TRADER", "#10b981", f"Lệnh #{p.ticket} đạt +{int(profit_pts)} pts -> Kéo SL về hòa vốn @ {p.price_open}.")

    def step(self, cvd: float = 0.0, dl_pred: dict = None):
        rates = mt5.copy_rates_from_pos(self.symbol, self.timeframe, 0, 50)
        if rates is None or len(rates) < 30:
            return

        candles = [{"time": int(r["time"]), "close": float(r["close"])} for r in rates]
        current_bar_time = candles[-1]["time"]

        alpha = compute_alpha_signal(candles, cvd)
        prev_sig = self.last_alpha.get("signal")
        self.last_alpha = alpha

        if alpha["signal"] != "HOLD" and alpha["signal"] != prev_sig:
            dl_note = f"Colab GPU: UP {dl_pred['prob_up']}% / DN {dl_pred['prob_down']}%" if dl_pred else ""
            self.push_chat(
                "QUANT RESEARCH", "#38bdf8",
                f"Tín hiệu {alpha['signal']} trên {self.symbol} (Conf {alpha['confidence']}%, KZ={alpha['kalman_z']}). {dl_note}"
            )

        if not self.enabled:
            self.last_status = f"STANDBY | Alpha: {alpha['signal']} ({alpha['confidence']}%)"
            return

        self.manage_open_positions()

        if alpha["signal"] in ("BUY", "SELL") and current_bar_time != self.last_trade_bar_time:
            # Kiểm tra đồng thuận từ Deep Learning (nếu đang kết nối Colab)
            if dl_pred and dl_pred.get("source") == "COLAB_T4_GPU":
                if alpha["signal"] == "BUY" and dl_pred.get("prob_up", 50) < 55.0:
                    self.push_chat("QUANT RESEARCH", "#94a3b8", f"Bỏ qua kèo BUY: Colab GPU xác suất tăng thấp ({dl_pred['prob_up']}% < 55%).")
                    return
                if alpha["signal"] == "SELL" and dl_pred.get("prob_down", 50) < 55.0:
                    self.push_chat("QUANT RESEARCH", "#94a3b8", f"Bỏ qua kèo SELL: Colab GPU xác suất giảm thấp ({dl_pred['prob_down']}% < 55%).")
                    return

            allowed, reason = self.risk_mgr.evaluate_trade_permission(self.symbol)
            if not allowed:
                self.last_status = reason
                self.push_chat("QUANT RISK", "#ef4444", f"CHẶN LỆNH {alpha['signal']}: {reason}.")
                return

            lot = self.risk_mgr.compute_position_size(self.symbol, self.sl_points)
            self.push_chat("QUANT RISK", "#f59e0b", f"DUYỆT LỆNH: Risk OK (DD < {self.risk_mgr.max_daily_loss_pct}%). Cấp phép {lot} lot.")

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
                "action": mt5.TRADE_ACTION_DEAL, "symbol": self.symbol, "volume": lot,
                "type": action_type, "price": price, "sl": round(sl, sym.digits), "tp": round(tp, sym.digits),
                "deviation": 20, "magic": 202688, "comment": f"NEXUS_AI_{alpha['confidence']}",
                "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
            }
            res = mt5.order_send(req)
            if res.retcode != mt5.TRADE_RETCODE_DONE:
                req["type_filling"] = mt5.ORDER_FILLING_FOK
                res = mt5.order_send(req)

            if res.retcode == mt5.TRADE_RETCODE_DONE:
                self.last_trade_bar_time = current_bar_time
                self.last_status = f"EXECUTED {alpha['signal']} {lot} lot #{res.order}"
                self.push_chat("QUANT TRADER", "#10b981", f"ĐÃ KHỚP #{res.order}: {alpha['signal']} {lot} lot {self.symbol} @ {res.price}.")
            else:
                self.last_status = f"EXEC ERR: {res.comment}"
