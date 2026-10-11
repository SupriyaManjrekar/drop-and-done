@echo off
:: Drop & Done with a Gemini API key. Needs a JDK 8+ and Python 3.8+.
::   set GEMINI_API_KEY=...
::   run-gemini.bat
setlocal
if "%GEMINI_API_KEY%"=="" (
  echo Set GEMINI_API_KEY first ^(get one at https://aistudio.google.com/apikey^).
  exit /b 1
)
if "%BRIDGE_PORT%"=="" set BRIDGE_PORT=8788
start "Drop and Done - Gemini bridge" /min python "%~dp0server\gemini_bridge.py"
timeout /t 2 /nobreak >nul
set ANTHROPIC_URL=http://127.0.0.1:%BRIDGE_PORT%/v1/messages
set ANTHROPIC_API_KEY=gemini-bridge
call "%~dp0run.bat"
