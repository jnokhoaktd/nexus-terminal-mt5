@echo off
title NEXUS TERMINAL - CLOUDFLARE BROADCAST (VIEW-ONLY)
echo Dang khoi tao duong ham Cloudflare cho NEXUS Terminal...
echo Tim dong co duoi https://....trycloudflare.com ben duoi va gui cho anh em!
echo (Nhan Ctrl+C hoac tat cua so nay de ngat phat song)
echo.
"%~dp0cloudflared.exe" tunnel --url http://127.0.0.1:8000
pause
