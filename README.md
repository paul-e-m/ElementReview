# ElementReview

ElementReview is a Windows desktop recording and replay tool for figure skating events. It combines:

- a local ASP.NET Core server
- a Windows Forms shell
- a WebView2 operator UI
- `ffmpeg` / `ffprobe` for recording
- MediaMTX for live RTSP relay into the browser UI

The current app version is `v0.4.2-alpha`.

## What It Does

ElementReview is built around a fast record-to-review workflow:

1. show a live RTSP feed or demo video
2. start recording
3. mark element clips while the skater is performing
4. stop recording and switch straight into replay mode
5. trim, split, insert, or delete replay clips
6. expose the replay locally or over the LAN for judge review

Current operator features include:

- record mode with clip start/stop marking
- record-mode undo/redo
- optional halfway/program timer tracking
- replay playback, scrubbing, looping, zoom, and frame stepping
- replay clip editing
- English/French UI switching from the main control bar
- a separate remote replay page at `judge.html`
- saved-video export into a metadata-based folder structure

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

- [shell/Program.cs](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/shell/Program.cs>) starts the local web server and native shell.
- [shell/MainForm.cs](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/shell/MainForm.cs>) hosts the main operator UI in WebView2.
- [AppServer.cs](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/AppServer.cs>) serves static files and the local HTTP API.
- [Services/RecorderManager.cs](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/Services/RecorderManager.cs>) manages recording, replay-file generation, and saved-video export.
- [Services/MediaMtxManager.cs](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/Services/MediaMtxManager.cs>) runs MediaMTX for RTSP relay.
- [Services/SessionManager.cs](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/Services/SessionManager.cs>) owns in-memory session and clip state.
- [wwwroot/index.html](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/wwwroot/index.html>) is the main operator UI.
- [wwwroot/config.html](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/wwwroot/config.html>) is the settings window.
- [wwwroot/judge.html](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/wwwroot/judge.html>) is the remote replay page.

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

You need:

- Windows
- .NET 10 SDK
- WebView2 Runtime
- `tools/ffmpeg.exe`
- `tools/ffprobe.exe`
- `tools/mediamtx.exe`

Optional CSS helper executables can be placed beside `ElementReview.exe`:

- `GetSessionInfo_LegacyCSS.exe`
- `GetSessionInfo_OnlineCSS.exe`
- `GetSessionInfo_OfflineCSS.exe`

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
- `UseHardwareEncodingWhenAvailable`
- `RecordingGop`
- `CSSLink`
- `DatabaseLocation`
- `EventId`
- `CSSServerHost`
- `SaveVideos`
- `SavedVideosFolder`
- `HalfwayEnabled`

Notes:

- `SaveVideos` is forced off when `DemoMode` is on.
- `UiZoomPercent` is shared by the shell and settings window.
- `Language` is switched live in the main operator UI.

## SessionInfo Shape

`SessionInfo.json` is expected to use the current canonical shape:

```json
{
  "categoryName": "STAR 10",
  "categoryDiscipline": "Women",
  "categoryFlight": "Free Program",
  "segmentName": "Cindy Smith",
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

The app uses this data for:

- session banners
- replay element labels
- review flags
- halfway timing
- saved-video folder/file naming

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

See [API-manual.md](</P:/pCloud Sync/Data Specialist/Current ElementReview-dev/API-manual.md>) for the full endpoint list and request/response shapes.
