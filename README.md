# ElementReview

ElementReview is a Windows desktop replay tool for figure skating competitions. It combines:

- a local ASP.NET Core server
- a Windows Forms shell
- a WebView2-based operator UI
- `ffmpeg`/`ffprobe` recording tools
- MediaMTX for live preview transport

The app is built around a fast event workflow:

1. preview a live RTSP feed or a local demo video
2. start recording
3. mark element clips while the skater is performing
4. stop recording and move straight into replay review
5. trim or edit clips as needed
6. expose the replay to local or LAN clients such as the judge page

## Current Capabilities

The current app supports:

- live preview from RTSP through MediaMTX
- demo mode using `data/demovideo.mp4` or `%LocalAppData%\ElementReview\data\demovideo.mp4`
- local recording to encoded and copied MP4 outputs
- record mode clip marking with undo and redo before recording ends
- automatic transition from record mode to replay mode
- replay playback with loop controls and keyboard shortcuts
- replay clip editing: trim in, trim out, split, insert, delete
- a separate remote replay page at `judge.html`
- session metadata and executed-element metadata from `SessionInfo.json`
- settings for language, UI zoom, clip marker advance, RTSP source, CSS link mode, and save-video behavior
- English/French operator button assets driven by `appconfig.json`

## Architecture

ElementReview is a hybrid desktop/web application.

- `shell/Program.cs` starts the local ASP.NET Core app and then launches the Windows shell.
- `shell/MainForm.cs` hosts the main UI in WebView2.
- `AppServer.cs` serves the UI from `wwwroot/` and exposes the local HTTP API.
- `Services/RecorderManager.cs` manages the `ffmpeg` recording pipeline.
- `Services/MediaMtxManager.cs` manages MediaMTX for browser-friendly live preview.
- `Services/SessionManager.cs` holds in-memory record/replay session state, including clip markers and replay edits.

The local server listens on:

```text
http://0.0.0.0:5050
```

Typical local URLs:

```text
http://127.0.0.1:5050
http://localhost:5050
```

The main operator pages are:

- `wwwroot/index.html` - main operator UI
- `wwwroot/config.html` - settings UI
- `wwwroot/judge.html` - remote replay/judge UI

For HTTP endpoint details, see `API-manual.md`.

## Requirements

To build and run the app locally you need:

- Windows
- .NET 10 SDK
- WebView2 Runtime
- external runtime binaries in `tools/`:
  - `ffmpeg.exe`
  - `ffprobe.exe`
  - `mediamtx.exe`

Optional helper executables can be deployed beside the running `ElementReview.exe`:

- `GetSessionInfo_LegacyCSS.exe`
- `GetSessionInfo_OnlineCSS.exe`
- `GetSessionInfo_OfflineCSS.exe`

These large third-party/runtime binaries are intentionally not included in the repository.

## Project Setup

### 1. Add recording and streaming tools

Create this structure in the project root:

```text
ElementReview/
  tools/
    ffmpeg.exe
    ffprobe.exe
    mediamtx.exe
```

### 2. Optional demo video

To use demo mode, place a local sample file at:

```text
%LocalAppData%\ElementReview\data\demovideo.mp4
```

Recommended source format:

- 1080p
- 60 fps
- H.264

### 3. Session metadata file

ElementReview reads competition/session metadata from `SessionInfo.json`.

The runtime location is:

```text
%LocalAppData%\ElementReview\data\SessionInfo.json
```

For development or bundled/demo scenarios, it can also fall back to:

```text
data\SessionInfo.json
```

This metadata is used for overlays, element names, review flags, saved-video naming, and related API responses.

### 4. Optional CSS helper integration

The settings UI exposes these CSS link modes:

- `None`
- `Legacy`
- `Custom`
- `Online CSS`
- `Offline CSS`

At runtime, helper auto-launch is currently tied to these modes:

- `Legacy` -> `GetSessionInfo_LegacyCSS.exe`
- `Online CSS` -> `GetSessionInfo_OnlineCSS.exe`
- `Offline CSS` -> `GetSessionInfo_OfflineCSS.exe`

The helper executable must sit beside the running `ElementReview.exe`. When enabled, the helper is expected to keep `%LocalAppData%\ElementReview\data\SessionInfo.json` up to date.

## Configuration And Data Files

The app creates and uses writable per-user files under `%LocalAppData%\ElementReview\data\`:

- `appconfig.json`
- `demovideo.mp4` (optional)
- `SessionInfo.json` (optional/local fallback)
- `current-encoded.mp4`
- `current-copied.mp4`

Bundled `data/` content in the app folder is treated as read-only fallback content for development and packaging scenarios.

Important `AppConfig` fields include:

- `RtspUrl`
- `DemoMode`
- `SourceFps`
- `RecordingGop`
- `UseHardwareEncodingWhenAvailable`
- `ClipMarkerAdvanceMsec`
- `SaveVideos`
- `SavedVideosFolder`
- `CSSLink`
- `DatabaseLocation`
- `CSSServerHost`
- `Language`
- `UiZoomPercent`

Notes:

- `SaveVideos` is forced off in demo mode.
- UI zoom is persisted in `%LocalAppData%\ElementReview\data\appconfig.json` and is also updated when the user changes WebView zoom.
- Language selection controls the localized button assets used by the main operator UI.

## Running The App

### Visual Studio

1. Open the solution or project in Visual Studio.
2. Make sure `tools/` is populated.
3. Run the project normally.

### PowerShell

From the project root:

```powershell
dotnet run
```

When the app starts:

- the local web server is started
- the Windows shell opens the main UI in WebView2
- the settings page can be opened in a separate shell window

During development, `wwwroot/`, `data/`, and `tools/` are copied to the output folder with `PreserveNewest`, so normal rebuilds pick up recent frontend and content changes.

## Publishing

From PowerShell in the project root:

```powershell
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

The published output will be created under:

```text
bin\Release\net10.0-windows\win-x64\publish\
```

Deploy the helper executables next to the published `ElementReview.exe` if you intend to use CSS integration.

## Repository Layout

- `AppServer.cs` - ASP.NET Core host, static file serving, and API routes
- `Models/` - shared DTOs and config models
- `Services/` - recorder, MediaMTX, and session-state services
- `shell/` - Windows Forms shell and startup behavior
- `wwwroot/` - operator UI, settings UI, judge UI, scripts, styles, and assets
- `data/` - bundled fallback config/media/metadata files for development and packaging
- `tools/` - external recording/streaming binaries
- `API-manual.md` - local API reference

## Notes

- The app targets `net10.0-windows` and uses Windows Forms plus WebView2.
- The repository intentionally excludes large runtime binaries and media files.
- The main UI logic lives primarily in:
  - `wwwroot/app.js`
  - `wwwroot/app-replay.js`
  - `wwwroot/app-timeline.js`
  - `wwwroot/app-shortcut-keys.js`
- The local API has no authentication layer today. Treat it as a trusted local/LAN tool.
