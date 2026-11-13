import os
import torch
import torch.nn as nn
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from pyngrok import ngrok, conf
from google.colab import drive

drive.mount('/content/drive', force_remount=False)
SAVE_DIR = "/content/drive/MyDrive/NEXUS_QUANT_MODELS"
os.makedirs(SAVE_DIR, exist_ok=True)
MODEL_PATH = os.path.join(SAVE_DIR, "deep_quant_net_v1.pt")

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

class DeepQuantNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Conv1d(in_channels=5, out_channels=32, kernel_size=3, padding=1)
        self.bn = nn.BatchNorm1d(32)
        self.act = nn.GELU()
        self.gru = nn.GRU(input_size=32, hidden_size=64, num_layers=2, batch_first=True, dropout=0.1)
        self.head = nn.Linear(64, 2)

    def forward(self, x):
        h = self.act(self.bn(self.conv(x.permute(0, 2, 1))))
        out, _ = self.gru(h.permute(0, 2, 1))
        return self.head(out[:, -1, :])

model = DeepQuantNet().to(device)
is_trained = False
last_train_acc = 0.0

if os.path.exists(MODEL_PATH):
    checkpoint = torch.load(MODEL_PATH, map_location=device)
    model.load_state_dict(checkpoint["state_dict"])
    is_trained = checkpoint.get("is_trained", True)
    last_train_acc = checkpoint.get("train_acc", 0.0)

app = FastAPI()

class TrainRequest(BaseModel):
    candles: list
    epochs: int = 25

class InferRequest(BaseModel):
    candles: list
    cvd: float = 0.0

def extract_features(candles: list):
    arr = np.array([[c["open"], c["high"], c["low"], c["close"], c.get("volume", 1.0)] for c in candles], dtype=np.float32)
    o, h, l, c, v = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]
    ret = np.diff(c, prepend=c[0]) / (c + 1e-6)
    hl_range = (h - l) / (c + 1e-6)
    close_pos = (c - l) / (h - l + 1e-6)
    vol_z = (v - np.mean(v)) / (np.std(v) + 1e-6)
    body = (c - o) / (h - l + 1e-6)
    return np.stack([ret * 100.0, hl_range * 100.0, close_pos, vol_z, body], axis=1), c

@app.get("/health")
def health():
    return {"status": "ONLINE", "gpu": str(device), "trained": is_trained, "acc": last_train_acc}

@app.post("/train")
def train_model(req: TrainRequest):
    global is_trained, last_train_acc
    feats, closes = extract_features(req.candles)
    seq_len = 24
    X, y_dir, y_ret = [], [], []
    for i in range(len(feats) - seq_len - 3):
        X.append(feats[i : i + seq_len])
        future_ret = (closes[i + seq_len + 2] - closes[i + seq_len - 1]) / (closes[i + seq_len - 1] + 1e-6)
        y_dir.append(1.0 if future_ret > 0 else 0.0)
        y_ret.append(abs(future_ret) * 100.0)

    X_t = torch.tensor(np.array(X), dtype=torch.float32).to(device)
    yd_t = torch.tensor(np.array(y_dir), dtype=torch.float32).to(device)
    yr_t = torch.tensor(np.array(y_ret), dtype=torch.float32).to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    bce, mse = nn.BCEWithLogitsLoss(), nn.MSELoss()

    model.train()
    for _ in range(req.epochs):
        optimizer.zero_grad()
        out = model(X_t)
        loss = bce(out[:, 0], yd_t) + 0.5 * mse(torch.abs(out[:, 1]), yr_t)
        loss.backward()
        optimizer.step()

    model.eval()
    with torch.no_grad():
        preds = (torch.sigmoid(model(X_t)[:, 0]) > 0.5).float()
        acc = float((preds == yd_t).float().mean().item() * 100.0)

    is_trained = True
    last_train_acc = round(acc, 1)
    torch.save({"state_dict": model.state_dict(), "is_trained": is_trained, "train_acc": last_train_acc}, MODEL_PATH)
    return {"status": "TRAINED", "samples": len(X), "accuracy": last_train_acc, "loss": round(float(loss.item()), 4)}

@app.post("/predict")
def predict(req: InferRequest):
    feats, closes = extract_features(req.candles)
    tensor_x = torch.tensor(feats[-24:], dtype=torch.float32).unsqueeze(0).to(device)
    model.eval()
    with torch.no_grad():
        logits = model(tensor_x)[0]
        prob_up = float(torch.sigmoid(logits[0]).item() * 100.0)
        exp_move = float(abs(logits[1].item()) * closes[-1] * 0.01)

    prob_down = round(100.0 - prob_up, 1)
    prob_up = round(prob_up, 1)
    regime = "DL_BULLISH_EDGE" if prob_up >= 58 else ("DL_BEARISH_EDGE" if prob_down >= 58 else "DL_NO_EDGE")
    return {"prob_up": prob_up, "prob_down": prob_down, "regime": regime, "expected_move_pts": round(exp_move, 2), "trained": is_trained, "train_acc": last_train_acc}

ngrok.kill()
pyngrok_config = conf.PyngrokConfig(auth_token="YOUR_NGROK_TOKEN")
public_url = ngrok.connect(8001, pyngrok_config=pyngrok_config).public_url
print(f"\n>>> COLAB GPU URL: {public_url}\n")

config = uvicorn.Config(app, host="0.0.0.0", port=8001, log_level="warning")
server = uvicorn.Server(config)
await server.serve()
