import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'host');

// Clean and recreate output directory
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. Bundle native host binary
const hostMjs = path.join(outDir, 'viddock-host.mjs');
await build({
  entryPoints: [path.join(root, 'packages/native-host/src/main.ts')],
  outfile: hostMjs,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
fs.chmodSync(hostMjs, 0o755);

// 2. Write package.json for module resolution
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify({ type: 'module', name: 'viddock-host' }, null, 2) + '\n',
);

// 3. Generate viddock-host-launcher.sh
const launcherPath = path.join(outDir, 'viddock-host-launcher.sh');
const launcherScript = `#!/bin/bash
# VidDock Native Host Launcher for macOS
# Ensures Node.js and FFmpeg are discoverable when Chrome launches the host from GUI context.
# NEVER write anything to stdout in this script. stdout is reserved for native messaging protocol frames.
set -e

# Resolve directory of this script (handling symlinks)
SOURCE="\${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"

# Candidate search paths for Node.js, ffmpeg, and ffprobe
EXTRA_PATHS=(
  "/opt/homebrew/bin"
  "/opt/homebrew/sbin"
  "/usr/local/bin"
  "/usr/local/sbin"
  "$HOME/.local/bin"
  "$HOME/.volta/bin"
  "$HOME/.asdf/shims"
  "$HOME/.fnm/current/bin"
)

# Detect highest installed NVM Node version
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM_NODE=$(ls -d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1)
  if [ -n "$LATEST_NVM_NODE" ] && [ -d "$LATEST_NVM_NODE/bin" ]; then
    EXTRA_PATHS+=("$LATEST_NVM_NODE/bin")
  fi
fi

# Prepend candidate directories to PATH
for p in "\${EXTRA_PATHS[@]}"; do
  if [ -d "$p" ]; then
    PATH="$p:$PATH"
  fi
done
export PATH

# Resolve Node.js binary
NODE_BIN=""
if [ -n "$VIDDOCK_NODE" ] && [ -x "$VIDDOCK_NODE" ]; then
  NODE_BIN="$VIDDOCK_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for candidate in "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "[viddock-host-launcher] Fatal error: Node.js runtime not found in PATH or standard locations." >&2
  echo "[viddock-host-launcher] Please install Node.js (>=20) or set VIDDOCK_NODE environment variable." >&2
  exit 1
fi

HOST_SCRIPT="$DIR/viddock-host.mjs"
if [ ! -f "$HOST_SCRIPT" ]; then
  echo "[viddock-host-launcher] Fatal error: Host script not found at $HOST_SCRIPT" >&2
  exit 1
fi

# Execute Node replacing shell process. Pass all arguments from Chrome.
exec "$NODE_BIN" "$HOST_SCRIPT" "$@"
`;

fs.writeFileSync(launcherPath, launcherScript, { mode: 0o755 });

// 4. Generate manifest template com.viddock.host.json
const manifestTemplate = {
  name: 'com.viddock.host',
  description: 'VidDock Native Companion Host',
  path: '__HOST_PATH__',
  type: 'stdio',
  allowed_origins: ['chrome-extension://__EXTENSION_ID__/'],
};
const manifestPath = path.join(outDir, 'com.viddock.host.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifestTemplate, null, 2) + '\n', { mode: 0o644 });

console.log('native host built ->', path.relative(root, outDir));
console.log('  - viddock-host.mjs (binary)');
console.log('  - viddock-host-launcher.sh (executable launcher)');
console.log('  - com.viddock.host.json (manifest template)');
