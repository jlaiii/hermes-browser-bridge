#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/jlaiii/hermes-browser-bridge"
INSTALL_DIR="${HOME}/.local/share/hermes-browser-bridge"
VENV_DIR="${INSTALL_DIR}/venv"

# Detect python3
if command -v python3 &>/dev/null; then
    PYTHON="python3"
elif command -v python &>/dev/null; then
    PYTHON="python"
else
    echo "[Hermes Bridge] python3 not found. Attempting to install..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y python3 python3-pip
    elif command -v pacman &>/dev/null; then
        sudo pacman -Sy --noconfirm python python-pip
    elif command -v brew &>/dev/null; then
        brew install python
    else
        echo "[Hermes Bridge] ERROR: Could not install python3 automatically. Please install it manually."
        exit 1
    fi
    PYTHON="python3"
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Clone or pull latest
cd "$INSTALL_DIR"
if [[ -d .git ]]; then
    git pull origin master
else
    git clone "$REPO_URL" .
fi

# Create venv if missing
if [[ ! -d "$VENV_DIR" ]]; then
    "$PYTHON" -m venv "$VENV_DIR"
fi

# Activate and install aiohttp
source "$VENV_DIR/bin/activate"
pip install --upgrade pip
pip install aiohttp

echo ""
echo "[Hermes Bridge] Installation complete. Starting relay..."
echo "[Hermes Bridge] Control+C to stop, or run:"
echo "    ${VENV_DIR}/bin/python3 ${INSTALL_DIR}/hermes-browser-relay.py"
echo ""

exec "${VENV_DIR}/bin/python3" "${INSTALL_DIR}/hermes-browser-relay.py"
