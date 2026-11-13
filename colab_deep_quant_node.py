# !pip install -q fastapi uvicorn pyngrok torch numpy nest-asyncio

import torch
import torch.nn as nn
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from pyngrok import ngrok, conf

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"[NEXUS COLAB NODE] Running on device: {device}")

class DeepQuantNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Conv1d(in_channels=4, out_channels=16, kernel_size=3, padding=1)
        self.relu = nn.GELU()
        self.gru = nn.GRU(input_size=16, hidden_size=32, batch_first=True)
        self.head = nn.Linear(32, 2)

    def forward(self, x):
        h = self.relu(self.conv(x.permute(0, 2, 1)))
        out, _ = self.gru(h.permute(0, 2, 1))
        return self.head(out[:, -1, :])

model = DeepQuantNet().to(device)
model.eval()

app = FastAPI()

class InferRequest(BaseModel):
    candles: list
    cvd: float = 0.0

@app.get("/health")
def health():
    return {"status": "ONLINE", "gpu": str(device)}

@app.post("/predict")
def predict(req: InferRequest):
    arr = np.array([[c["open"], c["high"], c["low"], c["close"]] for c in req.candles], dtype=np.float32)
    mean = arr.mean(axis=0, keepdims=True)
    std = arr.std(axis=0, keepdims=True) + 1e-6
    norm_arr = (arr - mean) / std

    tensor_x = torch.tensor(norm_arr).unsqueeze(0).to(device)
    with torch.no_grad():
        logits = model(tensor_x)[0]
        prob_up = float(torch.sigmoid(logits[0]).item() * 100.0)
        exp_move = float(abs(logits[1].item()) * std[0, 3] * 2.0)

    prob_down = round(100.0 - prob_up, 1)
    prob_up = round(prob_up, 1)
    regime = "DL_BULLISH_MOMENTUM" if prob_up > 55 else ("DL_BEARISH_PRESSURE" if prob_down > 55 else "DL_CONSOLIDATION")
    return {
        "prob_up": prob_up,
        "prob_down": prob_down,
        "regime": regime,
        "expected_move_pts": round(exp_move, 2)
    }

ngrok.kill()
pyngrok_config = conf.PyngrokConfig(auth_token="YOUR_NGROK_TOKEN")
public_url = ngrok.connect(8001, pyngrok_config=pyngrok_config).public_url
print(f"\n>>> COPY URL NAY DAN VAO O 'COLAB URL' TREN NEXUS TERMINAL: {public_url}\n")

config = uvicorn.Config(app, host="0.0.0.0", port=8001, log_level="info")
server = uvicorn.Server(config)
await server.serve()
