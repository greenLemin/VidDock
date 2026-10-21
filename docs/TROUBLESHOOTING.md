# VidDock Troubleshooting & FAQ

This guide addresses common issues, diagnostic procedures, and troubleshooting steps for VidDock on macOS.

---

## 1. Quick Diagnostic Checklist

Whenever you encounter an issue, run VidDock's diagnostic verification tool in your Terminal:

```bash
cd /path/to/VidDock
./scripts/verify-installation.sh
```

This automated script checks:

- Node.js runtime presence and version (>= 20 required).
- FFmpeg and ffprobe binary availability.
- Chrome Native Messaging manifest registration.
- Executable permissions on launcher scripts.
- Live stdio communication handshake with `com.viddock.host`.
- Built extension bundle status.

---

## 2. Native Companion Host Disconnected

### Symptom

The popup or dashboard displays:

> _"Native companion host disconnected. Check that com.viddock.host is installed."_

### Cause A: Extension ID Mismatch

When loading an unpacked extension in Chrome, Chrome assigns a random 32-letter ID based on the absolute path of the extension folder. If you move the folder or reinstall, the Extension ID changes.

**Fix:**

1. Open `chrome://extensions/` and locate the VidDock card.
2. Copy the 32-letter **ID** (e.g., `pknljchblnkgfmfcfdfkddedjofmjbkj`).
3. Re-run the installer with your active Extension ID:
   ```bash
   ./scripts/install-macos.sh --extension-id <YOUR_EXTENSION_ID>
   ```
4. Reload the extension in `chrome://extensions/`.

### Cause B: Missing Native Messaging Manifest

Chrome cannot find `com.viddock.host.json`.

**Fix:**
Verify that the manifest exists in Chrome's native messaging directory:

```bash
ls -la "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.viddock.host.json"
```

If missing, run `./scripts/install-macos.sh` to regenerate it. For other Chromium browsers (Brave, Edge, Canary), use the `--all-browsers` flag:

```bash
./scripts/install-macos.sh --all-browsers
```

### Cause C: Launcher Missing Executable Permission

Chrome spawns the companion using `viddock-host-launcher.sh`. If file permissions were stripped (e.g., after unzipping without preserving flags), Chrome fails to launch the process.

**Fix:**

```bash
chmod +x dist/host/viddock-host-launcher.sh
chmod +x dist/host/viddock-host.mjs
```

---

## 3. FFmpeg / ffprobe Not Found

### Symptom

The dashboard displays:

> _"FFmpeg binary not found on PATH. Lossless remuxing requires FFmpeg."_

### Cause: Non-Interactive Shell PATH on macOS

When Chrome launches a native messaging host as a macOS GUI subshell, it does not execute user shell profiles (`~/.zshrc` or `~/.bashrc`). As a result, Homebrew binary paths (`/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin` on Intel) may be missing from the default environment `PATH`.

**How VidDock Fixes This:**
VidDock's `viddock-host-launcher.sh` automatically searches standard binary directories:

```bash
SEARCH_PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$HOME/.nvm/versions/node/$(node -v 2>/dev/null)/bin:$PATH"
```

**Manual Fix:**
If your FFmpeg is installed in a custom location, ensure it is symlinked to `/usr/local/bin` or `/opt/homebrew/bin`:

```bash
brew install ffmpeg
which ffmpeg
# Should output /opt/homebrew/bin/ffmpeg or /usr/local/bin/ffmpeg
```

---

## 4. "Path Outside Allowed Folders" (`PATH_ERROR`)

### Symptom

A download fails immediately with error:

> _"PathError: Output directory must be inside your home folder"_

### Cause: Security Containment

VidDock's security model strictly restricts file operations to subdirectories within the current user's home folder (`~` / `/Users/username/`). Attempting to save directly to system directories (e.g., `/Volumes/ExternalDrive` if mounted outside home, `/tmp`, `/var`, `/Library`) triggers this security violation.

**Fix:**

1. Open the VidDock **Settings** page (gear icon in the popup).
2. Set your download destination directory to a location inside your user profile:
   - `~/Downloads/VidDock` (Default)
   - `~/Movies/VidDock`
   - `~/Desktop/Lectures`

---

## 5. Mediasite Lecture Not Detected or 403 Forbidden

### Symptom A: Video Stream Not Listed in Popup

You are on a Mediasite lecture page, but the VidDock popup says "No video detected".

**Fix:**

1. Click **Play** on the lecture video player and let it run for 3–5 seconds. Many players do not request stream playlists until playback starts.
2. If the presentation is inside an iframe, ensure the iframe has finished loading.
3. Refresh the page (`Cmd + R`) with the VidDock extension already enabled.

### Symptom B: HTTP 403 Forbidden During Download

The download starts but immediately fails with `HttpError: HTTP 403 Forbidden`.

**Cause:**
Your university SSO (Single Sign-On) session has expired, or the media CDN requires refreshed session cookies.

**Fix:**

1. Refresh the lecture page in Chrome and confirm video playback works.
2. Click the VidDock popup again to capture fresh session cookies.
3. Retry the download from the popup.

---

## 6. Audio/Video Sync Warnings or Duration Mismatch

### Symptom

The dashboard task displays a warning icon with a tooltip:

> _"Audio and video lengths differ by 3.2s"_ or _"Audio/video start offset is 0.8s"_

### Explanation

In some adaptive streaming platforms (particularly dual-feed lecture recordings), video streams are spun up independently of audio feeds. A slight start offset (0.5s to 2s) is common in university lecture capture systems.

**Resolution:**

- VidDock's FFmpeg pipeline automatically passes `-avoid_negative_ts make_zero` and `-fflags +genpts+discardcorrupt` to realign presentation timestamps.
- If the warning does not fail the verification check, the output video file is completely playable and audio remains synchronized during playback in VLC or QuickTime.

---

## 7. Chrome "Disable Developer Mode Extensions" Warning

### Symptom

Chrome occasionally displays a popup warning: _"Disable developer mode extensions"_.

### Explanation

This is a standard security warning Google Chrome displays for any unpacked extension loaded via **Developer mode** rather than the Chrome Web Store.

**Resolution:**

- You can safely dismiss the prompt by clicking the **Cancel** button or pressing `Esc`.
- The warning does not affect extension functionality or security.
