# VidDock Supported Formats & Codecs

This document details VidDock's streaming protocol compatibility, container formatting logic, and codec handling capabilities.

---

## 1. Streaming Protocols

VidDock is engineered to parse, reconstruct, and archive modern adaptive bitrate and direct media streams:

| Protocol              | Specification    | Manifest / Extension                    | Support Level | Implementation Notes                                                                                                    |
| :-------------------- | :--------------- | :-------------------------------------- | :-----------: | :---------------------------------------------------------------------------------------------------------------------- |
| **Apple HLS**         | RFC 8216         | `.m3u8`                                 |   **Full**    | Master playlists, variant streams, byte ranges (`EXT-X-BYTERANGE`), AES-128 segment decryption.                         |
| **MPEG-DASH**         | ISO/IEC 23009-1  | `.mpd`                                  |   **Full**    | Static and dynamic MPDs, `SegmentTemplate` (`$Number$`, `$Time$`), `SegmentList`, separate audio/video representations. |
| **Mediasite**         | Proprietary REST | `GetPlayerOptions`                      |   **Full**    | Auto-detection, Smooth Streaming to HLS translation, synchronized dual-feed capture.                                    |
| **Smooth Streaming**  | Microsoft SSTR   | `.ism/manifest`                         |  **Via HLS**  | Dynamically translated to Apple HLS `(format=m3u8-aapl)`.                                                               |
| **Direct HTTP Media** | RFC 7233         | `.mp4`, `.webm`, `.m4v`, `.mov`, `.mp3` |   **Full**    | Multi-threaded byte-range downloading with resumption.                                                                  |

---

## 2. Video Codec Compatibility

VidDock preserves native video bitstreams wherever possible, eliminating generational transcoding loss:

| Video Codec       | FourCC / Identifier |    Output Containers    |  Native Remuxing?  | QuickTime / Apple Notes                                           |
| :---------------- | :------------------ | :---------------------: | :----------------: | :---------------------------------------------------------------- |
| **H.264 / AVC**   | `avc1`, `h264`      |     `.mp4`, `.mkv`      | **Yes (Lossless)** | Fully compatible with QuickTime, iOS, Safari, and Finder.         |
| **H.265 / HEVC**  | `hvc1`, `hev1`      |     `.mp4`, `.mkv`      | **Yes (Lossless)** | Muxer automatically tags `-tag:v hvc1` for native macOS playback. |
| **VP9**           | `vp09`, `vp9`       |     `.webm`, `.mkv`     | **Yes (Lossless)** | Supported natively in Chrome, Firefox, and VLC.                   |
| **AV1**           | `av01`              | `.mp4`, `.webm`, `.mkv` | **Yes (Lossless)** | Modern royalty-free codec; supported in Chrome and modern macOS.  |
| **VP8**           | `vp8`               |     `.webm`, `.mkv`     | **Yes (Lossless)** | Supported in WebM containers.                                     |
| **MPEG-4 Part 2** | `mp4v`              |     `.mp4`, `.mkv`      | **Yes (Lossless)** | Legacy format compatibility.                                      |

---

## 3. Audio Codec Compatibility

Adaptive streaming platforms frequently transmit audio in separate tracks from video. VidDock downloads and multiplexes audio seamlessly:

| Audio Codec                     | Profile / Details    |    Output Containers    |  Native Remuxing?  | Notes                                            |
| :------------------------------ | :------------------- | :---------------------: | :----------------: | :----------------------------------------------- |
| **AAC (Advanced Audio Coding)** | LC, HE-AAC, LD       | `.mp4`, `.m4a`, `.mkv`  | **Yes (Lossless)** | Universal web and Apple audio format.            |
| **Opus**                        | RFC 6716 (48 kHz)    | `.webm`, `.mkv`, `.ogg` | **Yes (Lossless)** | Primary audio codec in YouTube and DASH streams. |
| **MP3 (MPEG Audio Layer III)**  | ISO/IEC 11172-3      | `.mp3`, `.mp4`, `.mkv`  | **Yes (Lossless)** | Standard legacy MP3.                             |
| **Vorbis**                      | Ogg Vorbis           | `.webm`, `.ogg`, `.mkv` | **Yes (Lossless)** | Open web audio standard.                         |
| **FLAC**                        | Free Lossless Audio  | `.flac`, `.mp4`, `.mkv` | **Yes (Lossless)** | Lossless audio compression.                      |
| **ALAC**                        | Apple Lossless       | `.m4a`, `.mp4`, `.mkv`  | **Yes (Lossless)** | Native Apple lossless audio.                     |
| **AC-3 / E-AC-3**               | Dolby Digital / Plus |     `.mp4`, `.mkv`      | **Yes (Lossless)** | Surround sound multi-channel streams.            |

---

## 4. Subtitle & Closed Caption Formats

When subtitle tracks are embedded in HLS or DASH manifests, VidDock extracts and embeds them into the container:

| Format                | Source             | Output Mapping                                     | Behavior                                                 |
| :-------------------- | :----------------- | :------------------------------------------------- | :------------------------------------------------------- |
| **WebVTT** (`.vtt`)   | HLS / DASH         | `mov_text` (MP4) or `webvtt` (WebM) or `srt` (MKV) | Text subtitles converted to container-compatible stream. |
| **SubRip** (`.srt`)   | Direct / Extracted | `srt` (MKV) or `mov_text` (MP4)                    | Embedded subtitle track with language metadata.          |
| **CEA-608 / CEA-708** | Embedded SEI       | Copied directly in video stream                    | Preserved inside video bitstream for capable players.    |

---

## 5. Container Selection Matrix (`mux.ts`)

To prevent corrupted files and broken playback, VidDock strictly **refuses to relabel incompatible streams with fake file extensions** (e.g. wrapping VP9 or Opus inside an MP4 file).

The container engine (`chooseContainer`) follows these deterministic rules:

```
                            Input Stream Analysis
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
             Has Video Streams?                   Audio-Only Stream
                   │                                     │
         ┌─────────┴─────────┐                  ┌────────┴────────┐
         ▼                   ▼                  ▼                 ▼
  All Video/Audio       Contains VP9/Opus     Single AAC/ALAC   Single MP3/FLAC
  in MP4 Safe Set?      or Non-MP4 Codecs        Stream?            Stream?
  (H.264/HEVC + AAC)         │                  │                 │
         │                   ▼                  ▼                 ▼
         ▼              Output: .webm          Output: .m4a     Output: .mp3/.flac
    Output: .mp4       (or .mkv fallback)
```

### Safe Codec Sets

- **MP4 Safe Video:** `h264`, `hevc`, `av1`, `vp9` _(only if audio compatible)_, `mpeg4`.
- **MP4 Safe Audio:** `aac`, `mp3`, `ac3`, `eac3`, `opus`, `flac`, `alac`.
- **WebM Safe Video:** `vp8`, `vp9`, `av1`.
- **WebM Safe Audio:** `opus`, `vorbis`.
- **Fallback Container:** If an input contains codecs that cannot be encapsulated in the user's preferred format without transcoding, VidDock saves the file in an open **Matroska (`.mkv`)** container and notes the reason in the dashboard.
