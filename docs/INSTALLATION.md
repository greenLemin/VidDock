# VidDock Installation Guide

This guide provides step-by-step instructions for installing and configuring VidDock on macOS.

---

## Prerequisites

Before installing VidDock, ensure your system meets the following requirements:

1. **Operating System:** macOS 12 (Monterey), 13 (Ventura), 14 (Sonoma), or 15 (Sequoia). Compatible with both Apple Silicon (M1/M2/M3/M4) and Intel architectures.
2. **Supported Web Browser:**
   - Google Chrome (stable, beta, or dev)
   - Google Chrome Canary
   - Brave Browser
   - Microsoft Edge
   - Chromium
3. **Node.js Runtime (>= 20.0.0):**
   VidDock's native messaging companion requires Node.js v20 or higher.
   Verify your version:
   ```bash
   node -v
   ```
   If Node.js is not installed or out of date, install via [Homebrew](https://brew.sh):
   ```bash
   brew install node
   ```
4. **FFmpeg & ffprobe:**
   Required for probing media streams and lossless remuxing:
   ```bash
   brew install ffmpeg
   ```
   Verify both binaries are available on your system path:
   ```bash
   ffmpeg -version
   ffprobe -version
   ```

---

## Installation Method 1: Pre-Packaged Release (Recommended)

### Step 1: Download Release Bundles

Download the latest release zip archives from [greenLemin/VidDock Releases](https://github.com/greenLemin/VidDock/releases):

- `VidDock-v1.0.0-chrome.zip`: Chrome extension distribution.
- `VidDock-v1.0.0-macos-installer.zip`: Native companion host bundle.
- `SHA256SUMS.txt`: Checksum file for verification.

Verify the integrity of downloaded files:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

Extract the archives:

```bash
unzip VidDock-v1.0.0-chrome.zip -d VidDock-chrome
unzip VidDock-v1.0.0-macos-installer.zip -d VidDock-installer
```

### Step 2: Load Extension in Google Chrome

1. Open Google Chrome and enter `chrome://extensions/` in the address bar.
2. In the top-right corner of the Extensions management page, turn **ON** the **Developer mode** toggle.
3. Click the **Load unpacked** button in the top-left toolbar.
4. In the file picker dialog, select the extracted `VidDock-chrome` directory.
5. VidDock will appear in your extensions list. Locate the **ID** field on the VidDock card:
   ```
   ID: pknljchblnkgfmfcfdfkddedjofmjbkj
   ```
   Copy this 32-letter lowercase string.

> [!TIP]
> Pin the VidDock extension icon to your browser toolbar for quick access to detected video streams.

### Step 3: Register the Native Host Companion

Open your Terminal application, navigate to the extracted `VidDock-installer` directory, and run the installation script:

```bash
cd VidDock-installer
./scripts/install-macos.sh
```

If the installer does not automatically detect your Extension ID, specify it explicitly:

```bash
./scripts/install-macos.sh --extension-id <YOUR_32_CHAR_EXTENSION_ID>
```

To install the companion for all detected Chromium browsers (Chrome, Canary, Chromium, Brave, Edge):

```bash
./scripts/install-macos.sh --all-browsers
```

### Step 4: Verify Installation Health

Run the diagnostic verification tool to ensure all components are properly configured:

```bash
./scripts/verify-installation.sh
```

If everything is configured correctly, you will see green checkmarks for:

- Operating system architecture
- Node.js runtime version (>= 20)
- FFmpeg and ffprobe binaries
- Native messaging manifest path
- Host launcher execution permissions
- Live stdio handshake probe (`PROBE_OK`)
- Chrome unpacked extension build

---

## Installation Method 2: From Source (Developers)

If you are modifying or compiling VidDock from the source repository:

```bash
# 1. Clone the repository
git clone https://github.com/greenLemin/VidDock.git
cd VidDock

# 2. Install workspace dependencies
npm install

# 3. Build extension and native host packages
npm run build

# 4. Load extension in Chrome
# In chrome://extensions/, enable Developer mode, click "Load unpacked",
# and select: <repo-path>/apps/extension/dist

# 5. Register native host companion
./scripts/install-macos.sh

# 6. Run verification checklist
./scripts/verify-installation.sh
```

---

## Installer CLI Options Reference

The `scripts/install-macos.sh` script accepts several configuration flags:

| Flag             | Parameter | Description                                                           |
| :--------------- | :-------- | :-------------------------------------------------------------------- |
| `--extension-id` | `<ID>`    | Specify the 32-character Chrome extension ID (letters a–p).           |
| `--launcher`     | `<PATH>`  | Specify a custom absolute path to `viddock-host-launcher.sh`.         |
| `--all-browsers` | _None_    | Register manifests for Chrome, Canary, Chromium, Brave, and Edge.     |
| `--dry-run`      | _None_    | Test manifest generation and paths without writing any files to disk. |
| `--force`        | _None_    | Overwrite existing native messaging manifests without confirmation.   |
| `-h`, `--help`   | _None_    | Print usage documentation.                                            |

### Manifest Registration Targets

The installer writes `com.viddock.host.json` to the standard macOS NativeMessagingHosts directories:

- **Google Chrome:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- **Chrome Canary:** `~/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts/`
- **Chromium:** `~/Library/Application Support/Chromium/NativeMessagingHosts/`
- **Brave Browser:** `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
- **Microsoft Edge:** `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`

The registered manifest file links to `viddock-host-launcher.sh` and restricts access strictly to the extension ID:

```json
{
  "name": "com.viddock.host",
  "description": "VidDock Native Companion Host",
  "path": "/Users/username/.../dist/host/viddock-host-launcher.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://pknljchblnkgfmfcfdfkddedjofmjbkj/"]
}
```

---

## Uninstallation

To completely remove the native companion host and clean up native messaging registrations:

```bash
./scripts/uninstall-macos.sh
```

To remove the Chrome extension, simply navigate to `chrome://extensions/` and click **Remove** on the VidDock card.
