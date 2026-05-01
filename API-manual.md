# ElementReview API Manual

## Overview

ElementReview exposes a local HTTP API used by:

- the main operator UI in `index.html`
- the settings window in `config.html`
- the separate Judge Video Replay app in `JudgeVideoReplay/wwwroot/judge-video-replay.html`
- trusted local or LAN clients

Base URL:

```text
http://localhost:5050
```

The API has no authentication layer. Treat it as a trusted local/LAN interface.

## Response Conventions

- Most endpoints return JSON.
- Media endpoints return MP4 files or HTML pages.
- Replay edit endpoints return the updated session status.

Common status codes:

- `200 OK`
- `400 Bad Request`
- `404 Not Found`

## Canonical JSON Shapes

### AppConfig

`GET /api/appconfig` and `POST /api/appconfig` mostly use PascalCase property names. The low-res bitrate field uses the lower-case name shown below:

```json
{
  "Language": "en",
  "UiZoomPercent": 90,
  "ClipMarkerAdvanceMsec": 500,
  "DemoMode": true,
  "RtspUrl": "rtsp://192.168.6.200:8554/0",
  "SourceFps": 30,
  "RtspTransportProtocol": "UDP",
  "UseHardwareEncodingWhenAvailable": true,
  "highresVideoGop": 10,
  "lowresVideoBitrate": 2500,
  "lowresVideoGop": 60,
  "CSSLink": "Legacy",
  "DatabaseLocation": "localhost",
  "EventId": "",
  "CSSServerHost": "",
  "SaveVideos": false,
  "SavedVideosFolder": "C:/Event_Videos"
}
```

### SessionInfo

`GET /api/sessionInfo` returns the raw SessionInfo payload. The app expects the current canonical shape:

```json
{
  "categoryName": "STAR 10",
  "categoryDiscipline": "Women",
  "categoryFlight": "Grp 1",
  "segmentName": "Free Program",
  "segmentProgHalfTime": "1:30",
  "competitorFirstName": "Cindy",
  "competitorLastName": "Smith",
  "competitorClub": "Example Club",
  "competitorSection": "ON",
  "elements": {
    "1": { "code": "2A", "review": false },
    "2": { "code": "LSp4", "review": true }
  }
}
```

### Status

`GET /api/status` and most replay-edit endpoints return:

```json
{
  "mode": "replay",
  "isArming": false,
  "isRecording": false,
  "recordingDurationSeconds": 42.6,
  "programTimerStartOffsetSeconds": 4.0,
  "replayMediaToken": "6f7f9f8df8a146c897dce3239f9b7976",
  "clips": [
    {
      "index": 1,
      "startSeconds": 4.2,
      "endSeconds": 6.8,
      "everMarkedForReview": false
    }
  ],
  "openClipStartSeconds": null,
  "canUndoClipAction": false,
  "canRedoClipAction": false,
  "sourceFps": 60
}
```

## Endpoint Summary

| Method | Path | Purpose |
| - | - | - |
| `GET` | `/api/liveUrl` | Get the live-view URL for the operator UI |
| `GET` | `/api/status` | Get current session status |
| `GET` | `/api/appconfig` | Read app configuration |
| `POST` | `/api/appconfig` | Save app configuration |
| `GET` | `/api/appinfo` | Get app version info |
| `GET` | `/api/sessionInfo` | Read current SessionInfo payload |
| `GET` | `/api/demoVideo` | Stream the demo video |
| `GET` | `/demo-live` | Demo-video player page |
| `GET` | `/rtsp-live` | RTSP live player page |
| `POST` | `/api/record/start` | Start recording |
| `POST` | `/api/record/stop` | Stop recording |
| `POST` | `/api/record/clipToggle` | Start or stop the current clip |
| `POST` | `/api/record/undo` | Undo the last record-mode clip action |
| `POST` | `/api/record/redo` | Redo the last undone record-mode clip action |
| `POST` | `/api/session/clear` | Clear the session / next competitor |
| `GET` | `/api/recording/file` | Stream the replay MP4 |
| `POST` | `/api/replay/delete` | Delete a replay clip |
| `POST` | `/api/record/delete` | Delete a clip while still recording |
| `POST` | `/api/replay/split` | Split a replay clip |
| `POST` | `/api/replay/insert` | Insert a replay clip |
| `POST` | `/api/replay/trimIn` | Trim a clip start |
| `POST` | `/api/replay/trimOut` | Trim a clip end |
| `POST` | `/api/app/restart` | Restart the native shell app |
| `GET` | `/api/hostping` | Ping a host for settings diagnostics |

## Live Video

### GET `/api/liveUrl`

Returns the URL the operator UI should load for live viewing.

RTSP mode example:

```json
{
  "url": "http://127.0.0.1:8889/mystream?controls=false&muted=true&autoplay=true",
  "mode": "rtsp"
}
```

Demo mode example:

```json
{
  "url": "/demo-live?ts=1712260000000",
  "mode": "demo"
}
```

### GET `/demo-live`

Returns an HTML page that plays the active demo video.

### GET `/rtsp-live`

Returns an HTML page that attaches a WHEP/WebRTC player to the MediaMTX relay.

### GET `/api/demoVideo`

Returns the active demo MP4 with range support.

Resolution order:

1. `%LocalAppData%\ElementReview\data\demovideo.mp4`
2. `data\demovideo.mp4`

## Status And Configuration

### GET `/api/status`

Returns the current session status.

### GET `/api/appconfig`

Returns the current `AppConfig` object in PascalCase.

### POST `/api/appconfig`

Saves the supplied `AppConfig` and returns the normalized result.

Notes:

- `SaveVideos` is forced off in demo mode.
- `SavedVideosFolder` is defaulted if blank.
- Missing or invalid `lowresVideoBitrate` defaults to `2500` kbps.
- Missing or invalid `highresVideoGop` defaults to `10`.
- Missing or invalid `lowresVideoGop` defaults to `60`.

### GET `/api/appinfo`

Returns the app version:

```json
{
  "version": "v0.5.2"
}
```

## SessionInfo

### GET `/api/sessionInfo`

Returns the current `SessionInfo.json` contents.

If CSS link mode is `None`, or if the file is missing, the server returns:

```json
{
  "elements": {}
}
```

The endpoint also updates backend review history so replay clips can stay marked after playback begins.

## Recording

### POST `/api/record/start`

Starts recording.

Request body:

```json
{
  "demoStartSeconds": 12.4
}
```

`demoStartSeconds` is used only in demo mode.

Returns the current status object.

### POST `/api/record/stop`

Stops recording and finalizes replay assets.

Request body:

```json
{
  "uiElapsedSeconds": 38.2,
  "programTimerStartOffsetSeconds": 4.0
}
```

`programTimerStartOffsetSeconds` is optional. When supplied, replay clients can show timeline values relative to the operator's Set Start point, including negative timeline values before that point.

Returns the current status object.

### POST `/api/record/clipToggle`

Starts or stops the current clip marker.

Request body:

```json
{
  "nowSeconds": 14.7
}
```

Returns the current status object.

### POST `/api/record/undo`

Undoes the last record-mode clip action.

Returns the current status object.

### POST `/api/record/redo`

Redoes the last undone record-mode clip action.

Returns the current status object.

### POST `/api/record/delete`

Deletes a completed clip while still in record mode.

Request body:

```json
{
  "index": 3
}
```

Returns the current status object.

### POST `/api/session/clear`

Stops any running recorder, deletes the current replay files, resets session state, and returns the cleared status.

## Replay File Delivery

### GET `/api/recording/file`

Streams the current replay MP4 with range support.

Query options:

- no query string or `?kind=high-res`: high-res operator replay file
- `?kind=low-res`: low-res Judge Video Replay and saved-video replay file
- `v=<ReplayMediaToken>`: required for low-res replay requests

Low-res requests should include the current replay media token as `v=<ReplayMediaToken>`. If the token is stale, the server returns `404 Not Found`.

Operator high-res replay requests are served directly. PRC low-res requests are demand-driven and enter the PRC transfer path. The backend does not preload, throttle, or cap concurrent PRC transfers.

ElementReview records both files while the recording is in progress. `current-high-res.mp4` is encoded with the configured `highresVideoGop`, which is the high-res/operator replay GOP; `current-low-res.mp4` is encoded as 720p/30 fps with the configured `lowresVideoGop` and `lowresVideoBitrate` values. When `SaveVideos` is enabled, the low-res file also includes AAC audio from the source for saved copies; PRCs keep playback muted. When `UseHardwareEncodingWhenAvailable` is enabled and supported hardware is available, both files use the same hardware encoder. Otherwise both use software encoding.

## Judge Video Replay App

The remote Judge Video Replay UI is packaged in the separate Judge Video Replay app under `JudgeVideoReplay/wwwroot`. It loads locally inside `JudgeVideoReplay.exe` and uses the ElementReview backend API endpoints `/api/status`, `/api/sessionInfo`, and `/api/recording/file`.

Run `JudgeVideoReplay.exe` on each judge or referee computer. In the app settings, set the Server IP address to the computer running ElementReview.

Query options:

- `autoplay=false` or `a=false`: disable initial autoplay.
- `loop=false` or `l=false`: disable looping the selected clip.
- `timer=true` or `tm=true`: show the Judge Video Replay timer control.

Judge Video Replay behavior:

- element rail buttons 1-15 represent clipped element regions
- element rail buttons are clickable immediately
- clicking an element clip autoplays that clipped region on a loop
- the video icon button beneath the element rail appears when replay media is available and opens the full-video timeline with blue numbered clip markers
- PRCs cache chunks on demand as playback or seeking requests them
- cached chunks are reused, so repeated playback of the same region does not download the same bytes again
- full Judge Video Replay mode shows a session info bar when replay clips are available
- the session info bar includes the category, discipline, flight, segment, competitor name, and a refresh button
- the Judge Video Replay timer range is drawn above element clip blocks and remains translucent

`judge.html` has been removed; use the Judge Video Replay app for remote replay.

## Replay Editing

### POST `/api/replay/delete`

Request body:

```json
{
  "index": 2
}
```

### POST `/api/replay/split`

Request body:

```json
{
  "index": 2,
  "splitSeconds": 17.5
}
```

### POST `/api/replay/insert`

Request body:

```json
{
  "startSeconds": 22.0,
  "endSeconds": 23.0
}
```

### POST `/api/replay/trimIn`

Request body:

```json
{
  "clipIndex": 2,
  "atSeconds": 16.9
}
```

### POST `/api/replay/trimOut`

Request body:

```json
{
  "clipIndex": 2,
  "atSeconds": 18.1
}
```

All replay-edit endpoints return the updated status object.

## Restart And Diagnostics

### POST `/api/app/restart`

Requests a native-shell restart.

Success response:

```json
{
  "ok": true
}
```

### GET `/api/hostping?host=...`

Pings a host for settings diagnostics.

Example response:

```json
{
  "ok": true,
  "host": "192.168.6.200",
  "roundTripMs": 3,
  "color": "green",
  "error": ""
}
```

Error example:

```json
{
  "ok": false,
  "host": "",
  "roundTripMs": null,
  "color": "red",
  "error": "Missing host."
}
```
