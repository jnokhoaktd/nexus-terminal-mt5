@echo off
title NEXUS TERMINAL - PHAT SONG CHO HOI NHOM (VIEW-ONLY)
echo Dang khoi tao duong ham chia se NEXUS Terminal (Che do chi xem an toan)...
echo Gui duong link https://....ngrok-free.dev ben duoi cho anh em trong hoi!
echo (Nhan Ctrl+C hoac tat cua so nay de ngat chia se bat cu luc nao)
echo.
python -c "from pyngrok import ngrok, conf; conf.get_default().auth_token='3M4At5iaAqwUbuINynB3MesmOoA_65dTt8pLFE7jGtoah9gyU'; print('>>> LINK GUI ANH EM:', ngrok.connect(8000).public_url); input('Nhan Enter de tat phat song...')"
