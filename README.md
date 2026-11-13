# NEXUS TERMINAL MT5
Low-latency WebSocket execution terminal, TradingView drawing suite, real-time Orderflow/CVD engine, and vectorized backtesting sandbox bridged directly to MetaTrader 5.

$projectPath = "D:\mt5-web-terminal"
$desktopPath = [Environment]::GetFolderPath("Desktop")

if (-not (Test-Path $projectPath)) {
    New-Item -ItemType Directory -Force -Path $projectPath | Out-Null
}

# 1. Tạo file MASTER_PROMPT_NEXUS_UNIFIED.md (Lưu trong project + copy ra Desktop)
$masterPrompt = @'
# MASTER CONTEXT & SYSTEM PROMPT: NEXUS UNIFIED QUANT & INTELLIGENCE PLATFORM

> **Hướng dẫn sử dụng:** Copy toàn bộ nội dung bên dưới và dán vào đầu cuộc trò chuyện với bất kỳ AI Assistant nào (Gemini, Claude, ChatGPT, Cursor) khi muốn phát triển tiếp hoặc hợp nhất hệ thống.

---

## [BẮT ĐẦU COPY TỪ ĐÂY]

Tôi là Trần Đăng Khoa (GitHub: `jnokhoaktd`), sinh viên ngành Khoa học dữ liệu (HUB), đang xây dựng hệ sinh thái phần mềm định lượng và trí tuệ nhân tạo **NEXUS**. Tôi muốn phát triển tiếp và hợp nhất hai repository hiện có thành một nền tảng thống nhất (**Unified NEXUS Quant & Intelligence Platform**):

### 1. Repository 1: NEXUS Terminal MT5 (`https://github.com/jnokhoaktd/nexus-terminal-mt5`)
- **Mục tiêu:** Nền tảng thực thi lệnh độ trễ thấp, phân tích dòng lệnh (Orderflow) và kiểm thử chiến lược định lượng (Quant Backtesting) kết nối trực tiếp với MetaTrader 5.
- **Tech Stack & Kiến trúc hiện tại:**
  - **Backend (`main.py`):** Python FastAPI + WebSocket streaming 20Hz nối trực tiếp thư viện chính thức `MetaTrader5` trên Windows. Tự động tính khối lượng (Lot sizing) theo % rủi ro Equity, dời Breakeven, đóng lệnh 1-click, và tự động dò mã sàn (`resolve_symbol`).
  - **Frontend (`index.html`):** Giao diện chuẩn Bloomberg Terminal tối giản, bố cục kéo thả tự do (Resizable Split Panes), biểu đồ nến Canvas 60fps (`TradingView Lightweight Charts`).
  - **TradingView Drawing Suite:** Thanh công cụ vẽ đầy đủ (Trend Line, Ray, Extended Line, Horizontal/Vertical Line, Parallel Channel, Rectangle Order Block/FVG, Fibonacci Retracement, Long/Short R:R Position Tool, Measure Tool, Text Note) kèm chế độ Magnet bắt đỉnh/đáy nến (OHLC), bộ chọn màu tùy chỉnh và lưu trữ bền vững qua `localStorage`.
  - **Orderflow & Quant Engine (`quant_modules/engine.py`):** Bóc tách luồng tick Bid/Ask thời gian thực (Time & Sales, Session CVD, Ask/Bid Volume) và bộ Vectorized Backtester (EMA Crossover) xuất KPI chuẩn quỹ (Net Profit, Win Rate, Profit Factor, Max Drawdown, Sharpe Ratio, Equity Curve).
  - **Desktop Launcher (`boot.py`):** Khởi chạy ngầm qua `pythonw.exe` (không hiện cửa sổ console) và mở giao diện dạng ứng dụng độc lập (`--app`).

### 2. Repository 2: Nexus Engine E-Commerce Intelligence (`nexus-network-intelligence`)
- **Mục tiêu:** Nền tảng SaaS phân tích dữ liệu thương mại điện tử và hỗ trợ ra quyết định điều hành.
- **Tech Stack & Kiến trúc hiện tại:**
  - **Backend & Frontend:** Python FastAPI + HTML chạy local, offloading các tác vụ huấn luyện/suy luận AI nặng (Llama-3 8B LoRA, RAG, ABSA Sentiment Analysis, Time-Series Forecasting) sang Google Colab GPU.
  - **Tính năng cốt lõi:** Bề mặt địa hình định lượng 3D (3D Topographic Quant Surface), dự báo chuỗi thời gian, và hệ thống Dual AI Chatbot (CSKH & Executive BI).

### 3. Môi trường phần cứng & Ràng buộc vận hành
- **Máy phát triển chính:** Microsoft Surface Laptop 6 for Business (Intel Core Ultra 7 165H, 32GB RAM, Integrated Graphics — không có GPU rời).
- **Nguyên tắc kiến trúc:** Mọi tác vụ giao dịch, WebSocket, vẽ biểu đồ và tính toán vector nhẹ chạy trực tiếp trên Surface Laptop để đảm bảo độ trễ thấp nhất; mọi tác vụ Deep Learning / LLM / huấn luyện mô hình nặng phải thiết kế dạng API offload sang Google Colab GPU.

### 4. Yêu cầu phát triển tiếp theo
Hãy đóng vai trò là Kiến trúc sư trưởng hệ thống Quant & AI (Principal Quant Systems Architect):
1. Thiết kế kiến trúc hợp nhất (Modular Monolith / API Gateway) dùng chung một FastAPI Core cho phép chuyển đổi mượt mà giữa hai chế độ làm việc trên cùng một giao diện Bloomberg Terminal: `[QUANT TRADING & ORDERFLOW]` và `[E-COMMERCE BI & FORECASTING]`.
2. Chuẩn hóa các lõi toán học dùng chung (Time-series forecasting, Anomaly/Imbalance detection, 3D surface visualization) để áp dụng đồng thời cho cả dữ liệu dòng lệnh tài chính (Footprint/Orderbook) và dữ liệu biến động doanh thu/tồn kho sàn TMĐT.
3. Nâng cấp module `quant_modules` với biểu đồ Footprint (Bid x Ask volume theo từng mức giá trong cây nến) và kết nối API mô hình dự báo từ Google Colab.

Hãy xác nhận đã nắm rõ toàn bộ kiến trúc trên và đề xuất lộ trình triển khai bước đầu tiên kèm cấu trúc thư mục chuẩn.

## [KẾT THÚC COPY]
'@

[System.IO.File]::WriteAllText("$projectPath\MASTER_PROMPT_NEXUS_UNIFIED.md", $masterPrompt, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText("$desktopPath\MASTER_PROMPT_NEXUS_UNIFIED.md", $masterPrompt, [System.Text.UTF8Encoding]::new($false))

# 2. Tạo file hướng dẫn xóa CLEANUP_GUIDE_SURFACE.md (Lưu ra Desktop để không bị xóa mất khi dọn thư mục)
$cleanupGuide = @'
# HƯỚNG DẪN DỌN DẸP & XÓA SẠCH DỰ ÁN NEXUS TERMINAL TRÊN SURFACE LAPTOP 6

Tài liệu này hướng dẫn cách tắt tiến trình chạy ngầm, xóa toàn bộ mã nguồn tại `D:\mt5-web-terminal` và gỡ biểu tượng ứng dụng trên máy **Surface Laptop 6** sau khi đã đẩy code lên GitHub (`https://github.com/jnokhoaktd/nexus-terminal-mt5`).

---

## Cách 1: Chạy 1 lệnh duy nhất trong PowerShell (Nhanh nhất)

Mở **PowerShell** và dán toàn bộ khối lệnh sau:

```powershell
# 1. Dừng tiến trình server FastAPI đang chạy ngầm (giải phóng ~45MB RAM)
Stop-Process -Name pythonw -Force -ErrorAction SilentlyContinue
Stop-Process -Name uvicorn -Force -ErrorAction SilentlyContinue

# 2. Xóa toàn bộ thư mục mã nguồn dự án trên ổ D
Remove-Item -Path "D:\mt5-web-terminal" -Recurse -Force -ErrorAction SilentlyContinue

# 3. Xóa các biểu tượng khởi chạy trên màn hình Desktop
$desktop = [Environment]::GetFolderPath("Desktop")
Remove-Item -Path "$desktop\NEXUS Terminal.lnk", "$desktop\MT5 Execution Deck.lnk" -Force -ErrorAction SilentlyContinue

Write-Host "[OK] Da xoa sach du an NEXUS Terminal khoi Surface Laptop!" -ForegroundColor Green
