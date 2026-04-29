# ElementReview Installation Manual

ElementReview is installed on the VRO laptop. It is the only competition laptop that records the video source, runs the replay server, and serves replay clips to JudgeVideoReplay clients.

Do not install ElementReview as the normal replay client on judge or referee laptops. Those laptops should run JudgeVideoReplay instead.

## Installation Target

- Computer: VRO laptop
- Operating system: Windows 10 or Windows 11
- Network role: server for JudgeVideoReplay clients
- Default server port: `5050`
- Main executable: `ElementReview.exe`

## Runtime Requirements

ElementReview is published as a self-contained Windows application, so the normal .NET runtime does not need to be installed separately on the target laptop when using the published build.

ElementReview does require Microsoft Edge WebView2 Runtime because its operator UI and settings window are hosted in WebView2.

As of April 28, 2026, Microsoft documents the WebView2 Evergreen Runtime this way:

- Windows 11: WebView2 Evergreen Runtime is preinstalled as part of Windows 11.
- Windows 10: Microsoft installed WebView2 Runtime on most eligible Windows 10 devices, but some Windows 10 devices may still be missing it.
- Recommendation: include or install the Evergreen WebView2 Runtime anyway, especially for Windows 10 laptops, so the app works even on machines that do not already have it.

Download source:

- Microsoft Edge WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
- Choose the Evergreen Runtime. For offline event setup, use the Evergreen Standalone Installer, usually `x64` for modern Windows laptops.

## Build Command

From PowerShell on the development computer:

```powershell
cd "P:\pCloud Sync\Data Specialist\Current ElementReview-dev"
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

The published files are written under:

```text
bin\Release\net10.0-windows\win-x64\publish\
```

## Files To Copy To The VRO Laptop

Copy the contents of the ElementReview publish folder to a folder on the VRO laptop, for example:

```text
C:\ElementReview\
```

The published folder should include:

- `ElementReview.exe`
- `wwwroot\`
- `data\`
- `tools\`
- `tools\ffmpeg.exe`
- `tools\ffprobe.exe`
- `tools\mediamtx.exe`

Optional CSS helper executables can be placed beside `ElementReview.exe`:

- `GetSessionInfo_LegacyCSS.exe`
- `GetSessionInfo_OnlineCSS.exe`
- `GetSessionInfo_OfflineCSS.exe`

## First Launch

1. Install WebView2 Runtime if the laptop does not already have it.
2. Connect the VRO laptop to the competition network.
3. Confirm the laptop has a stable IP address. This IP address is entered into JudgeVideoReplay on the judge and referee laptops.
4. Start `ElementReview.exe`.
5. Open the settings window and configure the video source and CSS integration.
6. If Windows Firewall prompts for access, allow ElementReview on the event network.

## Network And Firewall

ElementReview listens on:

```text
http://0.0.0.0:5050
```

JudgeVideoReplay clients connect to the VRO laptop on port `5050`. The VRO laptop firewall must allow inbound TCP traffic on port `5050` from the judge and referee laptops.

If clients cannot connect:

- Confirm all laptops are on the same LAN or VLAN.
- Confirm the JudgeVideoReplay `Server IP address` matches the VRO laptop IP address.
- Confirm Windows Firewall allows `ElementReview.exe` or TCP port `5050`.
- Confirm ElementReview is running on the VRO laptop.

## Local Data

ElementReview writes per-user runtime data here:

```text
%LocalAppData%\ElementReview\data\
```

Important files in that folder include:

- `appconfig.json`
- `SessionInfo.json`
- `demovideo.mp4`
- `current-high-res.mp4`
- `current-low-res.mp4`
- `mediamtx.yml`

The application can also use bundled fallback files from its installed `data\` folder when local files do not exist.

