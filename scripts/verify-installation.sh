#!/bin/bash
# VidDock Installation & Health Verification Tool
# Checks Node.js, FFmpeg/ffprobe, Native Messaging manifest, launcher permissions, and stdio handshake.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED=0
WARNINGS=0
FAILED=0

echo -e "${BLUE}=== VidDock Installation & Verification Checklist ===${NC}"
echo ""

check_pass() {
  echo -e "  [${GREEN}PASS${NC}] $1"
  PASSED=$((PASSED + 1))
}

check_warn() {
  echo -e "  [${YELLOW}WARN${NC}] $1"
  WARNINGS=$((WARNINGS + 1))
}

check_fail() {
  echo -e "  [${RED}FAIL${NC}] $1"
  FAILED=$((FAILED + 1))
}

# 1. Operating System & Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"
if [[ "$OS" == "Darwin" ]]; then
  check_pass "Operating system: macOS ($ARCH)"
else
  check_warn "Operating system: $OS ($ARCH) - Note: VidDock is optimized primarily for macOS"
fi

# 2. Node.js Environment
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"
  NODE_MAJOR="$(echo "$NODE_VER" | tr -d 'v' | cut -d'.' -f1)"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    check_pass "Node.js runtime: $NODE_VER (>= v20 required)"
  else
    check_warn "Node.js runtime: $NODE_VER (Node >= v20 recommended)"
  fi
else
  check_fail "Node.js runtime is NOT found on PATH"
fi

# 3. FFmpeg and ffprobe
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_PATH="$(command -v ffmpeg)"
  check_pass "FFmpeg installed: $FFMPEG_PATH"
else
  check_fail "FFmpeg NOT found on PATH. Install via: brew install ffmpeg"
fi

if command -v ffprobe >/dev/null 2>&1; then
  FFPROBE_PATH="$(command -v ffprobe)"
  check_pass "ffprobe installed: $FFPROBE_PATH"
else
  check_fail "ffprobe NOT found on PATH. Install via: brew install ffmpeg"
fi

# 4. Chrome Native Messaging Host Registration
CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$CHROME_NM_DIR/com.viddock.host.json"

if [[ -f "$MANIFEST_PATH" ]]; then
  check_pass "Chrome NativeMessaging manifest found: $MANIFEST_PATH"
  
  # Check JSON syntax and launcher path
  if command -v node >/dev/null 2>&1; then
    LAUNCHER_PATH="$(node -e "try { const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log(m.path || ''); } catch(e){}" "$MANIFEST_PATH")"
    if [[ -n "$LAUNCHER_PATH" && -f "$LAUNCHER_PATH" ]]; then
      if [[ -x "$LAUNCHER_PATH" ]]; then
        check_pass "Host launcher exists and is executable: $LAUNCHER_PATH"
        
        # 5. Live Stdio Handshake
        HANDSHAKE_OK=false
        RESPONSE="$(node -e '
          const { spawn } = require("child_process");
          const p = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "inherit"] });
          const msg = Buffer.from(JSON.stringify({ id: "verify-1", type: "hello" }));
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32LE(msg.length, 0);
          p.stdin.write(lenBuf);
          p.stdin.write(msg);
          
          let buf = Buffer.alloc(0);
          p.stdout.on("data", (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length >= 4) {
              const resLen = buf.readUInt32LE(0);
              if (buf.length >= 4 + resLen) {
                const resJson = JSON.parse(buf.slice(4, 4 + resLen).toString("utf8"));
                console.log(JSON.stringify(resJson));
                p.kill();
              }
            }
          });
          setTimeout(() => { p.kill(); process.exit(0); }, 3000);
        ' "$LAUNCHER_PATH" 2>/dev/null || true)"
        
        if echo "$RESPONSE" | grep -q '"ok":true'; then
          check_pass "Live stdio handshake successful: $RESPONSE"
        else
          check_warn "Handshake returned unexpected output: $RESPONSE"
        fi
      else
        check_fail "Host launcher is NOT executable (chmod +x needed): $LAUNCHER_PATH"
      fi
    else
      check_fail "Launcher path declared in manifest does not exist: $LAUNCHER_PATH"
    fi
  fi
else
  check_warn "Chrome NativeMessaging manifest NOT registered at $MANIFEST_PATH"
  echo -e "       ${YELLOW}Run './scripts/install-macos.sh' to register the companion host.${NC}"
fi

# 6. Built Extension Artifacts
SCRIPT_DIR="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

if [[ -f "$REPO_ROOT/apps/extension/dist/manifest.json" && -f "$REPO_ROOT/apps/extension/dist/background.js" ]]; then
  check_pass "Chrome unpacked extension bundle built: $REPO_ROOT/apps/extension/dist/"
else
  check_warn "Extension bundle not yet built. Run 'npm run build:extension'"
fi

echo ""
echo -e "${BLUE}=== Summary: ${GREEN}$PASSED Passed${NC}, ${YELLOW}$WARNINGS Warnings${NC}, ${RED}$FAILED Failed${NC} ===${NC}"

if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}All critical installation checks passed! VidDock is ready for use.${NC}"
  exit 0
else
  echo -e "${RED}One or more critical checks failed. Please address the errors above.${NC}"
  exit 1
fi
