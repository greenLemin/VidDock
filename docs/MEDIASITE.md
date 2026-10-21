# Mediasite Lecture Archiving Architecture

This technical document details VidDock's purpose-built engine for detecting, parsing, and archiving university lectures recorded using the Sonic Foundry / Mediasite video platform.

---

## 1. Background: The Mediasite Platform

Mediasite is one of the most widely deployed enterprise lecture capture platforms in higher education and corporate training. A standard Mediasite presentation differs significantly from conventional single-stream web video (like YouTube or Vimeo) in three fundamental ways:

1. **Dual Independent Video Feeds:** Most academic recordings feature two distinct, simultaneous video streams:
   - **Stream 1 (Presenter):** High frame rate camera capture of the lecturer, podium, or chalkboard.
   - **Stream 2 (Presentation / Slides):** High-resolution digital capture of projected slide decks, laptop screens, or electronic whiteboards.
2. **Synchronized Playback:** In the web browser, the proprietary Mediasite HTML5 player dynamically coordinates two synchronized `<video>` elements, adjusting their positions depending on the user's viewing mode.
3. **Microsoft Smooth Streaming Legacy:** Many older Mediasite backends store media using Microsoft Smooth Streaming (`.ism/manifest`), which standard browser tools and media players cannot download directly.

---

## 2. Detection & Metadata Extraction

VidDock detects Mediasite recordings through a combination of content scripts (`content/mediasite_detector.ts`), URL patterns (`packages/shared/src/mediasite.ts`), and network request sniffing (`background/sniffer.ts`).

### 2.1 URL Matching & Presentation ID

Mediasite presentation URLs follow recognizable patterns:

```
https://mediasite.institution.edu/Mediasite/Play/a1b2c3d4e5f67890123456789abcdef01d
```

VidDock extracts the 32-character hexadecimal presentation ID using `mediasitePresentationId()`:

```typescript
export function mediasitePresentationId(url: string): string | undefined {
  const u = parseUrl(url);
  if (!u) return undefined;
  const m = /\/Play\/([0-9a-f]{32}[0-9a-f]*)/i.exec(u.pathname);
  return m?.[1];
}
```

### 2.2 Player Options API Interception

When the Mediasite web player initializes, it issues an HTTP POST request to its internal REST API:

```
POST /Mediasite/PlayerService/PlayerService.svc/json/GetPlayerOptions
```

Payload:

```json
{
  "getPlayerOptionsRequest": {
    "ResourceId": "a1b2c3d4e5f67890123456789abcdef01d",
    "QueryString": ""
  }
}
```

VidDock intercepts or triggers this request within the authenticated session context, receiving the structured `Presentation` response:

- `Presentation.Title`: Sanitized lecture title.
- `Presentation.Duration`: Total presentation length in milliseconds.
- `Presentation.Streams[]`: Array of video stream objects representing camera and slide feeds.
- `Presentation.Streams[].VideoUrls[]`: Direct media endpoints with their respective MIME types.

---

## 3. Smooth Streaming to HLS Translation

Many Mediasite servers serve video using Microsoft Smooth Streaming endpoints:

```
https://mediasite.institution.edu/.../Stream.ism/manifest
```

MIME type: `application/vnd.ms-sstr+xml`.

Smooth Streaming uses fragmented MP4 containers that standard HTTP downloaders cannot parse directly. However, Mediasite's underlying IIS Media Services engine supports dynamic Apple HLS packaging on demand.

VidDock automatically detects Smooth Streaming URLs and translates them into native Apple HLS playlists:

```typescript
export function deriveHlsFromSmooth(url: string): string {
  const base = url.replace(/\(format=[^)]*\)/i, '').replace(/\/manifest[^/]*$/i, '/manifest');
  return `${base}(format=m3u8-aapl)`;
}
```

**Example Translation:**

- _Input (Smooth Streaming):_  
  `https://cdn.mediasite.edu/OnDemand/Lecture.ism/manifest`
- _Output (Apple HLS):_  
  `https://cdn.mediasite.edu/OnDemand/Lecture.ism/manifest(format=m3u8-aapl)`

VidDock pre-flights the derived HLS URL. Once confirmed valid, the stream is downloaded using VidDock's high-speed HLS engine.

---

## 4. Dual-Stream Composition Layouts

When a presentation contains two video feeds, VidDock offers three composition modes:

### Mode 1: Side-by-Side (`side-by-side`)

Both feeds are placed side-by-side in a single 1920x540 video canvas. Each stream is scaled to 960x540 with aspect-ratio preserving letterbox padding:

```
+-----------------------------------+-----------------------------------+
|                                   |                                   |
|       Presenter Camera Feed       |     Presentation Slides Feed      |
|             (960x540)             |             (960x540)             |
|                                   |                                   |
+-----------------------------------+-----------------------------------+
                                 1920x540
```

**FFmpeg Filter Graph (`mux.ts`):**

```
[0:v:0]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1[left];
[1:v:0]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1[right];
[left][right]hstack=inputs=2[v]
```

- Preserves the full aspect ratio of wide presentation slides.
- Audio from the primary microphone feed is copied directly (`-c:a copy`).

### Mode 2: Picture-in-Picture (`pip`)

The slide presentation is displayed in full resolution as the background canvas, while the presenter camera video is overlaid in the lower-right corner at 1/3.5 scale with 24px margins:

```
+-----------------------------------------------------------------------+
|                                                                       |
|                       Presentation Slide Feed                         |
|                             (Full HD)                                 |
|                                                                       |
|                                           +-----------------------+   |
|                                           |     Presenter Feed    |   |
|                                           |     (1/3.5 Scale)     |   |
|                                           +-----------------------+   |
|                                                                24px   |
+-----------------------------------------------------------------------+
```

**FFmpeg Filter Graph (`mux.ts`):**

```
[1:v:0]scale=iw/3.5:-2,setsar=1[pip];
[0:v:0]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[main];
[main][pip]overlay=W-w-24:H-h-24[v]
```

#### The `trunc(iw/2)*2` Dimension Normalization

In H.264 video with `yuv420p` chroma subsampling, image width and height must strictly be **even numbers**. Arbitrary camera resolutions scaled down by 3.5 could produce odd pixel dimensions (e.g., 549 pixels), causing FFmpeg encode failure.

VidDock explicitly normalizes dimensions:

- `scale=iw/3.5:-2`: Forces the height to be an even number proportional to aspect ratio.
- `trunc(iw/2)*2:trunc(ih/2)*2`: Guarantees the base canvas dimensions are cleanly divisible by 2.

### Mode 3: Separate Streams (`separate`)

Downloads each stream as an individual, standalone high-definition file:

- `CS101 - Lecture 1 - Camera.mp4`
- `CS101 - Lecture 1 - Slides.mp4`

Both files retain their original bitrate and container, utilizing lossless stream copying (`-c copy`) with zero transcoding overhead.

---

## 5. University SSO & Session Cookie Handling

Most university Mediasite portals are protected behind institutional Single Sign-On (SSO) systems (e.g. Shibboleth, CAS, SAML, Okta). Direct curl or external downloaders fail with `401 Unauthorized` or `403 Forbidden` because they lack session authentication cookies.

VidDock resolves this seamlessly through browser-companion credential preservation:

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Student
    participant Browser as Chrome (Authenticated Tab)
    participant Extension as VidDock Extension (MV3)
    participant Host as Native Host (com.viddock.host)
    participant CDN as Mediasite Video Server

    User->>Browser: Log in via University SSO & Open Lecture
    Browser->>CDN: Request Mediasite Video Streams
    Note over Browser,CDN: Carries ASP.NET_SessionId, MediasiteAuth, etc.
    CDN-->>Browser: HTTP 200 OK (Stream Delivered)
    Extension->>Browser: Sniff active headers (Referer, Cookie, User-Agent)
    User->>Extension: Click Download in Popup UI
    Extension->>Host: download.start (Task Spec + Captured Headers)
    Note over Host: Headers sanitized; zero telemetry sent
    Host->>CDN: GET /segment_001.ts (With Auth Cookies)
    CDN-->>Host: HTTP 200 OK (Encrypted / Raw Video Chunks)
    Host->>Host: Assemble & Lossless Remux
    Host-->>Extension: task.update (100% Completed)
```

1. **Header Capture:** When the browser requests media playlists, the background sniffer captures the active `Cookie`, `Referer`, and `User-Agent` headers for that specific origin.
2. **Safe Handover:** Headers are passed directly to the native host companion inside the local stdio JSON message payload.
3. **Reproduced Requests:** The native host's HTTP client reproduces these headers during segment downloads, ensuring uninterrupted access to protected lecture recordings without requiring credentials to be re-entered.
