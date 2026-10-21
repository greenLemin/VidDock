# Contributing to VidDock

Thank you for your interest in contributing to VidDock! We are committed to building a reliable, privacy-first, free, and open-source video download and archiving platform.

This guide outlines our development workflow, coding standards, testing requirements, and security review processes.

---

## Code of Conduct

All contributors and maintainers are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it to understand the community standards we uphold.

---

## Getting Started

### Prerequisites

- **macOS:** macOS 12 Monterey or newer (Apple Silicon or Intel).
- **Node.js:** >= 20.0.0 (Check with `node -v`).
- **npm:** >= 10.0.0.
- **FFmpeg & ffprobe:** Required for remuxing and probing media streams (`brew install ffmpeg`).
- **Google Chrome** (or Chromium, Brave, Microsoft Edge).

### Repository Setup

1. Fork the repository on GitHub: [greenLemin/VidDock](https://github.com/greenLemin/VidDock).
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/VidDock.git
   cd VidDock
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build all workspaces and components:
   ```bash
   npm run build
   ```
5. Run the health verification tool to ensure your environment is fully configured:
   ```bash
   ./scripts/verify-installation.sh
   ```

---

## Repository Structure

VidDock is organized as an npm multi-workspace repository:

```
VidDock/
├── apps/
│   └── extension/             # Chrome Manifest V3 extension
│       ├── src/
│       │   ├── background/    # Service worker, sniffer, task coordinator
│       │   ├── content/       # Video & Mediasite DOM detectors
│       │   ├── popup/         # Extension toolbar popup interface
│       │   ├── dashboard/     # Download management dashboard
│       │   ├── settings/      # User preferences and configuration
│       │   └── styles/        # Glassmorphic CSS tokens and design system
│       └── manifest.json      # Manifest V3 configuration template
├── packages/
│   ├── shared/                # Universal TypeScript models, protocol, parsers
│   │   └── src/               # HLS/DASH parsers, filename templates, types
│   └── native-host/           # macOS native messaging companion (com.viddock.host)
│       └── src/               # Stdio framing, task manager, FFmpeg muxer
├── scripts/                   # Build, install, and release automation scripts
├── tests/
│   ├── helpers/               # Synthetic stream servers and fixtures
│   ├── integration/           # Integration tests for muxing and downloading
│   └── e2e/                   # End-to-end verification harness
└── release/                   # Packaged release archives and checksums
```

---

## Development Workflow

### Branch Naming Convention

Create a new branch from `main` using standard prefixes:

- `feature/<short-description>`: New features or enhancements.
- `fix/<short-description>`: Bug fixes.
- `refactor/<short-description>`: Code restructuring without functional changes.
- `docs/<short-description>`: Documentation additions or updates.
- `test/<short-description>`: New tests or test infrastructure improvements.

### Development Mode

Run the extension build watcher:

```bash
npm run dev
```

This runs `esbuild` in incremental watch mode, rebuilding extension bundles to `apps/extension/dist/` whenever files in `apps/extension/src` or `packages/shared/src` change.

Load `apps/extension/dist` as an unpacked extension in `chrome://extensions/`. When code changes, click the reload button on the extension card in `chrome://extensions/`.

---

## Coding Standards

### TypeScript Strict Mode

- All TypeScript code must pass with zero type errors: `npm run typecheck`.
- Do not use `any` unless strictly necessary for third-party boundary parsing (and accompany with `/* eslint-disable @typescript-eslint/no-explicit-any */`).
- Use explicit return types for public functions and API boundaries.

### Manifest V3 & Security Constraints

- **No Inline Scripts:** Extension HTML files (`popup/index.html`, `dashboard/index.html`, `settings/index.html`) must strictly avoid inline `<script>` blocks to adhere to Chrome's strict Content Security Policy (CSP). All JavaScript must be imported via external `<script src="...">` tags.
- **No Dynamic Code Evaluation:** `eval()`, `new Function()`, and WebAssembly string compilation are strictly prohibited.
- **Service Worker Ephemerality:** Do not store persistent state in global memory within `apps/extension/src/background/`. The Manifest V3 service worker can be terminated by Chrome after 30 seconds of inactivity. Always synchronize state with `chrome.storage.local` or the persistent native host process.

### Native Host Security Guidelines

- **No Shell Execution:** Never use `child_process.exec()` or execute commands through `/bin/sh`. Always use `child_process.execFile()` with an explicit array of sanitized string arguments.
- **Filesystem Traversal Prevention:** Never write files directly from user-supplied filenames. All paths must be normalized and verified via `resolveOutputDir()` and `sanitizeFilename()`. Files must be verified using `safeRealpath()` to ensure they reside strictly inside the user's home directory.
- **Zero Telemetry:** Do not import or introduce any analytics, error reporting SDKs, telemetry beacons, or external CDN scripts.

### Code Style & Formatting

We use ESLint 9 and Prettier:

```bash
# Check code style
npm run lint

# Check formatting
npm run format:check

# Automatically fix formatting
npm run format
```

---

## Testing Requirements

We maintain a rigorous multi-tier testing pipeline. All pull requests must maintain or improve test coverage.

### 1. Unit Tests

Unit tests execute quickly in Node.js and validate pure parsers, protocol framing, filename templates, and data models:

```bash
npm run test:unit
```

Test files are located alongside their respective workspaces:

- `packages/shared/tests/` (HLS/DASH manifest parsing, protocol messages, URL helpers)
- `packages/native-host/tests/` (FFmpeg argument building, container selection, stdio framing)
- `apps/extension/tests/` (Media store, sniffer logic, UI formatters)

### 2. Integration Tests

Integration tests validate concurrent chunk downloads, multi-stream muxing, FFmpeg filter complex pipelines, and network failure recovery:

```bash
npm run test:integration
```

### 3. End-to-End (E2E) Test Suite

The E2E test runs synthetic HLS and DASH servers, builds the extension and native companion, launches the companion executable, and tests live stdio handshakes:

```bash
npm run test:e2e
```

### 4. Full Quality Gate Verification

Before committing changes or opening a pull request, run the single-command verification gate:

```bash
npm run verify
```

This runs `format:check`, `lint`, `typecheck`, all tests, and a production build. All checks must pass cleanly.

---

## Submitting a Pull Request

1. Push your branch to your GitHub fork:
   ```bash
   git push origin <your-branch-name>
   ```
2. Open a Pull Request against `main` on [greenLemin/VidDock](https://github.com/greenLemin/VidDock).
3. Fill out the PR description with:
   - **Summary:** Concise description of the changes.
   - **Motivation:** Why is this change necessary? (Link related issues if applicable).
   - **Testing Performed:** Specify unit, integration, and manual testing performed.
   - **Checklist:** Confirm `npm run verify` passed cleanly.
4. Maintainers will review your PR and provide constructive feedback. Once approved and CI checks pass, your changes will be merged!
