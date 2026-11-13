import time
import random
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
        self.last_alpha = {"signal": "HOLD", "confidence": 0.0, "kalman_z": 0.0, "reason": "Idle"}
        self.agent_chat = []
        self._last_chat_key = ""
        self._last_stream_ts = 0.0
        self._stream_turn = 0

    def push_chat(self, agent: str, role_color: str, msg: str, force: bool = False):
        key = f"{agent}:{msg}"
        if not force and key == self._last_chat_key:
            return
        self._last_chat_key = key
        self.agent_chat.insert(0, {
            "time": datetime.now().strftime("%H:%M:%S"),
            "agent": agent,
            "color": role_color,
            "msg": msg
        })
        if len(self.agent_chat) > 40:
            self.agent_chat.pop()

    def stream_live_commentary(self, candles: list, cvd: float, alpha: dict, dl_pred: dict = None):
        """Tạo luồng hội thoại phản biện trực tiếp giữa 4 AI Agent mỗi 4.5 giây"""
        now = time.time()
        if now - self._last_stream_ts < 4.5:
            return
        self._last_stream_ts = now
        self._stream_turn = (self._stream_turn + 1) % 4

        last_c = candles[-1]["close"]
        prev_c = candles[-2]["close"] if len(candles) > 1 else last_c
        delta_p = round(last_c - prev_c, 2)
        kz = alpha.get("kalman_z", 0.0)
        conf = alpha.get("confidence", 0.0)

        if self._stream_turn == 0:
            flow_bias = "phe Mua (Ask) đang áp đảo" if cvd > 0 else ("phe Bán (Bid) đang ép giá" if cvd < 0 else "thanh khoản hai đầu cân bằng")
            self.push_chat(
                "QUANT RESEARCH", "#38bdf8",
                f"[{self.symbol} @ {last_c}] Biến động nến {delta_p:+} pts, Kalman Z-score = {kz}σ. Dữ liệu Orderflow cho thấy {flow_bias} (CVD: {cvd:+}).",
                force=True
            )
        elif self._stream_turn == 1:
            if dl_pred and dl_pred.get("source") == "COLAB_T4_GPU":
                up_p = dl_pred.get("prob_up", 50.0)
                dn_p = dl_pred.get("prob_down", 50.0)
                reg = dl_pred.get("regime", "NEUTRAL")
                acc = dl_pred.get("train_acc", 0.0)
                self.push_chat(
                    "COLAB DL NODE", "#2dd4bf",
                    f"Tensor GPU cập nhật: Xác suất Tăng {up_p}% vs Giảm {dn_p}% [{reg}] (Độ chính xác model: {acc}%).",
                    force=True
                )
            else:
                self.push_chat(
                    "COLAB DL NODE", "#2dd4bf",
                    f"Đang chạy suy luận cục bộ dự phòng (Chưa link Colab GPU). Xác suất hồi quy hiện tại: {alpha['signal']} ({conf}%).",
                    force=True
                )
        elif self._stream_turn == 2:
            acc = mt5.account_info()
            dd_pct = round(((acc.balance - acc.equity) / acc.balance * 100.0), 2) if (acc and acc.balance > 0 and acc.equity < acc.balance) else 0.0
            self.push_chat(
                "QUANT RISK", "#f59e0b",
                f"Giám sát tài khoản: Floating DD = {dd_pct}% / Giới hạn {self.risk_mgr.max_daily_loss_pct}%. Sẵn sàng cấp phát {self.risk_mgr.risk_per_trade_pct}% risk khi đủ điều kiện.",
                force=True
            )
        else:
            if self.enabled:
                self.push_chat(
                    "QUANT TRADER", "#10b981",
                    f"Chế độ Tự trị ĐANG BẬT: Đang rình điểm bóp cò trên {self.symbol} (SL {self.sl_points} / TP {self.tp_points} pts). Trạng thái: {alpha['signal']}.",
                    force=True
                )
            else:
                self.push_chat(
                    "QUANT TRADER", "#94a3b8",
                    f"Đang ở chế độ Quan sát (Standby). Nếu muốn Bot tự vào lệnh theo đồng thuận AI, hãy bấm START AI QUANT BOT.",
                    force=True
                )

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
                    self.push_chat("QUANT TRADER", "#10b981", f"Lệnh #{p.ticket} lãi +{int(profit_pts)} pts -> Kéo SL về hòa vốn @ {p.price_open}.", force=True)
            elif p.type == mt5.POSITION_TYPE_SELL:
                profit_pts = (p.price_open - tick.ask) / sym.point
                if profit_pts >= self.auto_be_points and (p.sl > p.price_open or p.sl == 0):
                    mt5.order_send({
                        "action": mt5.TRADE_ACTION_SLTP, "symbol": p.symbol,
                        "position": p.ticket, "sl": p.price_open, "tp": p.tp
                    })
                    self.push_chat("QUANT TRADER", "#10b981", f"Lệnh #{p.ticket} lãi +{int(profit_pts)} pts -> Kéo SL về hòa vốn @ {p.price_open}.", force=True)

    def step(self, cvd: float = 0.0, dl_pred: dict = None):
        rates = mt5.copy_rates_from_pos(self.symbol, self.timeframe, 0, 50)
        if rates is None or len(rates) < 30:
            return

        candles = [{"time": int(r["time"]), "close": float(r["close"])} for r in rates]
        current_bar_time = candles[-1]["time"]

        alpha = compute_alpha_signal(candles, cvd)
        self.last_alpha = alpha

        # Phát luồng hội thoại livestream liên tục
        self.stream_live_commentary(candles, cvd, alpha, dl_pred)

        if not self.enabled:
            self.last_status = f"STANDBY | Alpha: {alpha['signal']} ({alpha['confidence']}%)"
            return

        self.manage_open_positions()

        if alpha["signal"] in ("BUY", "SELL") and current_bar_time != self.last_trade_bar_time:
            if dl_pred and dl_pred.get("source") == "COLAB_T4_GPU":
                if alpha["signal"] == "BUY" and dl_pred.get("prob_up", 50) < 55.0:
                    self.push_chat("QUANT RESEARCH", "#94a3b8", f"Hủy kèo BUY: Colab GPU xác suất tăng thấp ({dl_pred['prob_up']}% < 55%).")
                    return
                if alpha["signal"] == "SELL" and dl_pred.get("prob_down", 50) < 55.0:
                    self.push_chat("QUANT RESEARCH", "#94a3b8", f"Hủy kèo SELL: Colab GPU xác suất giảm thấp ({dl_pred['prob_down']}% < 55%).")
                    return

            allowed, reason = self.risk_mgr.evaluate_trade_permission(self.symbol)
            if not allowed:
                self.last_status = reason
                self.push_chat("QUANT RISK", "#ef4444", f"CHẶN LỆNH {alpha['signal']}: {reason}.")
                return

            lot = self.risk_mgr.compute_position_size(self.symbol, self.sl_points)
            sym = mt5.symbol_info(self.symbol)
            tick = mt5.symbol_info_tick(self.symbol)
            point = sym.point

            if alpha["signal"] == "BUY":
                action_type, price = mt5.ORDER_TYPE_BUY, tick.ask
                sl, tp = price - self.sl_points * point, price + self.tp_points * point
            else:
                action_type, price = mt5.ORDER_TYPE_SELL, tick.bid
                sl, tp = price + self.sl_points * point, price - self.tp_points * point

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
                self.push_chat("QUANT TRADER", "#10b981", f"KHỚP LỆNH #{res.order}: {alpha['signal']} {lot} lot {self.symbol} @ {res.price}.", force=True)
