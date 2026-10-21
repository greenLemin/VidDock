#!/bin/bash
# VidDock Native Host macOS Uninstaller
# Removes com.viddock.host.json from all supported browser NativeMessagingHosts directories.

set -euo pipefail

DRY_RUN=false
KILL_PROCESSES=false
VERBOSE=false

print_usage() {
  cat <<EOF
VidDock Native Host macOS Uninstaller

Usage:
  ./scripts/uninstall-macos.sh [options]

Options:
  --dry-run       Preview manifest files to be deleted without removing them
  --kill          Terminate any active VidDock host processes
  -v, --verbose   Show detailed information for scanned paths
  -h, --help      Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --kill)
      KILL_PROCESSES=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

echo "============================================================"
echo "         VidDock Native Companion macOS Uninstaller        "
echo "============================================================"

CANDIDATE_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft/Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
)

REMOVED_COUNT=0

for dir in "${CANDIDATE_DIRS[@]}"; do
  manifest="$dir/com.viddock.host.json"
  if [ -f "$manifest" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "  [DRY-RUN] Would remove: $manifest"
      REMOVED_COUNT=$((REMOVED_COUNT + 1))
    else
      rm -f "$manifest"
      echo "  [✓] Removed: $manifest"
      REMOVED_COUNT=$((REMOVED_COUNT + 1))
    fi
  elif [ "$VERBOSE" = true ]; then
    echo "  [-] Not present: $manifest"
  fi
done

# Check for running host processes
RUNNING_PIDS=$(pgrep -f "viddock-host" 2>/dev/null || true)
if [ -n "$RUNNING_PIDS" ]; then
  echo ""
  if [ "$KILL_PROCESSES" = true ]; then
    echo "Terminating active VidDock host processes (PIDs: $RUNNING_PIDS)..."
    kill $RUNNING_PIDS 2>/dev/null || kill -9 $RUNNING_PIDS 2>/dev/null || true
    echo "  [✓] Host processes terminated."
  else
    echo "  [!] Notice: Active VidDock host process(es) detected (PID: $RUNNING_PIDS)."
    echo "      Run with --kill to terminate active host processes."
  fi
fi

echo "============================================================"
if [ "$DRY_RUN" = true ]; then
  echo "Dry-run complete. Found $REMOVED_COUNT manifest(s) eligible for removal."
elif [ "$REMOVED_COUNT" -gt 0 ]; then
  echo "VidDock Native Host companion successfully uninstalled ($REMOVED_COUNT manifest(s) removed)."
else
  echo "No VidDock native messaging manifests were found. Nothing to uninstall."
fi
echo "============================================================"
