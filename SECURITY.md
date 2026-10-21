# Security Policy

At VidDock, security and user privacy are foundational engineering priorities. We believe personal media downloads should remain entirely private to the user's local machine, free from telemetry, cloud proxies, and attack vectors.

This document outlines our security architecture, defense-in-depth principles, and instructions for reporting vulnerabilities.

---

## Supported Versions

Security updates are actively maintained for the following versions:

| Version   | Supported | Status                    |
| :-------- | :-------: | :------------------------ |
| **1.0.x** |  **Yes**  | Active release line       |
| < 1.0.0   |    No     | Pre-release / unsupported |

---

## Security Model & Architecture

VidDock bridges an untrusted environment (arbitrary web pages) with a privileged local environment (the user's macOS filesystem and native binaries) through a strict multi-layer defense model:

```
[ Web Page (Untrusted DOM & Media CDN) ]
                   │
                   ▼ (DOM Events & declarativeNetRequest / WebRequest)
[ Chrome Extension Content Scripts (Restricted Sandbox) ]
                   │
                   ▼ (chrome.runtime.sendMessage)
[ Chrome Extension Service Worker (Manifest V3 Context) ]
                   │
                   ▼ (chrome.runtime.sendNativeMessage via stdio)
=================== PRIVILEGE BOUNDARY ===================
[ macOS Native Messaging Host (com.viddock.host) ]
                   │
                   ├── Stdio 32-bit JSON Protocol Framer
                   ├── Strict Schema & Path Traversal Validator
                   ├── Isolated Worker Subprocesses (FFmpeg / ffprobe)
                   │
                   ▼ (Atomic file writes)
[ Local User Storage (~/Downloads/VidDock) ]
```

### 1. Zero Telemetry & Local Execution

- VidDock does not transmit telemetry, analytics, session cookies, browsing history, or media URLs to any third-party or developer-controlled cloud service.
- All HTTP segment downloads and playlist parsing are executed strictly between the user's browser/companion host and the content delivery network (CDN) serving the video.

### 2. Native Messaging Isolation

- The native companion host (`com.viddock.host`) communicates exclusively over standard input and standard output (`stdio`).
- The native host manifest (`com.viddock.host.json`) registers with Chrome under the user's Application Support directory and enforces strict origin matching:
  ```json
  "allowed_origins": [
    "chrome-extension://<EXTENSION_ID>/"
  ]
  ```
  Chrome enforces that only the exact registered extension ID can establish a pipe to the native host binary.

### 3. Path Traversal & Filesystem Containment

- All output filenames are sanitized using `sanitizeFilename()` to strip path separators (`/`, `\`), control characters, reserved filenames, and directory traversal sequences (`..`).
- The native companion validates all target directories using `resolveOutputDir()`, canonicalizing paths with `safeRealpath()`.
- The native host strictly enforces that target write directories and open/reveal targets must reside within the user's home directory (`os.homedir()`). Any path escaping the home directory or pointing to system roots (`/System`, `/Library`, `/usr`, `/etc`) is immediately rejected with `PathError`.

### 4. Command Injection Prevention

- The companion host never invokes a system shell (e.g., `sh -c` or `child_process.exec`).
- All external processes (`ffmpeg`, `ffprobe`, `open`) are spawned using Node.js `execFile()` with an explicit array of immutable arguments.
- Filenames and metadata are passed as individual arguments rather than string-concatenated shell commands, eliminating command injection vectors.

### 5. Content Security Policy (CSP) & Manifest V3

- The extension runs under Manifest V3 without `unsafe-eval` or inline scripts.
- Extension HTML pages (`popup`, `dashboard`, `settings`) load JavaScript strictly via external bundled scripts.
- Chrome's built-in sandboxing isolates extension execution from web page JavaScript.

### 6. DRM & Encrypted Streams Non-Interference

- VidDock respects digital rights management (DRM) technologies.
- Streams encrypted with Widevine, Apple FairPlay, or Microsoft PlayReady are not decrypted, bypassed, or cracked. VidDock detects encryption signaling in HLS (`EXT-X-KEY`) and DASH (`ContentProtection`) and gracefully flags or skips protected streams.

---

## Reporting a Vulnerability

If you discover a security vulnerability in VidDock, please report it privately so we can resolve the issue before public disclosure.

### How to Report

1. **Email or GitHub Security Advisory:**
   - Open a private security advisory on the GitHub repository: [greenLemin/VidDock Security Advisories](https://github.com/greenLemin/VidDock/security/advisories/new).
   - Alternatively, contact the maintainers directly via GitHub profile contact information.
2. **Include the Following Details:**
   - Detailed description of the vulnerability.
   - Step-by-step reproduction steps or a minimal proof of concept (PoC).
   - Potential impact of the issue (e.g., arbitrary file overwrite, privilege escalation, cross-site leak).
   - Affected components (extension, shared protocol, native host).
3. **Response Timeline:**
   - We will acknowledge receipt of your report within 48 hours.
   - We will evaluate the report and provide a status update or fix plan within 5 business days.
   - We will coordinate a responsible release and credit the reporter in release notes (unless anonymity is requested).

Please do not open public GitHub issues for security vulnerabilities.
