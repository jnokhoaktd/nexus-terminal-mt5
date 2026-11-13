@echo off
title NEXUS TERMINAL - PHAT SONG CHO HOI NHOM (VIEW-ONLY)
echo Dang mo duong ham chia se NEXUS Terminal (Che do chi xem an toan)...
echo Copy duong link https://....lhr.life ben duoi gui cho anh em trong hoi!
echo (Nhan Ctrl+C hoac tat cua so nay de ngat chia se)
echo.
ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:8000 nokey@localhost.run
pause
