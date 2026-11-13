import json
import urllib.request
import numpy as np

COLAB_GPU_URL = ""

def set_colab_url(url: str):
    global COLAB_GPU_URL
    COLAB_GPU_URL = url.strip().rstrip("/")
    return COLAB_GPU_URL

def get_colab_url():
    return COLAB_GPU_URL

def _frac_diff(series, d=0.40, thresh=1e-3):
    weights = [1.0]
    k = 1
    while True:
        w = -weights[-1] * (d - k + 1) / k
        if abs(w) < thresh or k > 40:
            break
        weights.append(w)
        k += 1
    weights = np.array(weights[::-1])
    width = len(weights)
    out = np.zeros_like(series, dtype=np.float64)
    for i in range(width - 1, len(series)):
        out[i] = np.dot(weights, series[i - width + 1 : i + 1])
    out[:width - 1] = out[width - 1]
    return out

def _rolling_zscore(arr, win=48):
    out = np.zeros_like(arr, dtype=np.float64)
    for i in range(win, len(arr)):
        seg = arr[i - win : i + 1]
        out[i] = (arr[i] - np.mean(seg)) / (np.std(seg) + 1e-9)
    return out

def query_colab_gpu_prediction(rates):
    if not COLAB_GPU_URL or rates is None or len(rates) < 120:
        return None

    o = np.array([float(x['open']) for x in rates], dtype=np.float64)
    h = np.array([float(x['high']) for x in rates], dtype=np.float64)
    l = np.array([float(x['low']) for x in rates], dtype=np.float64)
    c = np.array([float(x['close']) for x in rates], dtype=np.float64)
    v = np.array([float(x['tick_volume']) for x in rates], dtype=np.float64)
    t = np.array([int(x['time']) for x in rates], dtype=np.int64)

    fd_z = np.clip(_rolling_zscore(_frac_diff(np.log(c + 1e-9), d=0.40), 60), -5, 5)
    ret_1 = np.clip(_rolling_zscore(np.diff(np.log(c + 1e-9), prepend=np.log(c[0])), 48), -5, 5)
    ret_4 = np.clip(_rolling_zscore(np.log((c + 1e-9) / (np.roll(c, 4) + 1e-9)), 48), -5, 5)
    ret_12 = np.clip(_rolling_zscore(np.log((c + 1e-9) / (np.roll(c, 12) + 1e-9)), 48), -5, 5)

    gk_var = 0.5 * (np.log((h + 1e-9) / (l + 1e-9)) ** 2) - (2 * np.log(2) - 1) * (np.log((c + 1e-9) / (o + 1e-9)) ** 2)
    gk_z = np.clip(_rolling_zscore(np.sqrt(np.maximum(gk_var, 1e-12)), 48), -5, 5)

    rng = (h - l) + 1e-9
    clv = ((c - l) / rng) * 2.0 - 1.0
    vol_z = np.clip(_rolling_zscore(np.log(v + 1.0), 48), -5, 5)
    signed_vol_z = np.clip(_rolling_zscore(clv * v, 48), -5, 5)

    upper_wick = (h - np.maximum(o, c)) / rng
    lower_wick = (np.minimum(o, c) - l) / rng

    hours = np.array([(ts % 86400) / 3600.0 for ts in t])
    sin_hour = np.sin(2 * np.pi * hours / 24.0)
    cos_hour = np.cos(2 * np.pi * hours / 24.0)

    feat_matrix = np.column_stack([
        fd_z, ret_1, ret_4, ret_12,
        gk_z, clv, vol_z, signed_vol_z,
        upper_wick, lower_wick, sin_hour, cos_hour
    ]).astype(np.float32)

    payload = json.dumps({"sequence": feat_matrix[-48:].tolist()}).encode("utf-8")
    req = urllib.request.Request(
        f"{COLAB_GPU_URL}/predict",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=3.5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"error": str(e)}
