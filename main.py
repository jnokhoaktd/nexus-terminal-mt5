import asyncio
import json
import numpy as np
from datetime import datetime
import MetaTrader5 as mt5
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from quant_modules.research import run_vector_backtest, kalman_filter_1d, garch_1_1_volatility
from quant_modules.risk import QuantRiskManager
from quant_modules.trader import AutonomousQuantTrader

app = FastAPI(title="NEXUS // 3D MULTI-TASK QUANT ENGINE & AI WAR ROOM")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TIMEFRAME_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}

risk_manager = QuantRiskManager()
quant_bot = AutonomousQuantTrader(risk_manager)

def ensure_mt5() -> bool:
    if mt5.terminal_info() is not None:
        return True
    return mt5.initialize()

def resolve_symbol(requested: str) -> str:
    req = requested.strip().upper()
    if mt5.symbol_select(req, True):
        return req
    all_syms = mt5.symbols_get()
    if all_syms:
        for s in all_syms:
            if req in s.name.upper():
                mt5.symbol_select(s.name, True)
                return s.name
        visible = [s.name for s in all_syms if s.visible]
        if visible:
            return visible[0]
    return req

class OrderRequest(BaseModel):
    symbol: str
    order_type: str
    risk_percent: float
    sl_points: int
    tp_points: int
    fixed_lot: float = 0.0

class BacktestRequest(BaseModel):
    symbol: str
    tf: str
    bars: int = 500
    fast_ema: int = 9
    slow_ema: int = 21

class BotConfigRequest(BaseModel):
    enabled: bool
    symbol: str
    tf: str
    risk_pct: float = 0.5
    max_dd_pct: float = 3.0
    sl_points: int = 300
    tp_points: int = 600

@app.get("/")
def serve_ui():
    return FileResponse("index.html")

@app.get("/api/watchlist")
def get_watchlist():
    if not ensure_mt5():
        return {"connected": False, "symbols": ["XAUUSD", "EURUSD", "GBPUSD", "BTCUSD"]}
    syms = mt5.symbols_get()
    visible = [s.name for s in syms if s.visible][:25] if syms else []
    return {"connected": True, "symbols": visible or ["XAUUSD"]}

@app.get("/api/history/{symbol}/{tf}")
def get_historical_candles(symbol: str, tf: str, count: int = 400):
    if not ensure_mt5():
        raise HTTPException(status_code=503, detail="MT5 chưa kết nối")
    real_sym = resolve_symbol(symbol)
    mt5_tf = TIMEFRAME_MAP.get(tf.upper(), mt5.TIMEFRAME_M5)
    rates = mt5.copy_rates_from_pos(real_sym, mt5_tf, 0, count)
    if rates is None or len(rates) == 0:
        raise HTTPException(status_code=404, detail=f"Không có dữ liệu nến cho {real_sym}")

    candles, volumes = [], []
    for r in rates:
        t = int(r["time"])
        o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        candles.append({"time": t, "open": o, "high": h, "low": l, "close": c})
        volumes.append({
            "time": t,
            "value": float(r["tick_volume"]),
            "color": "rgba(0, 210, 106, 0.4)" if c >= o else "rgba(255, 59, 48, 0.4)"
        })
    return {"symbol": real_sym, "candles": candles, "volumes": volumes}

@app.get("/api/quant/surface/{symbol}/{tf}")
def get_3d_quant_surface(symbol: str, tf: str, model: str = "orderflow"):
    """
    Multi-Task 3D Quant Surface (32x32 High-Res Mesh):
    - model='orderflow': Orderflow Imbalance & Liquidity Depth Surface
    - model='kalman': Kalman Filter Latent Fair-Value & Innovation Manifold
    - model='garch': GARCH(1,1) Conditional Volatility & Tail-Risk Surface
    """
    if not ensure_mt5():
        raise HTTPException(status_code=503, detail="MT5 chưa kết nối")
    real_sym = resolve_symbol(symbol)
    mt5_tf = TIMEFRAME_MAP.get(tf.upper(), mt5.TIMEFRAME_M5)
    rates = mt5.copy_rates_from_pos(real_sym, mt5_tf, 0, 32)
    if rates is None or len(rates) < 32:
        raise HTTPException(status_code=404, detail="Không đủ dữ liệu dựng 3D")

    opens = np.array([float(r["open"]) for r in rates])
    closes = np.array([float(r["close"]) for r in rates])
    highs = np.array([float(r["high"]) for r in rates])
    lows = np.array([float(r["low"]) for r in rates])
    vols = np.array([float(r["tick_volume"]) for r in rates])

    k_est, kalman_z = kalman_filter_1d(closes)
    garch_vol, garch_ratio = garch_1_1_volatility(closes)
    garch_padded = np.pad(garch_vol, (1, 0), mode='edge')

    norm_vols = vols / (np.max(vols) if np.max(vols) > 0 else 1.0)
    delta_proxy = np.where(closes >= opens, 1.0, -1.0) * norm_vols
    k_residual = (closes - k_est) / (np.std(closes - k_est) + 1e-9)

    size = 32
    grid = []
    for i in range(size):
        row = []
        for j in range(size):
            u = (i / (size - 1)) * 2.0 - 1.0
            v = (j / (size - 1)) * 2.0 - 1.0

            if model == "kalman":
                # Bề mặt đa tạp Kalman: Đỉnh thể hiện độ lệch khỏi Fair Value
                ridge = np.exp(-3.0 * ((v - np.tanh(k_residual[i] * 0.6)) ** 2))
                h = (k_residual[i] * 2.2) * ridge + np.cos(u * 3.0) * 0.4
            elif model == "garch":
                # Phễu rủi ro đuôi GARCH(1,1): Hai biên vểnh cao khi biến động tăng đột biến
                vol_norm = garch_padded[i] / (np.max(garch_padded) + 1e-9)
                tail_wing = (v ** 2) * (1.5 + vol_norm * 3.5)
                center_dip = -np.exp(-4.0 * (v ** 2)) * 1.4
                h = tail_wing + center_dip + np.sin(i * 0.4) * 0.3
            else:
                # Mặc định: Orderflow Imbalance & Liquidity Depth
                pocket = np.exp(-2.8 * (v ** 2))
                imbalance_wave = delta_proxy[i] * 3.4 * pocket + np.sin(j * 0.45 + i * 0.25) * 0.55
                h = imbalance_wave + (norm_vols[i] * 1.6 * pocket)

            row.append(round(float(np.clip(h, -3.5, 4.2)), 3))
        grid.append(row)

    return {
        "symbol": real_sym,
        "tf": tf,
        "model": model,
        "grid": grid,
        "kalman_z": round(kalman_z, 2),
        "garch_ratio": round(garch_ratio, 2)
    }

@app.post("/api/bot/config")
def configure_quant_bot(cfg: BotConfigRequest):
    real_sym = resolve_symbol(cfg.symbol)
    quant_bot.enabled = cfg.enabled
    quant_bot.symbol = real_sym
    quant_bot.timeframe = TIMEFRAME_MAP.get(cfg.tf.upper(), mt5.TIMEFRAME_M5)
    quant_bot.sl_points = cfg.sl_points
    quant_bot.tp_points = cfg.tp_points
    risk_manager.risk_per_trade_pct = cfg.risk_pct
    risk_manager.max_daily_loss_pct = cfg.max_dd_pct

    if cfg.enabled:
        quant_bot.push_chat("QUANT DEV", "#e040fb", f"Khởi động cụm Multi-Task AI trên {real_sym} [{cfg.tf}]. Kalman + GARCH + Orderflow đồng bộ.")
        quant_bot.push_chat("QUANT RESEARCH", "#00e5ff", f"Đang trích xuất trạng thái Kalman Fair-Value và phễu rủi ro GARCH(1,1)...")
        quant_bot.push_chat("QUANT RISK", "#ff9900", f"Lá chắn Prop Firm kích hoạt: Risk/lệnh = {cfg.risk_pct}%, Daily DD Limit = {cfg.max_dd_pct}%.")
    else:
        quant_bot.push_chat("QUANT TRADER", "#94a3b8", "Đã tạm dừng Bot AI tự động.")

    return {
        "status": "OK",
        "bot_enabled": quant_bot.enabled,
        "symbol": real_sym,
        "msg": f"AI Bot {'ACTIVATED' if cfg.enabled else 'STOPPED'} on {real_sym} [{cfg.tf}]"
    }

@app.post("/api/quant/backtest")
def api_backtest(req: BacktestRequest):
    if not ensure_mt5():
        raise HTTPException(status_code=503, detail="MT5 chưa kết nối")
    real_sym = resolve_symbol(req.symbol)
    mt5_tf = TIMEFRAME_MAP.get(req.tf.upper(), mt5.TIMEFRAME_M5)
    rates = mt5.copy_rates_from_pos(real_sym, mt5_tf, 0, req.bars)
    if rates is None or len(rates) == 0:
        raise HTTPException(status_code=404, detail="Không đủ dữ liệu lịch sử")
    candles = [{"time": int(r["time"]), "close": float(r["close"])} for r in rates]
    return run_vector_backtest(candles, req.fast_ema, req.slow_ema)

@app.websocket("/ws/stream/{symbol}/{tf}")
async def websocket_stream(websocket: WebSocket, symbol: str, tf: str):
    await websocket.accept()
    last_tick_msc = 0
    cvd, buy_vol_total, sell_vol_total = 0.0, 0.0, 0.0

    if not quant_bot.agent_chat:
        quant_bot.push_chat("QUANT DEV", "#e040fb", "Cụm Multi-Task 3D Engine (Orderflow + Kalman + GARCH) đã sẵn sàng.")

    try:
        while True:
            if not ensure_mt5():
                await websocket.send_text(json.dumps({"mt5_connected": False}))
                await asyncio.sleep(1.0)
                continue

            real_sym = resolve_symbol(symbol)
            mt5_tf = TIMEFRAME_MAP.get(tf.upper(), mt5.TIMEFRAME_M5)
            acc = mt5.account_info()
            tick = mt5.symbol_info_tick(real_sym)
            rates = mt5.copy_rates_from_pos(real_sym, mt5_tf, 0, 1)
            positions = mt5.positions_get()

            latest_candle, latest_vol = None, None
            if rates is not None and len(rates) > 0:
                r = rates[0]
                t = int(r["time"])
                o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
                latest_candle = {"time": t, "open": o, "high": h, "low": l, "close": c}
                latest_vol = {
                    "time": t,
                    "value": float(r["tick_volume"]),
                    "color": "rgba(0, 210, 106, 0.4)" if c >= o else "rgba(255, 59, 48, 0.4)"
                }

            tape_event = None
            if tick and tick.time_msc != last_tick_msc:
                last_tick_msc = tick.time_msc
                vol = float(tick.volume) if tick.volume > 0 else 1.0
                if tick.flags & mt5.TICK_FLAG_BUY:
                    side = "ASK"
                    buy_vol_total += vol
                    cvd += vol
                elif tick.flags & mt5.TICK_FLAG_SELL:
                    side = "BID"
                    sell_vol_total += vol
                    cvd -= vol
                else:
                    side = "MID"
                tape_event = {
                    "time": datetime.fromtimestamp(tick.time).strftime("%H:%M:%S"),
                    "price": tick.ask if side == "ASK" else tick.bid,
                    "vol": vol,
                    "side": side
                }

            if not quant_bot.enabled:
                quant_bot.symbol = real_sym
                quant_bot.timeframe = mt5_tf
            quant_bot.step(cvd=cvd)

            pos_list = []
            if positions:
                for p in positions:
                    pos_list.append({
                        "ticket": p.ticket,
                        "symbol": p.symbol,
                        "type": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
                        "volume": p.volume,
                        "open": p.price_open,
                        "sl": p.sl,
                        "tp": p.tp,
                        "profit": p.profit,
                        "source": "AI_BOT" if p.magic == 202688 else "MANUAL"
                    })

            payload = {
                "mt5_connected": True,
                "symbol": real_sym,
                "account": {
                    "login": acc.login if acc else 0,
                    "balance": acc.balance if acc else 0,
                    "equity": acc.equity if acc else 0,
                    "profit": acc.profit if acc else 0
                },
                "tick": {"bid": tick.bid, "ask": tick.ask} if tick else {"bid": 0, "ask": 0},
                "candle": latest_candle,
                "volume": latest_vol,
                "tape": tape_event,
                "orderflow": {
                    "cvd": round(cvd, 2),
                    "buy_vol": round(buy_vol_total, 2),
                    "sell_vol": round(sell_vol_total, 2)
                },
                "quant_desk": {
                    "bot_enabled": quant_bot.enabled,
                    "alpha": quant_bot.last_alpha,
                    "status": quant_bot.last_status,
                    "agent_chat": quant_bot.agent_chat[:25]
                },
                "positions": pos_list
            }
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        pass

@app.post("/api/order")
def place_order(req: OrderRequest):
    if not ensure_mt5():
        raise HTTPException(status_code=503, detail="MT5 chưa kết nối")
    real_sym = resolve_symbol(req.symbol)
    sym = mt5.symbol_info(real_sym)
    if not sym:
        raise HTTPException(status_code=404, detail="Mã không hợp lệ")

    volume = req.fixed_lot if req.fixed_lot > 0 else risk_manager.compute_position_size(real_sym, req.sl_points, req.risk_percent)
    tick = mt5.symbol_info_tick(real_sym)
    point = sym.point

    if req.order_type.upper() == "BUY":
        action_type = mt5.ORDER_TYPE_BUY
        price = tick.ask
        sl = price - req.sl_points * point if req.sl_points > 0 else 0.0
        tp = price + req.tp_points * point if req.tp_points > 0 else 0.0
    else:
        action_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
        sl = price + req.sl_points * point if req.sl_points > 0 else 0.0
        tp = price - req.tp_points * point if req.tp_points > 0 else 0.0

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": real_sym,
        "volume": volume,
        "type": action_type,
        "price": price,
        "sl": round(sl, sym.digits),
        "tp": round(tp, sym.digits),
        "deviation": 20,
        "magic": 202699,
        "comment": "NEXUS_MANUAL",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    res = mt5.order_send(request)
    if res.retcode != mt5.TRADE_RETCODE_DONE:
        request["type_filling"] = mt5.ORDER_FILLING_FOK
        res = mt5.order_send(request)

    if res.retcode != mt5.TRADE_RETCODE_DONE:
        return {"status": "ERR", "code": res.retcode, "msg": res.comment}
    quant_bot.push_chat("QUANT TRADER", "#ff9900", f"Lệnh thủ công #{res.order}: {req.order_type} {volume} lot {real_sym} @ {res.price}.")
    return {"status": "OK", "ticket": res.order, "vol": volume, "price": res.price}

@app.post("/api/breakeven/{ticket}")
def move_breakeven(ticket: int):
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    p = pos[0]
    res = mt5.order_send({
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": p.symbol,
        "position": p.ticket,
        "sl": p.price_open,
        "tp": p.tp
    })
    return {"status": "OK" if res.retcode == mt5.TRADE_RETCODE_DONE else "ERR"}

@app.post("/api/close/{ticket}")
def close_position(ticket: int):
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    p = pos[0]
    tick = mt5.symbol_info_tick(p.symbol)
    close_type = mt5.ORDER_TYPE_SELL if p.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if p.type == mt5.POSITION_TYPE_BUY else tick.ask

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": p.symbol,
        "volume": p.volume,
        "type": close_type,
        "position": p.ticket,
        "price": price,
        "deviation": 20,
        "magic": 202699,
        "comment": "NEXUS_CLOSE",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    res = mt5.order_send(req)
    if res.retcode != mt5.TRADE_RETCODE_DONE:
        req["type_filling"] = mt5.ORDER_FILLING_FOK
        res = mt5.order_send(req)
    return {"status": "OK" if res.retcode == mt5.TRADE_RETCODE_DONE else "ERR"}
