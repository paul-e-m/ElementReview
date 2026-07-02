# ReVue VRO

ReVue VRO is a Windows desktop recording and replay tool for figure skating competitions. It combines:

- a local ASP.NET Core server
- a Windows Forms shell
- a WebView2 operator UI
- `ffmpeg` / `ffprobe` for recording
- MediaMTX for live RTSP relay into the browser UI

The current app version is `v1.0.3`.

## What It Does

ReVue VRO is built around a fast record-to-review workflow:

1. show a live RTSP feed or demo video
2. start recording
3. mark element clips while the skater/team is performing
4. stop recording and switch straight into replay mode
5. trim, split, insert, or delete replay clips
6. expose the replay over the LAN for judge and referee review

Current operator features include:

- record mode with clip start/stop marking
- record-mode undo/redo
- optional halfway/program timer tracking
- replay playback, scrubbing, looping, zoom, and frame stepping
- replay clip editing
- English/French UI switching from the main control bar
- a separate ReVue Judge app for remote judge/referee review
- demand-driven ReVue Judge client caching
- saved-video export into a metadata-based folder structure
- recording shortcuts: `R` starts/stops recording, `Space` starts/stops clips, and `S` sets/resets the program start when halfway timing is active

## ReVue Judge

`ReVue-Judge.exe` is the remote replay client for judges and the referee. It packages its own static UI under `ReVue-Judge/wwwroot` and connects to the ReVue VRO backend API over the LAN.

The same executable can be used by both judges and the referee. Referee timing functionality is available when the app settings role is `Referee`; the `Judge` role hides those timing controls.

Run `ReVue-Judge.exe` on each judge or referee computer. In the app settings, set the Server IP address to the computer running ReVue VRO (i.e., the VRO computer).

- ReVue Judge starts in a rail/menu view. Element buttons loop their clipped region until playback is paused or another view is selected.
- Element buttons are clickable immediately. When a judge clicks a clip, the ReVue Judge client downloads and caches only the needed video chunks.
- The video icon button beneath the element rail appears only when replay media is available and opens the full-video timeline with clip markers for reviewing portions of the performance outside the clipped elements.
- Cached chunks are reused, so repeated playback of the same region does not download the same bytes again.
- ReVue Judge shows a session info bar when replay clips are available.
- The ReVue Judge timer overlay appears above clip blocks and remains translucent so the clip underneath is still visible.
- ReVue Judge is read-only. It can read session status, session metadata, and low-res replay video, but it cannot start/stop recording, mark clips, clear sessions, edit replay clips, change settings, or restart ReVue VRO.

ReVue Judge client transfer behaviour is coordinated by the ReVue VRO backend:

- ReVue VRO operator high-res replay requests never enter the ReVue Judge transfer path.
- ReVue Judge low-res on-demand chunk requests enter the ReVue Judge transfer path.

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
- [ReVueVRO.csproj] builds the `ReVue-VRO.exe` executable.
- [ReVue-Judge/ReVue-Judge.csproj] builds the separate `ReVue-Judge.exe` executable.
- [Services/RecorderManager.cs] manages recording, replay-file generation, and saved-video export.
- [Services/MediaMtxManager.cs] runs MediaMTX for RTSP relay.
- [Services/SessionManager.cs] owns in-memory session and clip state.
- [wwwroot/index.html] is the main operator UI.
- [wwwroot/config.html] is the settings window.
- [ReVue-Judge/wwwroot/ReVue-Judge.html] is the ReVue Judge UI.

The local server listens on:

```text
http://0.0.0.0:5050
```

Operator access is local-only:

```text
http://127.0.0.1:5050
http://localhost:5050
```

LAN clients can reach only the ReVue Judge read-only API surface:

- `GET /api/status`
- `GET /api/sessionInfo`
- `GET /api/recording/file?kind=low-res&v=<ReplayMediaToken>`

Operator-only pages and API actions are restricted to the ReVue VRO computer. On startup, ReVue VRO generates a disposable per-session operator token and the local WebView operator UI attaches it automatically to protected API calls. Installers and operators do not need to configure passwords, QR codes, or shared secrets. The token is not stored in source code and changes when the ReVue VRO server restarts.

Protected operator-only actions include configuration changes, recording start/stop, clip marking, undo/redo, session clearing, replay trim/split/insert/delete, diagnostics, restart, high-res replay access, demo/live operator pages, and the main operator UI.

## Runtime Requirements

To compile the app, you need:

- Windows
- .NET 10 SDK
- WebView2 Runtime
- `tools/ffmpeg.exe`
- `tools/ffprobe.exe`
- `tools/mediamtx.exe`

Optional CSS helper executables should be placed beside `ReVue-VRO.exe`:

- `GetSessionInfo_LegacyCSS.exe` pulls session information from legacy CSS into SessionInfo.json
- `GetSessionInfo_OnlineCSS.exe` pulls session information from Online CSS into SessionInfo.json
- `GetSessionInfo_OfflineCSS.exe` pulls session information from Offline CSS into SessionInfo.json

## Data Files

Shared per-user files live under:

```text
%LocalAppData%\ReVue\data\
```

Shared replay media live under:

```text
%LocalAppData%\ReVue\media\
```

App-specific settings live under:

```text
%LocalAppData%\ReVue\ReVue-VRO\
%LocalAppData%\ReVue\ReVue-Judge\
```

Important files:

- `SessionInfo.json`
- `demovideo.mp4`
- `current-high-res.mp4`
- `current-high-res-recording.mp4`
- `current-low-res.mp4`
- `current-low-res-recording.mp4`
- `ReVue-VRO\appconfig.json`
- `ReVue-VRO\remote-replay.json`
- `ReVue-VRO\mediamtx.yml`
- `ReVue-Judge\appconfig.json`

Bundled files under `data\` are used as fallbacks for development and packaging when the local copies do not exist.

During recording, ReVue VRO produces two replay MP4 files in parallel under `%LocalAppData%\ReVue\media\`:

- `current-high-res.mp4`: the main operator replay file, encoded with `highresVideoGop` for responsive seeking in `index.html`.
- `current-low-res.mp4`: the ReVue Judge and saved-video file, encoded as 720p/30 fps with the configured `lowresVideoGop` and `lowresVideoBitrate` values. When `SaveVideos` is enabled, AAC audio from the source is included for saved copies; ReVue Judge clients keep playback muted.

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
- `highresVideoGop`
- `lowresVideoGop`
- `lowresVideoBitrate`
- `CSSLink`
- `DatabaseLocation`
- `EventId`
- `CSSServerHost`
- `SaveVideos`
- `SavedVideosFolder`
- `AutoplaySelectedClip`

Notes:

- `SaveVideos` is forced off when `DemoMode` is on.
- `UiZoomPercent` is shared by the shell and settings window.
- `Language` is switched live in the main operator UI.
- `AutoplaySelectedClip` controls whether selecting a replay element immediately starts playback and defaults to `false`.
- `highresVideoGop` controls the high-res/operator replay video GOP and defaults to `2`.
- `lowresVideoGop` controls the low-res ReVue Judge client/saved-video GOP and defaults to `60`.
- `lowresVideoBitrate` is stored in kbps and defaults to `3500`.

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

Set/Reset Start buttons are shown when halfway timing is available:

- the manual `HW:` dropdown is set to a real halfway preset instead of `None`
- `categoryName` is `Senior` or `Junior`, `categoryDiscipline` is `Women` or `Men`, `segmentName` is `Free Program` or `Short Program`, and `segmentProgHalfTime` contains a valid positive time

When `CSSLink` is `None`, the manual `HW:` dropdown controls whether those buttons appear.

Jump to Halfway, halfway display, halfway marker, and the `H` halfway shortcut are shown only when all of these are true:

- `categoryName` is `Senior` or `Junior`
- `categoryDiscipline` is `Women` or `Men`
- `segmentName` is `Free Program` or `Short Program`
- `segmentProgHalfTime` contains a valid positive time

When those conditions are not met, the halfway display, halfway marker, Jump to Halfway button, and `H` shortcut are hidden or inactive.

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

To sign the published app binaries and the setup installers in `dist\`, run:

```powershell
.\sign-artifacts.ps1
```

That script signs and verifies `ReVue-VRO.exe`, `ReVue-Judge.exe`, `dist\ReVue-VRO-Setup-<version>.exe`, and `dist\ReVue-Judge-Setup-<version>.exe` when the installers are present.

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
