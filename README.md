# ElementReview

ElementReview is a Windows desktop recording and replay tool for figure skating competitions. It combines:

- a local ASP.NET Core server
- a Windows Forms shell
- a WebView2 operator UI
- `ffmpeg` / `ffprobe` for recording
- MediaMTX for live RTSP relay into the browser UI

The current app version is `v0.5.0`.

## What It Does

ElementReview is built around a fast record-to-review workflow:

1. show a live RTSP feed or demo video
2. start recording
3. mark element clips while the skater is performing
4. stop recording and switch straight into replay mode
5. trim, split, insert, or delete replay clips
6. expose the replay locally or over the LAN for panel review

Current operator features include:

- record mode with clip start/stop marking
- record-mode undo/redo
- optional halfway/program timer tracking
- replay playback, scrubbing, looping, zoom, and frame stepping
- replay clip editing
- English/French UI switching from the main control bar
- a separate Panel Replay app for remote panel review
- demand-driven PRC replay caching
- saved-video export into a metadata-based folder structure
- recording shortcuts: `R` starts/stops recording, `Space` starts/stops clips, and `S` sets/resets the program start when halfway timing is active

## Remote Panel

The Panel Replay app is the remote replay client for panel review or other trusted LAN viewers. It packages its own static UI under `PanelReplay/wwwroot` and connects to the ElementReview backend API over the LAN.

Common forms:

```text
panel-replay.exe
panel-replay.exe with a configured Server IP address
```

- The panel starts in a rail/menu view. Element buttons play only their clipped region once, without looping.
- Element buttons are clickable immediately. When a judge clicks a clip, the PRC downloads and caches only the needed video chunks.
- The final rail button is `ENTIRE RECORDING`. It appears only when replay media is available and opens the full-video timeline with clip markers.
- Cached chunks are reused, so repeated playback of the same region does not download the same bytes again.
- The panel shows a session info bar when replay clips are available.
- The panel timer overlay appears above clip blocks and remains translucent so the clip underneath is still visible.

PRC transfer behavior is coordinated by the ElementReview backend:

- Element Review operator high-res replay requests never enter the PRC transfer path.
- PRC low-res on-demand chunk requests enter the PRC transfer path.

## Saved Video Export

When `SaveVideos` is enabled in `appconfig.json`, completed recordings are exported from the low-res replay file under:

```text
SavedVideosFolder/
  categoryName/
    categoryDiscipline/
      categoryFlight/
        segmentName/
          LastName-FirstName-Club-Section.mp4
          LastName-FirstName-Club-Section.json
```

Folder and file names are built from `SessionInfo.json`.

## Architecture

- [shell/Program.cs] starts the local web server and native shell.
- [shell/MainForm.cs] hosts the main operator UI in WebView2.
- [AppServer.cs] serves static files and the local HTTP API.
- [PanelReplay/PanelReplay.csproj] builds the separate panel-review executable.
- [Services/RecorderManager.cs] manages recording, replay-file generation, and saved-video export.
- [Services/MediaMtxManager.cs] runs MediaMTX for RTSP relay.
- [Services/SessionManager.cs] owns in-memory session and clip state.
- [wwwroot/index.html] is the main operator UI.
- [wwwroot/config.html] is the settings window.
- [PanelReplay/wwwroot/panel.html] is the panel app UI.

The local server listens on:

```text
http://0.0.0.0:5050
```

Typical local access:

```text
http://127.0.0.1:5050
http://localhost:5050
```

## Runtime Requirements

To compile the app, you need:

- Windows
- .NET 10 SDK
- WebView2 Runtime
- `tools/ffmpeg.exe`
- `tools/ffprobe.exe`
- `tools/mediamtx.exe`

Optional CSS helper executables should be placed beside `ElementReview.exe`:

- `GetSessionInfo_LegacyCSS.exe` pulls session information from legacy CSS into SessionInfo.json
- `GetSessionInfo_OnlineCSS.exe` pulls session information from Online CSS into SessionInfo.json
- `GetSessionInfo_OfflineCSS.exe` pulls session information from Offline CSS into SessionInfo.json

## Data Files

Writable per-user files live under:

```text
%LocalAppData%\ElementReview\data\
```

Important files:

- `appconfig.json`
- `SessionInfo.json`
- `demovideo.mp4`
- `current-high-res.mp4`
- `current-low-res.mp4`

Bundled files under `data\` are used as fallbacks for development and packaging when the local copies do not exist.

During recording, ElementReview produces two replay MP4 files in parallel:

- `current-high-res.mp4`: the main operator replay file, encoded at the configured low GOP for responsive seeking in `index.html`.
- `current-low-res.mp4`: the Panel Review and saved-video file, encoded as 720p/30 fps, GOP 60, and 2500k video bitrate. When `SaveVideos` is enabled, AAC audio from the source is included for saved copies; PRCs keep playback muted.

When `UseHardwareEncodingWhenAvailable` is enabled and a supported encoder is available, both replay files use hardware encoding. Otherwise both files use software encoding.

## App Configuration

The app currently reads and writes these canonical `AppConfig` fields:

- `Language`
- `UiZoomPercent`
- `ClipMarkerAdvanceMsec`
- `DemoMode`
- `RtspUrl`
- `SourceFps`
- `RtspTransportProtocol`
- `UseHardwareEncodingWhenAvailable`
- `RecordingGop`
- `CSSLink`
- `DatabaseLocation`
- `EventId`
- `CSSServerHost`
- `SaveVideos`
- `SavedVideosFolder`

Notes:

- `SaveVideos` is forced off when `DemoMode` is on.
- `UiZoomPercent` is shared by the shell and settings window.
- `Language` is switched live in the main operator UI.

## SessionInfo Shape

`SessionInfo.json` is expected to use the current canonical shape. The app currently reads these top-level fields from it:

- `categoryName`
- `categoryDiscipline`
- `categoryFlight`
- `segmentName`
- `segmentProgHalfTime`
- `competitorFirstName`
- `competitorLastName`
- `competitorClub`
- `competitorSection`
- `elements`

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
    "1": { "code": "2A", "review": true },
    "2": { "code": "LSp1", "review": false }
  }
}
```

Within `elements`, each numbered entry can include:

- `code`: element label shown in the clip list and replay timeline
- `review`: whether the element should be marked as a review item

The app uses `SessionInfo.json` data for:

- session banner text: `categoryName`, `categoryDiscipline`, `categoryFlight`, `segmentName`, `competitorFirstName`, `competitorLastName`
- halfway/program timing: `segmentProgHalfTime`
- replay element labels: `elements[n].code`
- replay review flags: `elements[n].review`
- saved-video folder naming: `categoryName`, `categoryDiscipline`, `categoryFlight`, `segmentName`
- saved-video file naming: `competitorLastName`, `competitorFirstName`, `competitorClub`, `competitorSection`

Halfway/program timing controls are shown only when all of these are true:

- `categoryName` is `Senior`
- `categoryDiscipline` is `Women` or `Men`
- `segmentName` is `Free Program` or `Short Program`
- `segmentProgHalfTime` contains a valid positive time

When those conditions are not met, Set/Reset Start, Jump to Halfway, halfway display, halfway marker, and the `H` halfway shortcut are hidden or inactive.

Unknown extra properties are ignored by the current app.

## Running

From the project root:

```powershell
dotnet run
```

During development, `wwwroot\`, `data\`, and `tools\` are copied to the output folder with `PreserveNewest`.

## Publishing

```powershell
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

Published output is created under:

```text
bin\Release\net10.0-windows\win-x64\publish\
```

## Repository Layout

- `AppServer.cs`
- `AppPaths.cs`
- `Models\`
- `Services\`
- `shell\`
- `wwwroot\`
- `data\`
- `tools\`
- `API-manual.md`

## API Reference

See [API-manual.md] for the full endpoint list and request/response shapes.
