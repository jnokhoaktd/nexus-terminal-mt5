import asyncio
import json
from datetime import datetime
import MetaTrader5 as mt5
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from quant_modules.engine import run_vector_backtest

app = FastAPI(title="NEXUS INSTITUTIONAL // MT5 QUANT PLATFORM")

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

def calculate_lot_by_risk(symbol: str, risk_percent: float, sl_points: int) -> float:
    acc = mt5.account_info()
    sym = mt5.symbol_info(symbol)
    if not acc or not sym or sl_points <= 0:
        return sym.volume_min if sym else 0.01

    risk_money = acc.equity * (risk_percent / 100.0)
    tick_value = sym.trade_tick_value
    tick_size = sym.trade_tick_size
    if tick_value <= 0 or tick_size <= 0:
        return sym.volume_min

    point_value_per_lot = tick_value * (sym.point / tick_size)
    raw_lot = risk_money / (sl_points * point_value_per_lot)
    step = sym.volume_step
    lot = round(raw_lot / step) * step
    return round(max(sym.volume_min, min(sym.volume_max, lot)), 2)

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
        raise HTTPException(status_code=503, detail="MT5 chưa mở hoặc chưa đăng nhập")
    real_sym = resolve_symbol(symbol)
    mt5_tf = TIMEFRAME_MAP.get(tf.upper(), mt5.TIMEFRAME_M5)
    rates = mt5.copy_rates_from_pos(real_sym, mt5_tf, 0, count)
    if rates is None or len(rates) == 0:
        raise HTTPException(status_code=404, detail=f"Không có dữ liệu nến cho {real_sym}")

    candles = []
    volumes = []
    for r in rates:
        t = int(r["time"])
        o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        v = float(r["tick_volume"])
        candles.append({"time": t, "open": o, "high": h, "low": l, "close": c})
        volumes.append({
            "time": t,
            "value": v,
            "color": "rgba(0, 210, 106, 0.4)" if c >= o else "rgba(255, 59, 48, 0.4)"
        })
    return {"symbol": real_sym, "candles": candles, "volumes": volumes}

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
    cvd = 0.0
    buy_vol_total = 0.0
    sell_vol_total = 0.0

    try:
        while True:
            if not ensure_mt5():
                await websocket.send_text(json.dumps({"mt5_connected": False, "error": str(mt5.last_error())}))
                await asyncio.sleep(1.0)
                continue

            real_sym = resolve_symbol(symbol)
            mt5_tf = TIMEFRAME_MAP.get(tf.upper(), mt5.TIMEFRAME_M5)
            acc = mt5.account_info()
            tick = mt5.symbol_info_tick(real_sym)
            rates = mt5.copy_rates_from_pos(real_sym, mt5_tf, 0, 1)
            positions = mt5.positions_get()

            latest_candle = None
            latest_vol = None
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
                        "profit": p.profit
                    })

            payload = {
                "mt5_connected": True,
                "symbol": real_sym,
                "account": {
                    "login": acc.login if acc else 0,
                    "server": acc.server if acc else "",
                    "balance": acc.balance if acc else 0,
                    "equity": acc.equity if acc else 0,
                    "profit": acc.profit if acc else 0,
                    "margin_free": acc.margin_free if acc else 0
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

    volume = req.fixed_lot if req.fixed_lot > 0 else calculate_lot_by_risk(real_sym, req.risk_percent, req.sl_points)
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
        "comment": "NEXUS_INST_EXEC",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    res = mt5.order_send(request)
    if res.retcode != mt5.TRADE_RETCODE_DONE:
        request["type_filling"] = mt5.ORDER_FILLING_FOK
        res = mt5.order_send(request)

    if res.retcode != mt5.TRADE_RETCODE_DONE:
        return {"status": "ERR", "code": res.retcode, "msg": res.comment}
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
