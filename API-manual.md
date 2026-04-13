# ElementReview API Manual

## Overview

ElementReview exposes a local HTTP API used by:

- the main operator UI in `index.html`
- the settings UI in `config.html`
- remote replay clients such as `judge.html`
- any other trusted local/LAN clients you build later

The API is implemented as an ASP.NET Core minimal API and listens on:

```text
http://0.0.0.0:5050
```

Typical local access:

```text
http://localhost:5050
http://127.0.0.1:5050
```

## What The API Covers

- live video source selection
- session status
- app configuration
- SessionInfo / element metadata
- recording start/stop
- clip marking and undo
- session clear / next competitor
- replay file delivery
- replay clip editing
- app restart from the settings window
- simple host ping checks for settings validation

## General Conventions

### Base URL

`http://localhost:5050`

### Authentication

There is currently no authentication or authorization layer. Any machine that can reach the API can call it.

### Content Type

Most `POST` endpoints use JSON:

```http
Content-Type: application/json
```

### Success Responses

Most endpoints return JSON.

Exceptions:

- `GET /api/demoVideo` returns an MP4 file
- `GET /api/recording/file` returns an MP4 file
- `GET /demo-live` returns HTML

### Common Status Codes

- `200 OK` for success
- `400 Bad Request` for malformed replay edit requests
- `404 Not Found` when expected media is missing

## Files And Data Sources

The app uses these local content-root files:

- `data/appconfig.json`
- `data/demovideo.mp4`
- `data/SessionInfo.json`
- `data/current-encoded.mp4`
- `data/current-copied.mp4`

It also checks for this external SessionInfo file first:

```text
C:\ElementReview\data\SessionInfo.json
```

If that external file exists, it is preferred over local `data/SessionInfo.json`.

When Legacy CSS integration is enabled, the separately deployed helper
`GetSessionInfo_LegacyCSS.exe` is expected to keep that SessionInfo JSON updated.
The helper must live beside the running `ElementReview.exe`.

## Endpoint Summary

| Method | Path | Purpose |
| - | - | - |
| `GET` | `/api/liveUrl` | Get the live viewing URL |
| `GET` | `/api/status` | Get current session status |
| `GET` | `/api/appconfig` | Read app configuration |
| `POST` | `/api/appconfig` | Save app configuration |
| `GET` | `/api/elements` | Read SessionInfo / element metadata |
| `GET` | `/api/demoVideo` | Stream the demo MP4 |
| `GET` | `/demo-live` | HTML wrapper for demo playback |
| `POST` | `/api/record/start` | Start recording |
| `POST` | `/api/record/stop` | Stop recording |
| `POST` | `/api/record/clipToggle` | Open or close a clip marker |
| `POST` | `/api/record/undo` | Undo the last clip action |
| `POST` | `/api/session/clear` | Clear session / next competitor |
| `GET` | `/api/recording/file` | Stream the current replay file |
| `POST` | `/api/replay/delete` | Delete a clip |
| `POST` | `/api/replay/split` | Split a clip |
| `POST` | `/api/replay/insert` | Insert a clip |
| `POST` | `/api/replay/trimIn` | Trim clip start |
| `POST` | `/api/replay/trimOut` | Trim clip end |
| `POST` | `/api/app/restart` | Restart the native shell app |
| `GET` | `/api/hostping` | Ping a host for config diagnostics |

## Live Video Endpoints

### GET `/api/liveUrl`

Returns the URL the UI should load for live viewing.

#### Behavior

- In normal mode, ensures MediaMTX is running and returns a WebRTC embed URL.
- In demo mode, returns `/demo-live?...`.
- Also warms the recorder so the first record click has less startup work.

#### Example

```bash
curl http://localhost:5050/api/liveUrl
```

#### Example response

```json
{
  "url": "http://127.0.0.1:8889/mystream?controls=false&muted=true&autoplay=true",
  "mode": "rtsp"
}
```

Demo mode:

```json
{
  "url": "/demo-live?ts=1712260000000",
  "mode": "demo"
}
```

### GET `/demo-live`

Returns a small HTML page that plays the local demo video in a fullscreen `<video>` element.

### GET `/api/demoVideo`

Returns `data/demovideo.mp4` with byte-range support.

#### Example

```bash
curl -O http://localhost:5050/api/demoVideo
```

## Status And Configuration

### GET `/api/status`

Returns the current recording/replay session state.

#### Common fields

- `mode`
- `isArming`
- `isRecording`
- `recordingDurationSeconds`
- `sourceFps`
- `clips`
- `openClipStartSeconds`

#### Example

```bash
curl http://localhost:5050/api/status
```

```json
{
  "mode": "replay",
  "isRecording": false,
  "recordingDurationSeconds": 42.6,
  "sourceFps": 60,
  "clips": [
    {
      "index": 1,
      "startSeconds": 4.2,
      "endSeconds": 6.8,
      "everMarkedForReview": false
    }
  ],
  "openClipStartSeconds": null
}
```

### GET `/api/appconfig`

Returns the current app configuration.

Current `AppConfig` fields are:

- `RecordingGop`
- `RtspUrl`
- `DemoMode`
- `UseHardwareEncodingWhenAvailable`
- `SourceFps`
- `ClipMarkerAdvanceMsec`
- `SaveVideos`
- `CSSLink`
- `EventId`
- `DatabaseLocation`
- `CSSServerHost`
- `SavedVideosFolder`
- `Language`
- `UiZoomPercent`

#### Example

```bash
curl http://localhost:5050/api/appconfig
```

### POST `/api/appconfig`

Saves a full configuration object to `data/appconfig.json`.

#### Behavior

- writes the config to disk
- normalizes CSS link values such as `Legacy`, `Online CSS`, and `Offline CSS`
- restarts MediaMTX when `DemoMode` is `false`

#### Example

```bash
curl -X POST http://localhost:5050/api/appconfig \
  -H "Content-Type: application/json" \
  -d '{
    "DemoMode": false,
    "RtspUrl": "rtsp://192.168.6.200:8554/0",
    "SourceFps": 60,
    "ClipMarkerAdvanceMsec": 1000,
    "UiZoomPercent": 90
  }'
```

## SessionInfo And Elements

### GET `/api/elements`

Returns the contents of the active SessionInfo JSON.

This is used for:

- category / discipline / flight / segment text
- competitor metadata
- element codes
- review flags
- segment progress values such as `segmentProgHalfTime`

It also updates review history in the session manager before returning the JSON.
The endpoint returns the raw JSON payload from the active SessionInfo source.

#### Example

```bash
curl http://localhost:5050/api/elements
```

```json
{
  "categoryName": "STAR 5",
  "categoryDiscipline": "Women",
  "categoryFlight": "Grp 1",
  "segmentName": "Free Program",
  "segmentProgHalfTime": "1:30",
  "competitorFirstName": "Judy",
  "competitorLastName": "Testee",
  "elements": {
    "1": { "code": "3F", "review": false },
    "2": { "code": "3F+3T*+COMBO", "review": false },
    "3": { "code": "2A+2A+SEQ", "review": true }
  }
}
```

If the SessionInfo file is missing or unreadable, the endpoint falls back to:

```json
{
  "elements": {}
}
```

## Recording Endpoints

### POST `/api/record/start`

Starts a new recording.

#### Behavior

- loads app config
- ensures MediaMTX is running when not in demo mode
- starts FFmpeg recording
- returns updated session status

#### Body

```json
{
  "demoStartSeconds": 12.5
}
```

`demoStartSeconds` is only relevant in demo mode.

### POST `/api/record/stop`

Stops the current recording.

#### Body

```json
{
  "uiElapsedSeconds": 37.42
}
```

#### Behavior

- finalizes the encoded and copied MP4 files
- probes duration from the encoded file
- transitions session mode to replay
- optionally saves a permanent copy if `SaveVideos` is enabled

### POST `/api/record/clipToggle`

Opens or closes a clip marker during recording.

#### Body

```json
{
  "nowSeconds": 15.83
}
```

#### Important note

The browser client applies `ClipMarkerAdvanceMsec` before calling this endpoint when opening a clip. The backend uses the timestamp it receives.

If you write your own recording client and want the same behavior as `index.html`, you must subtract clip advance yourself before opening the clip.

### POST `/api/record/undo`

Undoes the last clip action during recording.

#### Example

```bash
curl -X POST http://localhost:5050/api/record/undo
```

### POST `/api/session/clear`

Clears the current session, deletes current temporary/current replay files, and resets the app back to record mode.

This is the backend used by the operator's `Next Competitor` flow.

## Replay File Endpoint

### GET `/api/recording/file`

Streams the current replay MP4 with range support.

#### Query parameter

`kind` is optional.

Current behavior:

- omitted or unknown `kind` -> encoded replay file
- `kind=copied` -> copied/smaller replay file
- `kind=remote` -> copied/smaller replay file

`remote` is the public-facing alias intended for remote replay clients such as `judge.html`, `ref.html`, and `broadcaster.html`.

#### Examples

Encoded/default:

```bash
curl -O "http://localhost:5050/api/recording/file"
```

Remote/copied:

```bash
curl -O "http://localhost:5050/api/recording/file?kind=remote"
```

#### Caching behavior

This endpoint currently:

- supports range requests
- returns `ETag`
- returns `Last-Modified`
- sends `Cache-Control: public, max-age=0, must-revalidate`

That means browsers may cache the file locally, but they should revalidate it before reusing it as the current recording.

## Replay Editing Endpoints

All replay editing endpoints return updated session status on success.

### POST `/api/replay/delete`

Deletes a clip.

Accepted index fields:

- `clipIndex`
- `ClipIndex`
- `index`
- `Index`

#### Example

```bash
curl -X POST http://localhost:5050/api/replay/delete \
  -H "Content-Type: application/json" \
  -d '{ "clipIndex": 3 }'
```

### POST `/api/replay/split`

Splits a clip at a time point.

Accepted clip index fields:

- `clipIndex`
- `ClipIndex`
- `index`
- `Index`

Accepted time fields:

- `splitSeconds`
- `SplitSeconds`
- `atSeconds`
- `AtSeconds`
- `nowSeconds`
- `NowSeconds`
- `timeSeconds`
- `TimeSeconds`

#### Example

```bash
curl -X POST http://localhost:5050/api/replay/split \
  -H "Content-Type: application/json" \
  -d '{
    "clipIndex": 2,
    "splitSeconds": 14.25
  }'
```

### POST `/api/replay/insert`

Inserts a new clip.

Accepted forms:

Explicit start/end:

```json
{
  "startSeconds": 22.0,
  "endSeconds": 23.0
}
```

Insert a default 1-second clip:

```json
{
  "atSeconds": 22.0
}
```

Accepted field name variants:

- `startSeconds` / `StartSeconds`
- `endSeconds` / `EndSeconds`
- `atSeconds` / `AtSeconds`
- `nowSeconds` / `NowSeconds`
- `timeSeconds` / `TimeSeconds`

### POST `/api/replay/trimIn`

Moves the start of a clip inward.

Accepted index fields:

- `clipIndex`
- `ClipIndex`
- `index`
- `Index`

Accepted time fields:

- `atSeconds`
- `AtSeconds`
- `nowSeconds`
- `NowSeconds`
- `timeSeconds`
- `TimeSeconds`

### POST `/api/replay/trimOut`

Moves the end of a clip inward.

Accepted index fields:

- `clipIndex`
- `ClipIndex`
- `index`
- `Index`

Accepted time fields:

- `atSeconds`
- `AtSeconds`
- `nowSeconds`
- `NowSeconds`
- `timeSeconds`
- `TimeSeconds`

## Utility / Shell Endpoints

### POST `/api/app/restart`

Requests a native app restart.

#### Important limitation

This only works when ElementReview is running inside the native Windows shell app. If the web server is running without that shell integration, the endpoint returns:

```text
400 Bad Request
Restart is only available when running the native shell app.
```

### GET `/api/hostping?host=...`

Pings a host for config diagnostics.

#### Example

```bash
curl "http://localhost:5050/api/hostping?host=192.168.6.50"
```

#### Example response

```json
{
  "ok": true,
  "host": "192.168.6.50",
  "roundTripMs": 12,
  "color": "green"
}
```

Failure example:

```json
{
  "ok": false,
  "host": "192.168.6.50",
  "roundTripMs": null,
  "color": "red",
  "error": "TimedOut"
}
```

## Typical Workflows

### Standard recording workflow

1. `GET /api/liveUrl`
2. `POST /api/record/start`
3. `POST /api/record/clipToggle` to open a clip
4. `POST /api/record/clipToggle` to close the clip
5. `POST /api/record/stop`
6. `GET /api/recording/file`

### Remote replay workflow

1. `GET /api/status` until the app is in replay mode and the requested clip exists
2. `GET /api/recording/file?kind=remote`
3. Use clip timing from `/api/status` to drive the remote replay UI

### Replay editing workflow

1. `GET /api/status`
2. Choose a target clip and time
3. Call one of:
   - `/api/replay/delete`
   - `/api/replay/split`
   - `/api/replay/insert`
   - `/api/replay/trimIn`
   - `/api/replay/trimOut`
4. Read the returned updated status

## Integration Notes

### Client-supplied timing matters

Several endpoints depend on timestamps supplied by the client:

- `demoStartSeconds`
- `uiElapsedSeconds`
- `nowSeconds`
- `splitSeconds`
- `atSeconds`
- `timeSeconds`

External clients must compute these values consistently.

### SessionInfo priority

Metadata is read from:

1. `C:\ElementReview\data\SessionInfo.json`
2. local `data/SessionInfo.json`

If values look stale or unexpected, inspect the external file first.

In Legacy CSS mode, that file is typically maintained by `GetSessionInfo_LegacyCSS.exe`.

### Remote replay asset naming

Use `kind=remote` for remote replay clients.

`kind=copied` still points to the same file, but `remote` is the preferred external/client-facing name.

### No access control

If the API is reachable on the LAN, other trusted machines can control recording and replay editing. If that matters operationally, place it behind network controls, firewall rules, or a trusted isolated LAN.
