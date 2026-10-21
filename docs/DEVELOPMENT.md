# VidDock Development Guide

This guide covers everything developers need to know to set up, build, test, and package VidDock locally.

---

## 1. Prerequisites & Environment Setup

To develop VidDock, your machine should meet the following requirements:

- **macOS:** macOS 12 (Monterey) or higher (Apple Silicon or Intel).
- **Node.js:** >= 20.0.0 (Check with `node -v`).
- **npm:** >= 10.0.0 (Check with `npm -v`).
- **FFmpeg & ffprobe:** Required for stream probing and remuxing.
- **Google Chrome:** (or Chromium, Brave, Microsoft Edge).

Install the core system dependencies using [Homebrew](https://brew.sh):

```bash
brew install node ffmpeg
```

Clone the repository and install all workspace dependencies:

```bash
git clone https://github.com/greenLemin/VidDock.git
cd VidDock
npm install
```

---

## 2. Workspace Architecture

VidDock is organized as an npm multi-workspace repository:

```
VidDock/
├── apps/
│   └── extension/             # Chrome Manifest V3 extension
│       ├── src/
│       │   ├── background/    # Sniffer, media store, task coordinator, native client
│       │   ├── content/       # Video element and Mediasite DOM detector scripts
│       │   ├── popup/         # Extension action popup UI
│       │   ├── dashboard/     # Download management dashboard UI
│       │   ├── settings/      # User configuration page
│       │   ├── styles/        # Shared glassmorphism CSS design system
│       │   └── ui/            # Formatting and component utilities
│       ├── dist/              # Built unpacked extension (gitignored)
│       └── manifest.json      # Base Manifest V3 configuration template
├── packages/
│   ├── shared/                # Universal TypeScript library
│   │   ├── src/
│   │   │   ├── hls.ts         # RFC 8216 HLS parser & playlist generation
│   │   │   ├── dash.ts        # ISO/IEC 23009-1 DASH MPD parser
│   │   │   ├── mediasite.ts   # Mediasite metadata & Smooth Streaming helpers
│   │   │   ├── protocol.ts    # Native messaging protocol schema & validation
│   │   │   ├── filename.ts    # Filename sanitization and templating
│   │   │   └── types.ts       # Shared TypeScript interfaces & types
│   └── native-host/           # macOS native messaging companion (com.viddock.host)
│       ├── src/
│       │   ├── framing.ts     # 32-bit LE stdio JSON framing & path containment
│       │   ├── server.ts      # HostServer request dispatcher
│       │   ├── manager.ts     # TaskManager concurrency & job coordination
│       │   ├── job.ts         # DownloadJob execution & segment assembler
│       │   ├── http.ts        # Resumable HTTP client with retry backoff
│       │   ├── mux.ts         # Lossless remuxing & composition filter complex
│       │   └── verify.ts      # Output validation via ffprobe
├── dist/                      # Built companion host and launchers (gitignored)
├── release/                   # Packaged release archives (gitignored)
├── scripts/                   # Build, install, and release scripts
└── tests/                     # Integration and end-to-end test suites
```

---

## 3. Build System & NPM Scripts

VidDock uses `esbuild` for rapid, zero-config TypeScript bundling.

### NPM Script Reference

| Script                     | Command                                           | Purpose                                                                 |
| :------------------------- | :------------------------------------------------ | :---------------------------------------------------------------------- |
| `npm run dev`              | `node scripts/build-extension.mjs --watch`        | Builds extension in incremental watch mode.                             |
| `npm run build`            | `npm run build:host && npm run build:extension`   | Compiles both native companion and extension.                           |
| `npm run build:extension`  | `node scripts/build-extension.mjs`                | Builds extension bundles to `apps/extension/dist/`.                     |
| `npm run build:host`       | `node scripts/build-host.mjs`                     | Builds companion host to `dist/host/viddock-host.mjs`.                  |
| `npm run host:install`     | `bash scripts/install-macos.sh`                   | Registers companion host manifest in Chrome directories.                |
| `npm run host:uninstall`   | `bash scripts/uninstall-macos.sh`                 | Removes companion host manifests.                                       |
| `npm run icons`            | `node scripts/generate-icons.mjs`                 | Generates 16x16, 48x48, 128x128 extension icons.                        |
| `npm test`                 | `vitest run --project unit --project integration` | Runs all unit and integration test suites.                              |
| `npm run test:unit`        | `vitest run --project unit`                       | Runs fast in-memory unit tests.                                         |
| `npm run test:integration` | `vitest run --project integration`                | Runs multi-segment remuxing integration tests.                          |
| `npm run test:e2e`         | `node tests/e2e/run.mjs`                          | Runs synthetic stream E2E verification test.                            |
| `npm run lint`             | `eslint .`                                        | Lints codebase using ESLint 9 flat config.                              |
| `npm run format`           | `prettier --write .`                              | Formats all files with Prettier.                                        |
| `npm run format:check`     | `prettier --check .`                              | Verifies code formatting without modifying files.                       |
| `npm run typecheck`        | `tsc -p tsconfig.json --noEmit`                   | Strict TypeScript compiler check across all packages.                   |
| `npm run package`          | `bash scripts/build-release.sh`                   | Packages production release zips and checksums.                         |
| `npm run verify`           | Combined verification pipeline                    | Quality gate: `format:check` + `lint` + `typecheck` + `test` + `build`. |

---

## 4. Testing Framework & Strategy

### 4.1 Vitest Workspaces (`vitest.workspace.ts`)

VidDock separates testing into two distinct Vitest projects:

1. **Unit Project (`unit`):** Tests pure functions, parsers, and validation logic in `packages/shared`, `packages/native-host`, and `apps/extension`. Executes in parallel.
2. **Integration Project (`integration`):** Tests multi-chunk downloading, container remuxing, and file verification. Executes sequentially (`fileParallelism: false`) with extended timeouts (120 seconds).

Run all tests:

```bash
npm test
```

### 4.2 End-to-End Synthetic Server Testing (`tests/e2e/run.mjs`)

The E2E test suite validates the entire build and runtime pipeline without relying on external websites:

1. **Build Validation:** Verifies that `apps/extension/dist/manifest.json` is valid Manifest V3, CSP-compliant (no inline scripts), and all referenced service worker/popup assets exist.
2. **Native Host Validation:** Checks that `dist/host/viddock-host-launcher.sh` is executable and its manifest is syntactically valid JSON.
3. **Live Handshake Test:** Spawns the native host launcher via Node.js `child_process.spawn`, encodes a 32-bit length-prefixed `hello` request, and verifies that the host returns `ok: true`, version `1.0.0`, and detected FFmpeg binaries within 4 seconds.
4. **Synthetic Media Server:** Launches an internal HTTP server serving synthetic HLS playlists, DASH manifests, and video segments to verify parser correctness.

Run the E2E test suite:

```bash
npm run test:e2e
```

---

## 5. Development Inner Loop

1. **Start the build watcher:**
   ```bash
   npm run dev
   ```
2. **Install companion host locally:**
   ```bash
   ./scripts/install-macos.sh
   ```
3. **Load unpacked extension in Chrome:**
   - Navigate to `chrome://extensions/`.
   - Enable **Developer mode**.
   - Click **Load unpacked** and select `apps/extension/dist`.
4. **Run health verification:**
   ```bash
   ./scripts/verify-installation.sh
   ```
5. **Inspect logs:**
   - Chrome Extension logs: Right-click the extension icon -> **Inspect popup**, or navigate to `chrome://extensions/` -> Inspect views: **service worker**.
   - Native host companion logs: Host logs are emitted to standard error (`stderr`), appearing in Chrome's native messaging log or when executing the launcher directly from Terminal.

---

## 6. Release Packaging (`scripts/build-release.sh`)

To package release bundles for distribution:

```bash
npm run package
```

This script executes the full verification pipeline (`typecheck`, `lint`, `test`, `build`), cleans the `release/` directory, and packages:

1. `VidDock-v1.0.0-chrome.zip`: Ready-to-load unpacked Chrome extension bundle.
2. `VidDock-v1.0.0-macos-installer.zip`: macOS companion host installer bundle containing launcher, pre-built binary, installation scripts, and verification tool.
3. `VidDock-v1.0.0-source.zip`: Full source code archive.
4. `SHA256SUMS.txt`: Cryptographic SHA-256 checksums for all release archives.
