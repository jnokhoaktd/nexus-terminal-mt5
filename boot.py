import os
import sys
import time
import socket
import subprocess
import webbrowser

os.chdir(r"D:\mt5-web-terminal")

def is_port_open(port=8000):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0

def open_app_window(url):
    # Tìm Edge hoặc Chrome để mở chế độ App không thanh địa chỉ
    browsers = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for b in browsers:
        if os.path.exists(b):
            subprocess.Popen([b, f"--app={url}"])
            return
    webbrowser.open(url)

if not is_port_open(8000):
    # Khởi chạy Uvicorn chạy ngầm (ẩn cửa sổ console bằng CREATE_NO_WINDOW)
    CREATE_NO_WINDOW = 0x08000000
    log_file = open("server_error.log", "w", encoding="utf-8")
    subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000"],
        stdout=log_file,
        stderr=log_file,
        creationflags=CREATE_NO_WINDOW
    )
    # Đợi tối đa 10 giây cho tới khi server mở cổng 8000 thành công
    for _ in range(30):
        if is_port_open(8000):
            break
        time.sleep(0.3)

if is_port_open(8000):
    open_app_window("http://127.0.0.1:8000")
else:
    # Nếu lỗi thật sự, mở file log lên cho người dùng thấy ngay nguyên nhân
    os.startfile("server_error.log")
