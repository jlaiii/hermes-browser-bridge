@echo off
setlocal EnableDelayedExpansion

echo [Hermes Bridge] Setting up Hermes Browser Bridge relay...

set REPO_URL=https://github.com/jlaiii/hermes-browser-bridge.git
set INSTALL_DIR=%LOCALAPPDATA%\HermesBrowserBridge
set VENV_DIR=%INSTALL_DIR%\venv

:: Try to find python3 / python
set "PYTHON="
for %%P in (python.exe python3.exe py.exe) do (
    if not defined PYTHON (
        where /Q %%P 2>nul
        if !ERRORLEVEL! == 0 (
            for /f "delims=" %%I in ('where %%P') do (
                set PYTHON=%%I
            )
        )
    )
)

if not defined PYTHON (
    echo [Hermes Bridge] Python not found. Trying to use Windows Store Python...
    :: python from Windows Store may be available as python but missing from early PATH
    set "PYTHON=python.exe"
    where /Q python.exe
    if !ERRORLEVEL! neq 0 (
        echo [Hermes Bridge] ERROR: Could not find any Python installation.
        echo Please install Python 3 from https://www.python.org/downloads/ or the Microsoft Store.
        pause
        exit /b 1
    )
)

echo [Hermes Bridge] Using Python: %PYTHON%

:: Clone or pull
if not exist "%INSTALL_DIR%" (
    mkdir "%INSTALL_DIR%"
    git clone "%REPO_URL%" "%INSTALL_DIR%"
) else (
    cd /d "%INSTALL_DIR%"
    git pull origin master
)

:: Create venv if missing
if not exist "%VENV_DIR%\Scripts\python.exe" (
    "%PYTHON%" -m venv "%VENV_DIR%"
)

:: Activate venv and install aiohttp
set "ACTIVATE=%VENV_DIR%\Scripts\activate.bat"
call "%ACTIVATE%"
python -m pip install --upgrade pip
python -m pip install aiohttp

echo.
echo [Hermes Bridge] Installation complete. Starting relay...
echo.

:: Start relay
python "%INSTALL_DIR%\hermes-browser-relay.py"

pause
