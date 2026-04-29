# JudgeVideoReplay Installation Manual

JudgeVideoReplay is installed on the judge and referee laptops. It is the remote replay client that connects to the ElementReview server running on the VRO laptop.

Do not use JudgeVideoReplay as the recording application on the VRO laptop. The VRO laptop runs ElementReview.

## Installation Target

- Computers: judge laptops and referee laptops
- Operating system: Windows 10 or Windows 11
- Network role: replay client
- Server dependency: ElementReview running on the VRO laptop
- Main executable: `JudgeVideoReplay.exe`

## Runtime Requirements

JudgeVideoReplay is published as a self-contained Windows application, so the normal .NET runtime does not need to be installed separately on the target laptop when using the published build.

JudgeVideoReplay does require Microsoft Edge WebView2 Runtime because its UI is hosted in WebView2.

As of April 28, 2026, Microsoft documents the WebView2 Evergreen Runtime this way:

- Windows 11: WebView2 Evergreen Runtime is preinstalled as part of Windows 11.
- Windows 10: Microsoft installed WebView2 Runtime on most eligible Windows 10 devices, but some Windows 10 devices may still be missing it.
- Recommendation: install or bundle the Evergreen WebView2 Runtime for event laptops, especially Windows 10 laptops, so setup does not depend on whether the machine already has it.

Download source:

- Microsoft Edge WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
- Choose the Evergreen Runtime. For offline event setup, use the Evergreen Standalone Installer, usually `x64` for modern Windows laptops.

## Build Command

From PowerShell on the development computer:

```powershell
cd "P:\pCloud Sync\Data Specialist\Current ElementReview-dev"
dotnet publish .\JudgeVideoReplay\JudgeVideoReplay.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

The published files are written under:

```text
JudgeVideoReplay\bin\Release\net10.0-windows\win-x64\publish\
```

## Files To Copy To Judge And Referee Laptops

Copy the contents of the JudgeVideoReplay publish folder to each judge and referee laptop, for example:

```text
C:\JudgeVideoReplay\
```

The published folder should include:

- `JudgeVideoReplay.exe`
- `wwwroot\`

JudgeVideoReplay does not need `tools\ffmpeg.exe`, `tools\ffprobe.exe`, or `tools\mediamtx.exe`. Those are used by ElementReview on the VRO laptop.

## First Launch

1. Install WebView2 Runtime if the laptop does not already have it.
2. Connect the laptop to the same competition network as the VRO laptop.
3. Start `JudgeVideoReplay.exe`.
4. Open JudgeVideoReplay settings.
5. Enter the VRO laptop IP address in `Server IP address`.
6. Save and close settings.
7. Confirm the app can reach ElementReview when the VRO laptop is running.

## Network Requirements

JudgeVideoReplay connects to ElementReview at:

```text
http://<VRO laptop IP>:5050
```

The judge/referee laptop usually does not need an inbound firewall rule for JudgeVideoReplay. It must be able to make outbound connections to the VRO laptop on TCP port `5050`.

If JudgeVideoReplay stays on the waiting screen:

- Confirm ElementReview is running on the VRO laptop.
- Confirm the VRO laptop IP address is correct.
- Confirm both laptops are on the same LAN or VLAN.
- Confirm the VRO laptop firewall allows inbound TCP port `5050`.
- Confirm the event network is not blocking client-to-client traffic.

## Local Data

JudgeVideoReplay writes per-user runtime data here:

```text
%LocalAppData%\JudgeVideoReplay\
```

Important files and folders:

- `appconfig.json`
- `media\`
- `WebView2\`

The `media\` folder is a local cache for replay chunks downloaded from the VRO laptop.

