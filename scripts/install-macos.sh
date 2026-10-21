#!/bin/bash
# VidDock Native Host macOS Installer
# Registers com.viddock.host.json in Chrome and Chromium-based browser NativeMessagingHosts directories.

set -euo pipefail

SCRIPT_DIR="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

EXTENSION_ID=""
EXTENSION_ID_SPECIFIED=false
CUSTOM_LAUNCHER=""
ALL_BROWSERS=false
DRY_RUN=false
FORCE=false

print_usage() {
  cat <<EOF
VidDock Native Host macOS Installer

Usage:
  ./scripts/install-macos.sh [options] [EXTENSION_ID]

Options:
  --extension-id <ID>  Chrome extension ID (32 lowercase letters a-p)
  --launcher <PATH>    Path to viddock-host-launcher.sh
  --all-browsers       Register for Chrome, Canary, Chromium, Brave, and Edge
  --dry-run            Simulate installation without writing any files
  --force              Overwrite existing manifest files silently
  -h, --help           Show this help message

Examples:
  ./scripts/install-macos.sh
  ./scripts/install-macos.sh pknljchblnkgfmfcfdfkddedjofmjbkj
  ./scripts/install-macos.sh --extension-id pknljchblnkgfmfcfdfkddedjofmjbkj --all-browsers
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="$2"
      EXTENSION_ID_SPECIFIED=true
      shift 2
      ;;
    --extension-id=*)
      EXTENSION_ID="${1#*=}"
      EXTENSION_ID_SPECIFIED=true
      shift
      ;;
    --launcher)
      CUSTOM_LAUNCHER="$2"
      shift 2
      ;;
    --launcher=*)
      CUSTOM_LAUNCHER="${1#*=}"
      shift
      ;;
    --all-browsers)
      ALL_BROWSERS=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    -*)
      echo "Error: Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
    *)
      if [ "$EXTENSION_ID_SPECIFIED" = false ]; then
        EXTENSION_ID="$1"
        EXTENSION_ID_SPECIFIED=true
      fi
      shift
      ;;
  esac
done

echo "============================================================"
echo "          VidDock Native Companion macOS Installer         "
echo "============================================================"

# 1. Resolve host launcher script
LAUNCHER_PATH=""
if [ -n "$CUSTOM_LAUNCHER" ]; then
  if [ -f "$CUSTOM_LAUNCHER" ]; then
    LAUNCHER_PATH="$(cd "$(dirname "$CUSTOM_LAUNCHER")" && pwd -P)/$(basename "$CUSTOM_LAUNCHER")"
  else
    echo "Error: Specified launcher not found at $CUSTOM_LAUNCHER" >&2
    exit 1
  fi
elif [ -f "$REPO_ROOT/dist/host/viddock-host-launcher.sh" ]; then
  LAUNCHER_PATH="$REPO_ROOT/dist/host/viddock-host-launcher.sh"
elif [ -f "$SCRIPT_DIR/dist/host/viddock-host-launcher.sh" ]; then
  LAUNCHER_PATH="$(cd "$SCRIPT_DIR/dist/host" && pwd -P)/viddock-host-launcher.sh"
elif [ -f "$SCRIPT_DIR/viddock-host-launcher.sh" ]; then
  LAUNCHER_PATH="$SCRIPT_DIR/viddock-host-launcher.sh"
elif [ -f "$REPO_ROOT/scripts/build-host.mjs" ]; then
  echo "Host launcher not found. Building host via npm run build:host..."
  (cd "$REPO_ROOT" && npm run build:host)
  LAUNCHER_PATH="$REPO_ROOT/dist/host/viddock-host-launcher.sh"
fi

if [ -z "$LAUNCHER_PATH" ] || [ ! -f "$LAUNCHER_PATH" ]; then
  echo "Error: Could not locate viddock-host-launcher.sh." >&2
  echo "Please build the native host first by running: npm run build:host" >&2
  exit 1
fi

chmod +x "$LAUNCHER_PATH"
HOST_DIR="$(dirname "$LAUNCHER_PATH")"
if [ -f "$HOST_DIR/viddock-host.mjs" ]; then
  chmod +x "$HOST_DIR/viddock-host.mjs"
fi

echo "[1/4] Native Host Launcher located:"
echo "      $LAUNCHER_PATH"

# Copy host files to persistent Application Support directory to avoid macOS TCC and quarantine issues
INSTALL_HOST_DIR="$HOME/Library/Application Support/VidDock/host"
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$INSTALL_HOST_DIR"
  cp -f "$HOST_DIR/viddock-host-launcher.sh" "$INSTALL_HOST_DIR/"
  cp -f "$HOST_DIR/viddock-host.mjs" "$INSTALL_HOST_DIR/"
  if [ -f "$HOST_DIR/package.json" ]; then
    cp -f "$HOST_DIR/package.json" "$INSTALL_HOST_DIR/"
  fi
  chmod +x "$INSTALL_HOST_DIR/viddock-host-launcher.sh" "$INSTALL_HOST_DIR/viddock-host.mjs"
  xattr -c "$INSTALL_HOST_DIR"/* 2>/dev/null || true
  LAUNCHER_PATH="$INSTALL_HOST_DIR/viddock-host-launcher.sh"
  HOST_DIR="$INSTALL_HOST_DIR"
fi

# 2. Resolve Extension ID
FALLBACK_ID="pknljchblnkgfmfcfdfkddedjofmjbkj"
DETECTED_ID=""

if [ "$EXTENSION_ID_SPECIFIED" = true ]; then
  if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    echo "Error: Extension ID '$EXTENSION_ID' is invalid. Must be exactly 32 lowercase letters matching [a-p]." >&2
    exit 1
  fi
  TARGET_EXTENSION_ID="$EXTENSION_ID"
  echo "[2/4] Using specified Extension ID: $TARGET_EXTENSION_ID"
else
  # Attempt auto-detection from Chrome Preferences
  CHROME_PREF_DIR="$HOME/Library/Application Support/Google/Chrome"
  if [ -d "$CHROME_PREF_DIR" ]; then
    DETECTED_ID=$(grep -Eroh '"[a-p]{32}":\{"manifest":\{[^}]*"name":"VidDock"' "$CHROME_PREF_DIR" 2>/dev/null | grep -Eo '[a-p]{32}' | head -n 1 || true)
  fi

  if [ -n "$DETECTED_ID" ] && [[ "$DETECTED_ID" =~ ^[a-p]{32}$ ]]; then
    TARGET_EXTENSION_ID="$DETECTED_ID"
    echo "[2/4] Auto-detected installed VidDock Extension ID: $TARGET_EXTENSION_ID"
  else
    TARGET_EXTENSION_ID="$FALLBACK_ID"
    echo "[2/4] No Extension ID provided or auto-detected."
    echo "      Using development fallback ID: $TARGET_EXTENSION_ID"
    echo "      (You can update this anytime with: ./scripts/install-macos.sh <YOUR_EXTENSION_ID>)"
  fi
fi

# 3. Verify runtime dependencies (Node.js and FFmpeg)
echo "[3/4] Verifying system runtime and dependencies..."

EXTRA_SEARCH_PATHS=(
  "/opt/homebrew/bin"
  "/opt/homebrew/sbin"
  "/usr/local/bin"
  "/usr/local/sbin"
  "$HOME/.local/bin"
  "$HOME/.volta/bin"
  "$HOME/.asdf/shims"
  "$HOME/.fnm/current/bin"
)
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM=$(ls -d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1)
  if [ -n "$LATEST_NVM" ] && [ -d "$LATEST_NVM/bin" ]; then
    EXTRA_SEARCH_PATHS+=("$LATEST_NVM/bin")
  fi
fi

SEARCH_PATH="$PATH"
for p in "${EXTRA_SEARCH_PATHS[@]}"; do
  if [ -d "$p" ]; then
    SEARCH_PATH="$p:$SEARCH_PATH"
  fi
done

NODE_BIN=$(PATH="$SEARCH_PATH" which node 2>/dev/null || true)
if [ -n "$NODE_BIN" ]; then
  NODE_VER=$("$NODE_BIN" -v 2>/dev/null || echo "unknown")
  NODE_MAJOR=$(echo "$NODE_VER" | sed -E 's/^v([0-9]+).*/\1/')
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    echo "      [✓] Node.js: $NODE_BIN ($NODE_VER)"
  else
    echo "      [!] Warning: Node.js version is $NODE_VER (< 20). VidDock requires Node.js >= 20." >&2
  fi
else
  echo "      [✗] Error: Node.js (>=20) runtime not found. Install via: brew install node" >&2
fi

FFMPEG_BIN=$(PATH="$SEARCH_PATH" which ffmpeg 2>/dev/null || true)
if [ -n "$FFMPEG_BIN" ]; then
  FFMPEG_VER=$("$FFMPEG_BIN" -version 2>/dev/null | head -n 1 || echo "unknown")
  echo "      [✓] FFmpeg:  $FFMPEG_BIN ($FFMPEG_VER)"
else
  echo "      [!] Note: FFmpeg not detected. Stream remuxing requires FFmpeg: brew install ffmpeg"
fi

FFPROBE_BIN=$(PATH="$SEARCH_PATH" which ffprobe 2>/dev/null || true)
if [ -n "$FFPROBE_BIN" ]; then
  FFPROBE_VER=$("$FFPROBE_BIN" -version 2>/dev/null | head -n 1 || echo "unknown")
  echo "      [✓] FFprobe: $FFPROBE_BIN ($FFPROBE_VER)"
fi

# Live handshake probe test
if [ -n "$NODE_BIN" ] && [ -f "$LAUNCHER_PATH" ]; then
  PROBE_RESULT=$("$NODE_BIN" -e '
    const cp = require("child_process");
    const p = cp.spawn(process.argv[1]);
    const msg = Buffer.from(JSON.stringify({ id: "install-probe", type: "hello" }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(msg.length, 0);
    p.stdin.write(Buffer.concat([len, msg]));
    p.stdout.on("data", (d) => {
      if (d.length >= 4) {
        const l = d.readUInt32LE(0);
        const data = JSON.parse(d.slice(4, 4 + l).toString("utf8"));
        if (data.ok) {
          console.log("PROBE_OK:protocol=" + data.data.protocol + ",platform=" + data.data.platform);
        }
        p.kill();
      }
    });
  ' "$LAUNCHER_PATH" 2>/dev/null || true)

  if [[ "$PROBE_RESULT" == *"PROBE_OK"* ]]; then
    echo "      [✓] Live stdio host handshake probe succeeded."
  fi
fi

# 4. Target NativeMessagingHosts directories
echo "[4/4] Registering Native Messaging Host manifests..."

TARGET_DIRS=()

# Google Chrome (always included)
TARGET_DIRS+=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts")

# Google Chrome Canary
if [ -d "$HOME/Library/Application Support/Google/Chrome Canary" ] || [ "$ALL_BROWSERS" = true ]; then
  TARGET_DIRS+=("$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts")
fi

# Chromium
if [ -d "$HOME/Library/Application Support/Chromium" ] || [ "$ALL_BROWSERS" = true ]; then
  TARGET_DIRS+=("$HOME/Library/Application Support/Chromium/NativeMessagingHosts")
fi

# Brave Browser
if [ -d "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" ] || [ "$ALL_BROWSERS" = true ]; then
  TARGET_DIRS+=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts")
fi

# Microsoft Edge
if [ -d "$HOME/Library/Application Support/Microsoft Edge" ] || [ "$ALL_BROWSERS" = true ]; then
  TARGET_DIRS+=("$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts")
fi

# Verify target extension ID before manifest construction
if [[ ! "$TARGET_EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: Target Extension ID '$TARGET_EXTENSION_ID' is invalid. Must be exactly 32 lowercase letters matching [a-p]." >&2
  exit 1
fi

# Escape launcher path for safe JSON inclusion
ESCAPED_LAUNCHER_PATH="${LAUNCHER_PATH//\\/\\\\}"
ESCAPED_LAUNCHER_PATH="${ESCAPED_LAUNCHER_PATH//\"/\\\"}"

# Format JSON manifest
MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "com.viddock.host",
  "description": "VidDock Native Companion Host",
  "path": "$ESCAPED_LAUNCHER_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$TARGET_EXTENSION_ID/"
  ]
}
EOF
)

# Verify generated manifest is valid JSON if node is present
if [ -n "$NODE_BIN" ]; then
  if ! "$NODE_BIN" -e 'JSON.parse(process.argv[1])' "$MANIFEST_CONTENT" >/dev/null 2>&1; then
    echo "Error: Generated manifest content is not valid JSON." >&2
    exit 1
  fi
fi

INSTALLED_COUNT=0
for dir in "${TARGET_DIRS[@]}"; do
  manifest_file="$dir/com.viddock.host.json"
  if [ "$DRY_RUN" = true ]; then
    echo "      [DRY-RUN] Would create: $manifest_file"
  else
    if mkdir -p "$dir" 2>/dev/null; then
      printf '%s\n' "$MANIFEST_CONTENT" > "$manifest_file"
      chmod 644 "$manifest_file"
      echo "      [✓] Installed: $manifest_file"
      INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
    else
      echo "      [!] Skipped (cannot create directory): $dir"
    fi
  fi
done

echo "============================================================"
if [ "$DRY_RUN" = true ]; then
  echo "Dry-run complete. No files were modified."
else
  echo "VidDock Native Host companion installed successfully ($INSTALLED_COUNT manifest(s) written)."
  echo "Extension Origin: chrome-extension://$TARGET_EXTENSION_ID/"
  echo "Launcher Path:    $LAUNCHER_PATH"
fi
echo "============================================================"
