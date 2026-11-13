@echo off
cd /d D:\mt5-web-terminal
start "" "index.html"
uvicorn main:app --host 127.0.0.1 --port 8000
