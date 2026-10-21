# VidDock Technical Scope & Limitations

VidDock is engineered to be a robust, high-performance, and privacy-preserving tool for capturing and archiving standard web media streams. To maintain security, integrity, and compliance with open web standards, VidDock operates within clearly defined technical boundaries.

This document outlines VidDock's architectural constraints and non-goals.

---

## 1. Digital Rights Management (DRM)

### Policy

**VidDock strictly does NOT bypass, decrypt, reverse engineer, or crack Digital Rights Management (DRM) systems.**

### Technical Explanation

Many commercial subscription streaming services (e.g., Netflix, Disney+, Spotify, Hulu, Apple TV+) protect their audio and video content using hardware- or software-backed Content Protection mechanisms:

- **Google Widevine (CENC / Common Encryption):** Encrypted using AES-128 in CTR or CBC mode, with license acquisition managed via encrypted CDM (Content Decryption Module) hardware.
- **Apple FairPlay Streaming (FPS):** Encrypted media using Apple Key Server Modules.
- **Microsoft PlayReady:** Microsoft encrypted media pipelines.
- **W3C Encrypted Media Extensions (EME) & ClearKey:** DRM signaling indicated via `#EXT-X-KEY:METHOD=SAMPLE-AES` or `<ContentProtection>` XML descriptors.

### Behavior in VidDock

When VidDock parses an HLS playlist or DASH MPD containing DRM encryption keys:

- The parser identifies DRM tags (e.g. `METHOD=SAMPLE-AES`, `schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"` for Widevine).
- The stream is flagged as **DRM-Protected** and excluded from download options in the popup.
- VidDock does not download or attempt to decode encrypted payloads.

> [!NOTE]
> Standard **HLS AES-128 segment encryption** (`#EXT-X-KEY:METHOD=AES-128`) using plaintext HTTP key delivery is **fully supported**. This standard HLS mechanism is not DRM; the encryption key is retrieved via standard authorized HTTPS request and decrypted locally.

---

## 2. Live Broadcasts vs. Video-on-Demand (VOD)

### Supported Scope: Video-on-Demand (VOD)

VidDock is optimized for finished, bounded media recordings:

- University lecture recordings (Mediasite, Panopto, Canvas, Blackboard).
- Bounded HLS and DASH video streams with an `#EXT-X-ENDLIST` tag or fixed `<MPD type="static">` duration.
- Standalone media files (MP4, WebM, MOV, MP3).

### Non-Goal: Infinite Live Broadcasts

Linear live broadcasts (e.g. 24/7 news channels, continuous live sports, Twitch live streams):

- Do not have a known duration or total segment count.
- Continuously append sliding-window segments while discarding older chunks.
- Require specialized DVR recording pipelines with manual user start/stop triggers.

VidDock focuses on complete, archivable video files rather than continuous stream recording.

---

## 3. Browser & Platform Constraints

### Manifest V3 Ephemerality

- Under Manifest V3, Chrome service workers are ephemeral and subject to termination when idle.
- While VidDock keeps the worker alive during active communication and uses `chrome.alarms` for background synchronization, long-term state is preserved inside the persistent **native companion host** rather than browser memory.

### Native Messaging 1 MiB Outgoing Ceiling

- Google Chrome enforces a hard 1 MiB limit on individual JSON messages transmitted from the native host to the extension.
- Diagnostics, extensive task lists, and high-frequency progress updates are throttled and chunked to remain well below this threshold.

### Chrome Developer Mode Warnings

- Because VidDock is distributed as an open-source, unpacked extension loaded directly from source or release zips, Chrome will occasionally display a prompt stating: _"Disable developer mode extensions"_.
- This is an unavoidable Chromium security policy for extensions installed outside the Chrome Web Store. The prompt can be safely dismissed.

---

## 4. Operating System Scope

- **macOS Primary Optimization:** VidDock's installer (`scripts/install-macos.sh`), native launcher (`viddock-host-launcher.sh`), and Finder integration (`file.reveal`) are designed and optimized specifically for macOS (Intel and Apple Silicon).
- **Filesystem Containment:** VidDock strictly enforces that downloads must be saved to folders inside your home directory (`~` / `/Users/username/`). Saving to root directories or system folders is disallowed for security reasons.

---

## 5. Proprietary Canvas / WebGL Custom Players

Certain web applications render video through non-standard canvas drawing techniques (e.g., streaming raw JPEG or WebP frames over proprietary WebSockets and painting them onto an HTML5 `<canvas>` element).

Because these techniques do not use HTML5 `<video>`, HLS (`.m3u8`), DASH (`.mpd`), or standard HTTP video chunks, network sniffers and DOM detectors cannot reconstruct them without a full screen recording tool. VidDock focuses exclusively on standard web streaming protocols.
