# ElementReview Configuration Manual

ElementReview is configured on the VRO laptop. Its settings control the video source, replay encoding, CSS integration, saved-video export, and operator UI behavior.

Most settings can be changed from the ElementReview settings window. The backing file is:

```text
%LocalAppData%\ElementReview\data\appconfig.json
```

## Recommended Setup Order

1. Start `ElementReview.exe` on the VRO laptop.
2. Open the settings window.
3. Set the language and UI zoom.
4. Configure CSS integration.
5. Configure the video source.
6. Configure saved-video export if required.
7. Save settings and restart ElementReview if requested.
8. Start JudgeVideoReplay on a judge laptop and confirm it can connect to the VRO laptop.

## General Settings

`Language`

- UI language.
- Supported values are `en` and `fr`.

`UiZoomPercent`

- Default zoom level for the main operator window and settings window.
- `100` means normal size.
- Increase this value if the VRO display is difficult to read.

`ClipMarkerAdvanceMsec`

- Amount of time, in milliseconds, that ElementReview backs up from the current moment when marking the start of a clip.
- Useful when the VRO presses the marker button slightly after the visible start of an element.

## CSS Integration

`CSSLink`

- Selects how ElementReview gets competition/session information.
- Supported UI options are `Legacy`, `Online CSS`, `Offline CSS`, `Custom`, and `None`.

`DatabaseLocation`

- Host name or IP address for the CSS MSSQL database.
- Used by legacy CSS integration.

`EventId`

- Event identifier used by newer CSS link modes.

`CSSServerHost`

- Host name or IP address for the offline CSS server.

Optional helper executables must be placed beside `ElementReview.exe` when the selected CSS mode depends on them.

## Video Source

`DemoMode`

- When on, ElementReview uses the local demo video instead of the RTSP video source.
- Intended for training and testing.
- Saved-video export is forced off while Demo Mode is on.

`RtspUrl`

- RTSP stream URL from the video encoder.
- Example shape:

```text
rtsp://192.168.6.200:8554/0
```

`SourceFps`

- Source video frame rate.
- Typical values are `30` or `60`.

`RtspTransportProtocol`

- Preferred RTSP transport.
- `UDP` can have lower latency on clean networks.
- `TCP` can be more reliable on difficult networks.

## Advanced Video Settings

`UseHardwareEncodingWhenAvailable`

- When enabled, ElementReview uses hardware encoding if the VRO laptop supports it.
- Leave enabled for most event setups.

`highresVideoGop`

- Keyframe interval for the high-res replay file used by the VRO/operator replay.
- Default is `10`.
- Lower values can improve seeking responsiveness but may increase file size or encoding load.

`lowresVideoGop`

- Keyframe interval for the low-res replay file used by JudgeVideoReplay and saved videos.
- Default is `60`.

`lowresVideoBitrate`

- Bitrate in kbps for the low-res replay file used by JudgeVideoReplay and saved videos.
- Default is `2500`.

## Saved Videos

`SaveVideos`

- When enabled, ElementReview copies completed recordings into the saved-video folder.
- This requires substantial disk space.
- This setting is forced off when `DemoMode` is on.

`SavedVideosFolder`

- Folder where completed saved videos are copied.
- Default is normally under the user's Videos folder, or:

```text
C:\Event_Videos
```

Saved-video folder and file names are built from `SessionInfo.json` metadata such as category, segment, competitor name, club, and section.

## Files Produced During Recording

ElementReview records two replay files:

- `current-high-res.mp4`: high-res operator replay file.
- `current-low-res.mp4`: low-res JudgeVideoReplay and saved-video file.

These files are stored under:

```text
%LocalAppData%\ElementReview\data\
```

## JudgeVideoReplay Connection Check

After ElementReview is configured and running:

1. Note the VRO laptop IP address.
2. On each judge/referee laptop, open JudgeVideoReplay settings.
3. Enter that VRO laptop IP address as `Server IP address`.
4. Save and close settings.
5. Confirm JudgeVideoReplay leaves the waiting screen when replay clips are available.

