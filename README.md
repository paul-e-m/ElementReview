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
- a feature-rich remote replay panel at `panel.html`
- saved-video export into a metadata-based folder structure
- recording shortcuts: `R` starts/stops recording, `Space` starts/stops clips, and `S` sets/resets the program start when halfway timing is active

## Remote Panel

`panel.html` is the remote replay client for panel review or other trusted LAN viewers.

Common forms:

```text
http://localhost:5050/panel.html
http://localhost:5050/panel.html?0
http://localhost:5050/panel.html?2
http://localhost:5050/panel.html?2&autoplay=false&loop=false
```

- `panel.html` and `panel.html?0` open full panel mode with the element rail.
- `panel.html?N` opens element clip `N` directly.
- Clicking an element clip in the panel autoplays it, even if playback was paused.
- The panel shows a session info bar when replay clips are available.
- The panel timer overlay appears above clip blocks and remains translucent so the clip underneath is still visible.

## Saved Video Export

When `SaveVideos` is enabled in `appconfig.json`, completed recordings are copied under:

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
- [Services/RecorderManager.cs] manages recording, replay-file generation, and saved-video export.
- [Services/MediaMtxManager.cs] runs MediaMTX for RTSP relay.
- [Services/SessionManager.cs] owns in-memory session and clip state.
- [wwwroot/index.html] is the main operator UI.
- [wwwroot/config.html] is the settings window.
- [wwwroot/panel.html] is the remote replay panel.

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
- `current-encoded.mp4`
- `current-copied.mp4`

Bundled files under `data\` are used as fallbacks for development and packaging when the local copies do not exist.

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
