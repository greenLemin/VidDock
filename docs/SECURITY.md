# VidDock Security Architecture & Threat Model

This document details the defense-in-depth security model of VidDock, providing an exhaustive threat analysis across the browser sandbox, native messaging bridge, operating system boundary, and filesystem.

---

## 1. Security Architecture Principles

VidDock operates at the intersection of untrusted web environments (arbitrary web pages and remote CDNs) and privileged local environments (the user's macOS workstation).

Our architecture adheres to four core principles:

1. **Principle of Least Privilege:** Components only possess the minimum permissions required for their specific function. Content scripts have zero filesystem access; background workers cannot spawn processes directly; the native host companion cannot execute arbitrary shell scripts.
2. **Strict Boundary Validation:** All data crossing from Chrome to the native messaging companion undergoes rigid schema validation, type verification, and path canonicalization.
3. **Local-First Privacy:** Zero telemetry, zero cloud processing, zero remote analytics, and zero external network calls outside user-requested media streams.
4. **Shell-Free Execution:** External binaries (`ffmpeg`, `ffprobe`, `open`) are executed exclusively via explicit parameter vectors, eliminating shell interpretation.

---

## 2. Privilege Boundaries & Data Flow

```
+───────────────────────────────────────────────────────────────────────────+
| UNTRUSTED DOMAIN: Arbitrary Web Pages & External CDNs                     |
| - Malicious JavaScript, crafted video tags, spoofed stream manifests      |
+───────────────────────────────────────────────────────────────────────────+
                                      │
                                      ▼ [Browser Sandbox Boundary]
+───────────────────────────────────────────────────────────────────────────+
| EXTENSION CONTENT SCRIPTS (Isolated World)                                |
| - Read-only DOM video detection; no chrome.downloads access               |
+───────────────────────────────────────────────────────────────────────────+
                                      │ (chrome.runtime.sendMessage)
                                      ▼
+───────────────────────────────────────────────────────────────────────────+
| EXTENSION SERVICE WORKER (Manifest V3 Context)                            |
| - Manifest parsing (HLS / DASH / Mediasite)                               |
| - No native process spawning; CSP prevents eval() and remote code         |
+───────────────────────────────────────────────────────────────────────────+
                                      │ (chrome.runtime.connectNative)
                                      ▼ [Native Messaging Stdio Boundary]
+───────────────────────────────────────────────────────────────────────────+
| NATIVE COMPANION HOST (com.viddock.host)                                  |
| - Origin-restricted: only whitelisted Extension ID can connect           |
| - Stdio binary framing (4-byte length prefix; 64 MiB max message)         |
| - Strict JSON validation against protocol schema                          |
| - Path containment: all I/O strictly inside user home (~)                 |
| - Shell-free execution: execFile(['-hide_banner', ...])                   |
+───────────────────────────────────────────────────────────────────────────+
                                      │
                                      ▼ [OS Filesystem Boundary]
+───────────────────────────────────────────────────────────────────────────+
| MACOS FILESYSTEM (User Storage: ~/Downloads/VidDock)                      |
| - Atomic file writes; automatic cleanup of ~/.viddock/work scratch dirs   |
+───────────────────────────────────────────────────────────────────────────+
```

---

## 3. Threat Vectors & Mitigations

### 3.1 Path Traversal & Arbitrary File Overwrite

#### Attack Vector:

A malicious stream manifest or webpage embeds path traversal sequences in video titles or segment filenames (e.g., `../../../../Library/LaunchAgents/malicious.plist` or `~/.ssh/authorized_keys\0.mp4`) attempting to overwrite sensitive system or user files.

#### Mitigations:

VidDock implements a multi-layer defense in `filename.ts` and `framing.ts`:

1. **Sanitization (`sanitizeFilename`):**
   - Unicode Normalization: Standardizes strings via Unicode `NFC` normalization.
   - Character Stripping: Strips directory separators (`/`, `\`), null bytes (`\0`), control characters (`\u0000-\u001f\u007f-\u009f`), bidirectional override characters (`\u202a-\u202e`), and reserved symbols (`:*?"<>|`).
   - Reserved Filenames: Blocks DOS/Windows reserved devices (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
   - Length Clamping: Truncates filenames to a safe maximum of 180 bytes.
2. **Filesystem Canonicalization (`resolveOutputDir` & `safeRealpath`):**
   - Resolves all symbolic links using Node.js `fs.realpathSync`.
   - Compares the resolved canonical path against `allowedRoots()` (the user's home directory `os.homedir()`).
   - If the canonical path points outside `~` (e.g. `/etc`, `/System`, `/var`), the operation fails immediately with `PathError`:
     ```typescript
     if (!allowedRoots().some((r) => isInside(real, r))) {
       throw new PathError('Output directory must be inside your home folder');
     }
     ```
3. **Atomic File Creation:**
   - Active downloads write to an isolated temporary scratch folder: `~/.viddock/work/<task-id>/`.
   - Only upon successful verification is the finished media file atomically moved into the target folder.

---

### 3.2 Command Injection via External Binaries

#### Attack Vector:

A media title or URL contains shell metacharacters (e.g., `video; rm -rf ~;`, `$(reboot)`, or `` `whoami` ``) intended to execute arbitrary shell code when FFmpeg or Finder is invoked.

#### Mitigations:

1. **Zero Shell Execution:**
   - The native companion never uses `child_process.exec()` or `/bin/sh`.
   - All external processes (`ffmpeg`, `ffprobe`, `open`) are spawned using Node.js `child_process.execFile()`.
2. **Structured Argument Arrays:**
   - Filenames and metadata are passed as distinct elements in an argument vector:
     ```typescript
     // SAFE: Passed as discrete argv string, NOT concatenated into a shell command
     args.push('-metadata', `title=${safeTitle}`);
     ```
   - Shell metacharacters are treated as literal characters and cannot escape the argument boundary.
3. **Restricted Binary Flags:**
   - FFmpeg is invoked with `-nostdin` and `-hide_banner` to prevent process hijacking or interactive prompt hanging.

---

### 3.3 Buffer Overflow & Memory Exhaustion

#### Attack Vector:

A malicious webpage or compromised process floods the native host with gigantic payloads, attempting to trigger out-of-memory crashes or buffer overflow vulnerabilities in the stdio parser.

#### Mitigations:

1. **Length Capping (`framing.ts`):**
   - The native host reads the 4-byte native-endian unsigned integer prefix.
   - If the declared length exceeds 64 MiB (`MAX_INCOMING`), the message is rejected, the buffer is purged, and a protocol error is logged.
2. **Browser Native Messaging Limit:**
   - Chrome enforces a hard 1 MiB limit on outgoing messages from the native host to the extension. VidDock's `encodeMessage()` enforces:
     ```typescript
     if (body.length > MAX_OUTGOING) {
       throw new Error('Outgoing message exceeds the 1 MiB native messaging limit');
     }
     ```
3. **Task Concurrency Limiting:**
   - `TaskManager` enforces a strict concurrent task limit (default 3, max 8), preventing resource starvation.

---

### 3.4 Unauthorized Native Messaging Access

#### Attack Vector:

A malicious extension or third-party app installed on the user's browser attempts to connect to `com.viddock.host` to control local downloads or execute commands.

#### Mitigations:

1. **Origin Verification in Host Manifest:**
   - Chrome verifies that the connecting extension matches the `allowed_origins` whitelist in `com.viddock.host.json`:
     ```json
     "allowed_origins": [
       "chrome-extension://pknljchblnkgfmfcfdfkddedjofmjbkj/"
     ]
     ```
   - Any connection attempt from an unlisted extension ID is blocked by Chrome at the operating system level before `com.viddock.host` is spawned.
2. **Extension ID Validation:**
   - The installer verifies that extension IDs strictly match 32 lowercase letters `[a-p]{32}`.

---

### 3.5 Extension Sandbox & Content Security Policy (CSP)

#### Attack Vector:

A malicious webpage attempts cross-site scripting (XSS) within the extension's UI context (`popup`, `dashboard`, `settings`).

#### Mitigations:

1. **Manifest V3 Strict CSP:**
   - Inline scripts (`<script>...</script>`) are entirely forbidden. All code is bundled and loaded via external `.js` files.
   - Dynamic code evaluation (`eval()`, `new Function()`) is completely disallowed by Chrome's MV3 runtime.
2. **DOM Isolation:**
   - Content scripts execute in an **Isolated World**, sharing the DOM with web pages but maintaining private JavaScript execution contexts and prototype chains.

---

## 4. Privacy & Telemetry Audit

VidDock was created specifically to counter invasive commercial browser extensions that track user activity:

| Practice              |   Commercial Extensions    |   VidDock Policy   | Implementation                                      |
| :-------------------- | :------------------------: | :----------------: | :-------------------------------------------------- |
| **User Accounts**     |       Often Required       | **Zero Accounts**  | No registration, passwords, or emails.              |
| **Analytics Beacons** | Google Analytics, Mixpanel | **Zero Telemetry** | Zero external analytics libraries.                  |
| **Cloud Transcoding** |  Uploads video to server   |   **100% Local**   | All remuxing handled by local FFmpeg.               |
| **URL Logging**       |   Tracks watched videos    |   **No Logging**   | Stream URLs exist in memory only during download.   |
| **Session Cookies**   |  Stored on remote servers  |   **Local Only**   | Auth headers passed locally via stdio; never saved. |
