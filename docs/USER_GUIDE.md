# VidDock User Guide

Welcome to VidDock! This guide covers everything you need to know to capture videos, archive multi-stream university lectures, manage download queues, and configure your output preferences.

---

## 1. Detecting Video Streams

As you browse the web, VidDock monitors network traffic and DOM video elements on active tabs.

### Toolbar Icon & Badge Indicator

The VidDock icon in your browser toolbar indicates detection status:

- **Grey Icon (No Badge):** No active video streams detected on the current page.
- **Blue Badge with Number (e.g., `1`, `2`):** Media streams detected and ready for download.
- **Violet/Purple Badge (`M` or stream count):** A Mediasite lecture presentation with dual-stream feeds is active on the page.

> [!TIP]
> If a video on a webpage hasn't been detected yet, press **Play** on the web player for 2–3 seconds. Many video players do not load HLS (`.m3u8`) or DASH (`.mpd`) manifests until playback begins.

---

## 2. Using the Extension Popup

Click the VidDock toolbar icon on any page with detected media to open the quick popup:

```
+-------------------------------------------------------------+
|  VidDock                          [Dashboard] [Settings]   |
+-------------------------------------------------------------+
|  Detected Media (2 streams)                                 |
|                                                             |
|  +-------------------------------------------------------+  |
|  | CS101 Lecture 14 - Distributed Systems                |  |
|  | HLS Stream (RFC 8216) • Duration: 01:14:22            |  |
|  |                                                       |  |
|  | Quality: [ 1080p (6.2 Mbps) ▼ ]   Format: MP4         |  |
|  |                                                       |  |
|  | [ Download 1080p ]                                    |  |
|  +-------------------------------------------------------+  |
|                                                             |
|  +-------------------------------------------------------+  |
|  | Supplementary Video Demonstration                     |  |
|  | Direct MP4 Stream • 1920x1080 • ~450 MB               |  |
|  |                                                       |  |
|  | [ Download MP4 ]                                      |  |
|  +-------------------------------------------------------+  |
+-------------------------------------------------------------+
```

### Media Stream Cards

Each card displays:

- **Title:** Page title or embedded media title.
- **Protocol Badge:** `HLS`, `DASH`, `Direct MP4`, `WebM`, or `Mediasite`.
- **Duration:** Total video runtime (hours:minutes:seconds).
- **Quality Selector:** Dropdown menu listing all available stream variants (e.g., `1080p (6.2 Mbps)`, `720p (3.1 Mbps)`, `480p (1.2 Mbps)`, or `Audio Only (192 kbps)`).
- **Download Action Button:** Initiates the download task immediately.

---

## 3. Capturing Mediasite Lectures

When you open a Mediasite university lecture (e.g., `https://mediasite.university.edu/.../Play/...`), VidDock's dedicated lecture engine activates automatically.

### Mediasite Dual-Stream Selector

Mediasite presentations typically broadcast two synchronized feeds:

1. **Presenter Camera Feed:** Video of the instructor.
2. **Slide / Screen Feed:** High-resolution digital whiteboard, slides, or screen recording.

VidDock allows you to choose your layout composition before downloading:

```
Select Mediasite Layout:
  (•) Side-by-Side (1920x540)
      Both feeds placed adjacent with aspect-ratio preserving padding.
  ( ) Picture-in-Picture (PiP)
      Full presentation slide feed with camera inset in the bottom-right corner.
  ( ) Separate Files
      Downloads Lecture-Camera.mp4 and Lecture-Slides.mp4 as independent files.
```

1. Select your preferred layout.
2. Select your target resolution.
3. Click **Download Presentation**. The native host companion downloads both video segments and audio tracks concurrently and performs composition and remuxing automatically.

---

## 4. Download Dashboard

Open the Dashboard by clicking the **Dashboard** button in the popup header or right-clicking the VidDock toolbar icon and selecting **Open Dashboard**.

```
+----------------------------------------------------------------------------------------+
|  VidDock Dashboard                     Tasks: 1 Active, 3 Completed    [Clear Finished] |
+----------------------------------------------------------------------------------------+
|                                                                                        |
|  CS101 Lecture 14 - Distributed Systems [Side-by-Side]                                 |
|  Status: Downloading (84% • 1,240 / 1,480 segments)                                     |
|  [====================================================--------]                        |
|  Speed: 14.2 MB/s • Transferred: 840 MB / 1.02 GB • ETA: 14s                           |
|  Actions: [ Pause ] [ Cancel ]                                                         |
|  ------------------------------------------------------------------------------------  |
|  Research Seminar - Quantum Computing                                                 |
|  Status: Completed • Saved to ~/Downloads/VidDock/Research Seminar.mp4                |
|  [============================================================] 100%                   |
|  Size: 420 MB • Duration: 48:12 • Format: MP4 (H.264 / AAC)                           |
|  Actions: [ Reveal in Finder ] [ Remove ]                                              |
|                                                                                        |
+----------------------------------------------------------------------------------------+
```

### Real-Time Task Information

- **Progress Bar & Byte Counters:** Live visual progress indicator and transferred bytes vs total estimated size.
- **Download Speed:** Live transfer throughput measured in MB/s.
- **Estimated Time Remaining (ETA):** Dynamically calculated based on rolling average network throughput.
- **Current Task Phase:**
  - `Queued`: Waiting for concurrency slot.
  - `Downloading`: Actively fetching segments over HTTP.
  - `Muxing`: Losslessly combining audio/video streams via FFmpeg.
  - `Verifying`: Probing output file with ffprobe to guarantee playback integrity.
  - `Completed`: File saved and ready to play.

### Task Control Actions

- **Pause / Resume:** Temporarily pause active HTTP chunk downloads and resume without losing previously downloaded segments.
- **Cancel:** Abort the download and automatically clean up scratch files.
- **Reveal in Finder:** Opens macOS Finder with the completed video file highlighted for immediate access.
- **Remove:** Clears the task entry from your dashboard history.

---

## 5. Configuring Settings & Preferences

Click the **Settings** icon in the popup or dashboard to customize VidDock:

### 1. Download Destination Directory

- **Default:** `~/Downloads/VidDock`
- Specify any directory inside your user home folder (e.g., `~/Movies/Lectures`).
- _Note:_ For security, VidDock enforces that download directories must reside within your user account (`~`).

### 2. Maximum Concurrent Downloads

- Slider from **1** to **8** parallel tasks.
- Defaults to **3** simultaneous tasks to optimize bandwidth without saturating your network connection.

### 3. Preferred Output Container

- **Auto (Recommended):** Chooses the best container without re-encoding (MP4 for H.264/AAC, WebM for VP9/Opus, MKV for complex or multi-track media).
- **Force MP4:** Saves as MP4 whenever compatible. If codecs cannot be placed in MP4 without transcoding (e.g., VP9 or Vorbis), VidDock saves as MKV and alerts you in the dashboard.
- **Force MKV:** Stores all media in open Matroska containers.

### 4. Filename Naming Template

Customize output filenames using template variables:

- Supported tokens:
  - `{title}`: Presentation or video title.
  - `{quality}`: Resolution or bitrate (e.g., `1080p`).
  - `{site}`: Domain of the source website (e.g., `mediasite.edu`).
  - `{id}`: Unique presentation or video identifier.
  - `{track}`: Stream label (e.g., `Camera`, `Slides`, or `Side-by-Side`).
  - `{date}`: Download date in `YYYY-MM-DD` format.
  - `{time}`: Download time in `HH-MM-SS` format.
- **Default Template:** `{title} - {quality}`
- Example Result: `CS101 Lecture 14 - 1080p.mp4`
