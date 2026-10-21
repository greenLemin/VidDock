# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-10-21

### Initial Production Release

VidDock v1.0.0 marks the initial production release of the 100% free, privacy-first, open-source video downloader extension and macOS native companion host.

### Highlights

#### Chrome Extension (Manifest V3)

- **Manifest V3 Architecture:** Built from the ground up for modern Chrome Manifest V3 using service workers and declarative extension policies.
- **Network Stream Sniffer:** High-performance request interception observing HTTP requests for media manifests (`.m3u8`, `.mpd`, `.ism/manifest`, `.mp4`, `.webm`, `.m4v`).
- **Session Header & Cookie Preservation:** Automatically preserves necessary session headers (`Referer`, `Origin`, `User-Agent`, authorization cookies) to ensure authenticated streams download smoothly without authorization failures.
- **Glassmorphic User Interface:** Clean, accessible macOS-style user interface built with modern CSS custom properties and zero external framework bloat:
  - **Extension Toolbar Popup:** Instant stream overview on active tab, bitrate/resolution badges, and quick download button.
  - **Download Dashboard:** Real-time progress bars, download speeds (MB/s), duration indicators, ETA calculations, pause/resume/cancel controls, and one-click file reveal in macOS Finder.
  - **Settings Console:** Configurable download destination directories, concurrent task limits (1 to 8 parallel tasks), container preferences (Auto / MP4 / MKV), and custom filename naming templates (`{title} - {quality} ({date})`).

#### Native Companion Host (`com.viddock.host`)

- **Native Messaging Stdio Engine:** Robust, asynchronous framing protocol using 32-bit native-endian length headers and UTF-8 JSON message bodies.
- **Concurrent Chunk Downloader:** Multi-chunk HTTP engine supporting resumable byte-range downloads (`Range: bytes=...`), automatic retry with exponential backoff, and temporary scratch file isolation.
- **Filesystem & Path Traversal Security:** Rigid containment model enforcing that all operations occur strictly within canonical subdirectories of the user's home folder (`~`), preventing path traversal (`..`), symlink escapes, and NUL byte injection.
- **Command Injection Immunity:** Complete elimination of shell evaluation; all system binaries (`ffmpeg`, `ffprobe`, `open`) are executed via `child_process.execFile` with explicit immutable parameter arrays.

#### Mediasite Lecture Archiving Engine

- **Automated Dual-Stream Detection:** Content scripts and sniffer hooks recognize Mediasite player instances and parse JSON payloads from `PlayerService.svc/json/GetPlayerOptions`.
- **Smooth Streaming to HLS Translation:** Translates legacy Microsoft Smooth Streaming manifest URLs (`.ism/manifest`) to playable Apple HLS manifests (`(format=m3u8-aapl)`).
- **Dual-Feed Composition Modes:**
  - **Side-by-Side:** High-definition side-by-side composition using FFmpeg `hstack` filter complex, scaling feeds to 960x540 with aspect-ratio preserving padding into a unified 1920x540 canvas.
  - **Picture-in-Picture (PiP):** Full-screen slide presentation with presenter camera feed overlaid in the bottom-right corner at 1/3.5 scale with 24px margins. Features `trunc(iw/2)*2:trunc(ih/2)*2` dimension normalization to ensure valid even pixel dimensions required by H.264/yuv420p video codecs.
  - **Separate Streams:** Downloads presenter camera and slide streams as distinct, standalone media files for modular archival.

#### Lossless Remuxing Pipeline (`mux.ts`)

- **Zero-Transcoding Stream Copying:** Preserves original video and audio packets using FFmpeg `-c copy` whenever container formats permit, eliminating generational compression loss and reducing export times to seconds.
- **Intelligent Container Selection:** Automatically selects target containers (`mp4`, `mkv`, `webm`, `m4a`) based on input codec compatibility without relabelling mismatched codecs.
- **Apple QuickTime Compatibility:** Injects `+faststart` moov atom flags and adds `-tag:v hvc1` tags to HEVC streams for seamless native playback in macOS Finder, QuickTime Player, and iOS.
- **Quality & Duration Probing (`verify.ts`):** Automatically validates completed remuxes using `ffprobe` to verify audio/video presence, detect stream desync, and ensure duration matches manifest specifications within tolerance.

#### Automation, Verification & Packaging

- **`scripts/install-macos.sh`:** Automated installer registering `com.viddock.host.json` across Google Chrome, Chrome Canary, Chromium, Brave Browser, and Microsoft Edge.
- **`scripts/verify-installation.sh`:** End-to-end environment diagnostic tool checking Node.js (>=20), FFmpeg, ffprobe, launcher file permissions, and executing live stdio handshakes.
- **`scripts/build-release.sh`:** Deterministic release packaging producing unpacked Chrome extension zips, macOS companion installer packages, source archives, and cryptographic `SHA256SUMS.txt` checksums.

#### Comprehensive Test Suite

- **Unit Testing:** Vitest test suite covering HLS/DASH manifest parsers, URL utilities, filename sanitization, stdio protocol framing, and FFmpeg argument generation.
- **Integration Testing:** Multi-segment downloading, container remuxing, and network error recovery tests.
- **End-to-End Test Harness:** Synthetic HLS/DASH stream server validating live browser requests, manifest transformations, and companion stdio handshakes.
