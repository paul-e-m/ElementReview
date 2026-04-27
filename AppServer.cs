using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Net.Http.Headers;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Text.Json;
using ElementReview.Models;
using ElementReview.Services;
using ElementReview.Shell;

namespace ElementReview.Hosting;

public static class AppServer
{
    public const string ListenUrl = "http://0.0.0.0:5050";
    public const string LocalBaseUrl = "http://127.0.0.1:5050";
    public const string MainPageUrl = LocalBaseUrl + "/index.html";
    public const string SettingsPageUrl = LocalBaseUrl + "/config.html";

    private static string ResolveContentRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);

        while (current != null)
        {
            var candidate = current.FullName;
            var hasProjectFile = File.Exists(Path.Combine(candidate, "ElementReview.csproj"));
            var hasWwwroot = Directory.Exists(Path.Combine(candidate, "wwwroot"));

            if (hasProjectFile && hasWwwroot)
                return candidate;

            current = current.Parent;
        }

        return AppContext.BaseDirectory;
    }

    public static WebApplication Build(string[] args)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = ResolveContentRoot(),
        });
        builder.WebHost.UseUrls(ListenUrl);
        AppPaths.EnsureLocalDataDirectory();
        builder.Services.AddSingleton<SessionManager>();
        builder.Services.AddSingleton<MediaMtxManager>();
        builder.Services.AddSingleton<RecorderManager>();

        var app = builder.Build();

        app.UseDefaultFiles();
        app.UseStaticFiles();

        var jsonOpts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            WriteIndented = true
        };

        static AppConfig NormalizeConfig(AppConfig? cfg)
        {
            cfg ??= new AppConfig();
            cfg.RtspTransportProtocol = NormalizeRtspTransportProtocol(cfg.RtspTransportProtocol);

            var cssLink = string.IsNullOrWhiteSpace(cfg.CSSLink) ? "None" : cfg.CSSLink.Trim();
            cfg.CSSLink =
                cssLink.Equals("Legacy", StringComparison.OrdinalIgnoreCase) ? "Legacy" :
                cssLink.Equals("Custom", StringComparison.OrdinalIgnoreCase) ? "Custom" :
                cssLink.Equals("New", StringComparison.OrdinalIgnoreCase) ||
                cssLink.Equals("Online CSS", StringComparison.OrdinalIgnoreCase) ||
                cssLink.Equals("OnlineCSS", StringComparison.OrdinalIgnoreCase) ? "Online CSS" :
                cssLink.Equals("Offline CSS", StringComparison.OrdinalIgnoreCase) ||
                cssLink.Equals("OfflineCSS", StringComparison.OrdinalIgnoreCase) ? "Offline CSS" :
                "None";

            if (cfg.DemoMode)
            {
                cfg.SaveVideos = false;
            }

            if (string.IsNullOrWhiteSpace(cfg.SavedVideosFolder))
            {
                cfg.SavedVideosFolder = AppPaths.DefaultSavedVideosFolder;
            }

            return cfg;
        }

        static PanelConfig NormalizePanelConfig(PanelConfig? cfg)
        {
            cfg ??= new PanelConfig();
            cfg.ServerIp = string.IsNullOrWhiteSpace(cfg.ServerIp)
                ? "127.0.0.1"
                : cfg.ServerIp.Trim();
            cfg.Language = string.Equals(cfg.Language?.Trim(), "fr", StringComparison.OrdinalIgnoreCase)
                ? "fr"
                : "en";
            return cfg;
        }

        static string NormalizeRtspTransportProtocol(string? protocol)
        {
            return string.Equals(protocol?.Trim(), "TCP", StringComparison.OrdinalIgnoreCase)
                ? "TCP"
                : "UDP";
        }

        static string GetAppVersion()
        {
            var version =
                Assembly.GetExecutingAssembly()
                    .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                    ?.InformationalVersion
                ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
                ?? "0.0.0";

            return version.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? version : $"v{version}";
        }

        AppConfig? cachedConfig = null;
        DateTime cachedConfigWriteUtc = DateTime.MinValue;
        bool cachedConfigExists = false;

        PanelConfig? cachedPanelConfig = null;
        DateTime cachedPanelConfigWriteUtc = DateTime.MinValue;
        bool cachedPanelConfigExists = false;

        string? cachedSessionInfoPath = null;
        DateTime cachedSessionInfoWriteUtc = DateTime.MinValue;
        long cachedSessionInfoLength = -1;
        JsonElement? cachedSessionInfoRoot = null;
        Dictionary<int, bool>? cachedSessionInfoReviewFlags = null;

        AppConfig LoadConfig()
        {
            var path = AppPaths.LocalConfigPath;
            if (!File.Exists(path))
            {
                var cfg = NormalizeConfig(new AppConfig());
                SaveConfig(cfg);
                return cfg;
            }

            var writeUtc = File.GetLastWriteTimeUtc(path);
            if (cachedConfig != null && cachedConfigExists && cachedConfigWriteUtc == writeUtc)
                return cachedConfig;

            try
            {
                var json = File.ReadAllText(path);
                cachedConfig = NormalizeConfig(JsonSerializer.Deserialize<AppConfig>(json, jsonOpts));
                cachedConfigWriteUtc = writeUtc;
                cachedConfigExists = true;
                return cachedConfig;
            }
            catch
            {
                return NormalizeConfig(new AppConfig());
            }
        }

        void SaveConfig(AppConfig cfg)
        {
            cfg = NormalizeConfig(cfg);
            var path = AppPaths.LocalConfigPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(cfg, jsonOpts));
            cachedConfig = cfg;
            cachedConfigWriteUtc = File.GetLastWriteTimeUtc(path);
            cachedConfigExists = true;
        }

        PanelConfig LoadPanelConfig()
        {
            var path = AppPaths.LocalPanelConfigPath;
            if (!File.Exists(path))
            {
                var cfg = NormalizePanelConfig(new PanelConfig());
                SavePanelConfig(cfg);
                return cfg;
            }

            var writeUtc = File.GetLastWriteTimeUtc(path);
            if (cachedPanelConfig != null && cachedPanelConfigExists && cachedPanelConfigWriteUtc == writeUtc)
                return cachedPanelConfig;

            try
            {
                var json = File.ReadAllText(path);
                cachedPanelConfig = NormalizePanelConfig(JsonSerializer.Deserialize<PanelConfig>(json, jsonOpts));
                cachedPanelConfigWriteUtc = writeUtc;
                cachedPanelConfigExists = true;
                return cachedPanelConfig;
            }
            catch
            {
                return NormalizePanelConfig(new PanelConfig());
            }
        }

        void SavePanelConfig(PanelConfig cfg)
        {
            cfg = NormalizePanelConfig(cfg);
            var path = AppPaths.LocalPanelConfigPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(cfg, jsonOpts));
            cachedPanelConfig = cfg;
            cachedPanelConfigWriteUtc = File.GetLastWriteTimeUtc(path);
            cachedPanelConfigExists = true;
        }

        static AppConfig MergeConfig(AppConfig existing, AppConfig incoming)
        {
            if (string.IsNullOrWhiteSpace(incoming.RtspTransportProtocol))
                incoming.RtspTransportProtocol = existing.RtspTransportProtocol;
            return incoming;
        }

        static string? GetCssHelperExeName(AppConfig cfg)
        {
            return cfg.CSSLink switch
            {
                "Legacy" => "GetSessionInfo_LegacyCSS.exe",
                "Online CSS" => "GetSessionInfo_OnlineCSS.exe",
                "Offline CSS" => "GetSessionInfo_OfflineCSS.exe",
                _ => null
            };
        }

        static bool IsProcessRunning(string exeName)
        {
            var processName = Path.GetFileNameWithoutExtension(exeName);

            try
            {
                return Process.GetProcessesByName(processName).Any((proc) =>
                {
                    try
                    {
                        return !proc.HasExited;
                    }
                    catch
                    {
                        return false;
                    }
                    finally
                    {
                        proc.Dispose();
                    }
                });
            }
            catch
            {
                return false;
            }
        }

        static void EnsureCssHelperRunning(AppConfig cfg)
        {
            var exeName = GetCssHelperExeName(cfg);
            if (string.IsNullOrWhiteSpace(exeName)) return;
            if (IsProcessRunning(exeName)) return;

            var exePath = Path.Combine(AppContext.BaseDirectory, exeName);
            if (!File.Exists(exePath)) return;

            using var proc = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = exePath,
                    WorkingDirectory = Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };

            proc.Start();
        }

        string ResolveElementsPath()
        {
            return AppPaths.ResolveElementsPath(app.Environment.ContentRootPath);
        }

        static async Task<JsonElement?> ReadJsonRootAsync(HttpRequest req)
        {
            try
            {
                if (req.ContentLength is null || req.ContentLength == 0) return null;
                using var doc = await JsonDocument.ParseAsync(req.Body);
                return doc.RootElement.Clone();
            }
            catch
            {
                return null;
            }
        }

        static int? TryGetInt(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out var value)) return null;

            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)) return number;
            if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out var parsed)) return parsed;
            return null;
        }

        static double? TryGetDouble(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out var value)) return null;

            if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)) return number;
            if (value.ValueKind == JsonValueKind.String && double.TryParse(value.GetString(), out var parsed)) return parsed;
            return null;
        }

        app.Lifetime.ApplicationStopping.Register(() =>
        {
            try
            {
                var recorder = app.Services.GetRequiredService<RecorderManager>();
                recorder.StopIfRunning();
            }
            catch
            {
            }
        });

        app.Lifetime.ApplicationStarted.Register(() =>
        {
            try
            {
                EnsureCssHelperRunning(LoadConfig());
            }
            catch
            {
            }
        });

        app.MapGet("/api/liveUrl", (MediaMtxManager mtx, RecorderManager recorder) =>
        {
            var cfg = LoadConfig();

            if (cfg.DemoMode)
            {
                recorder.Warmup(cfg);
                return Results.Ok(new
                {
                    url = $"/demo-live?ts={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                    mode = "demo"
                });
            }

            mtx.EnsureRunning(cfg);
            recorder.Warmup(cfg);

            var url = $"/rtsp-live?ts={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
            return Results.Ok(new
            {
                url,
                mode = "rtsp"
            });
        });

        app.MapGet("/api/status", (SessionManager session) =>
        {
            var cfg = LoadConfig();
            var status = session.GetStatus(cfg.SourceFps);
            return Results.Ok(status);
        });

        app.MapGet("/api/appconfig", () =>
        {
            var cfg = LoadConfig();
            return Results.Json(cfg, jsonOpts);
        });

        app.MapGet("/api/panelconfig", () =>
        {
            return Results.Json(LoadPanelConfig(), jsonOpts);
        });

        app.MapGet("/api/appinfo", () =>
        {
            return Results.Json(new
            {
                version = GetAppVersion()
            }, jsonOpts);
        });

        app.MapPost("/api/appconfig", (AppConfig cfg, MediaMtxManager mtx) =>
        {
            cfg = NormalizeConfig(MergeConfig(LoadConfig(), cfg));
            SaveConfig(cfg);

            if (!cfg.DemoMode)
                mtx.Restart(cfg);

            return Results.Json(cfg, jsonOpts);
        });

        app.MapPost("/api/panelconfig", (PanelConfig cfg) =>
        {
            SavePanelConfig(cfg);
            return Results.Json(LoadPanelConfig(), jsonOpts);
        });

        app.MapGet("/api/sessionInfo", (SessionManager session) =>
        {
            try
            {
                var cfg = LoadConfig();
                if (string.Equals(cfg.CSSLink, "None", StringComparison.OrdinalIgnoreCase))
                    return Results.Ok(new { elements = new Dictionary<string, object>() });

                var path = ResolveElementsPath();
                if (!File.Exists(path))
                    return Results.Ok(new { elements = new Dictionary<string, object>() });

                var fileInfo = new FileInfo(path);
                if (cachedSessionInfoRoot.HasValue &&
                    string.Equals(cachedSessionInfoPath, path, StringComparison.OrdinalIgnoreCase) &&
                    cachedSessionInfoWriteUtc == fileInfo.LastWriteTimeUtc &&
                    cachedSessionInfoLength == fileInfo.Length)
                {
                    session.UpdateReviewHistory(cachedSessionInfoReviewFlags);
                    return Results.Json(cachedSessionInfoRoot.Value.Clone(), jsonOpts);
                }

                var json = File.ReadAllText(path);
                var reviewFlags = SessionManager.ExtractReviewFlagsFromElementsJson(json);

                session.UpdateReviewHistory(reviewFlags);

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement.Clone();
                cachedSessionInfoPath = path;
                cachedSessionInfoWriteUtc = fileInfo.LastWriteTimeUtc;
                cachedSessionInfoLength = fileInfo.Length;
                cachedSessionInfoRoot = root;
                cachedSessionInfoReviewFlags = reviewFlags;

                return Results.Json(root, jsonOpts);
            }
            catch
            {
                return Results.Ok(new { elements = new Dictionary<string, object>() });
            }
        });

        app.MapGet("/api/demoVideo", () =>
        {
            var path = AppPaths.ResolveDemoVideoPath(app.Environment.ContentRootPath);
            if (!File.Exists(path))
                return Results.NotFound("Missing demo video");

            return Results.File(path, contentType: "video/mp4", enableRangeProcessing: true);
        });

        app.MapGet("/demo-live", () =>
        {
            var videoSrc = $"/api/demoVideo?ts={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";

            var html = $$"""
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: #000;
            overflow: hidden;
        }
        .wrap {
            position: fixed;
            inset: 0;
            display: flex;
            align-items: flex-start;
            justify-content: flex-start;
            background: #000;
        }
        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            object-position: top left;
            background: #000;
        }
        .msg {
            position: fixed;
            inset: 0;
            display: none;
            align-items: center;
            justify-content: center;
            color: #fff;
            font: 600 18px system-ui, Segoe UI, Arial, sans-serif;
            text-align: center;
            padding: 24px;
        }
    </style>
</head>
<body>
    <div class="wrap">
        <video id="demoVideo" autoplay muted loop playsinline>
            <source src="{{videoSrc}}" type="video/mp4">
        </video>
    </div>

    <div id="msg" class="msg">Missing demo video</div>

    <script>
        const video = document.getElementById("demoVideo");
        const msg = document.getElementById("msg");

        video.addEventListener("error", () => {
            video.style.display = "none";
            msg.style.display = "flex";
        });

        video.play().catch(() => { });
    </script>
</body>
</html>
""";

            return Results.Content(html, "text/html");
        });

        app.MapGet("/rtsp-live", () =>
        {
            var whepUrl = "http://127.0.0.1:8889/mystream/whep";

            var html = $$"""
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: #000;
            overflow: hidden;
        }
        .wrap {
            position: fixed;
            inset: 0;
            background: #000;
        }
        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            object-position: top left;
            background: #000;
            display: block;
        }
        .msg {
            position: fixed;
            inset: 0;
            display: none;
            align-items: center;
            justify-content: center;
            color: #fff;
            font: 600 18px system-ui, Segoe UI, Arial, sans-serif;
            text-align: center;
            padding: 24px;
        }
    </style>
    <script defer src="/mediamtx-reader.js"></script>
</head>
<body>
    <div class="wrap">
        <video id="liveVideo" autoplay muted playsinline disablepictureinpicture></video>
    </div>

    <div id="msg" class="msg">Live stream unavailable</div>

    <script>
        const video = document.getElementById("liveVideo");
        const msg = document.getElementById("msg");
        let reader = null;

        function showError(message) {
            msg.textContent = message || "Live stream unavailable";
            msg.style.display = "flex";
        }

        function hideError() {
            msg.style.display = "none";
        }

        window.addEventListener("load", () => {
            if (!window.MediaMTXWebRTCReader) {
                showError("Live stream client failed to load");
                return;
            }

            reader = new MediaMTXWebRTCReader({
                url: "{{whepUrl}}",
                onError: (err) => {
                    showError(String(err || "Live stream unavailable"));
                },
                onTrack: (evt) => {
                    video.srcObject = evt.streams[0];
                    hideError();
                    video.play().catch(() => { });
                },
            });
        });

        window.addEventListener("beforeunload", () => {
            if (reader !== null) {
                reader.close();
                reader = null;
            }
        });
    </script>
</body>
</html>
""";

            return Results.Content(html, "text/html");
        });

        app.MapPost("/api/record/start", async (MediaMtxManager mtx, RecorderManager recorder, StartRecordingRequest? req) =>
        {
            var cfg = LoadConfig();

            if (!cfg.DemoMode)
                mtx.EnsureRunning(cfg);

            await recorder.StartRecordingAsync(cfg, cfg.DemoMode ? req?.demoStartSeconds : null);

            var session = app.Services.GetRequiredService<SessionManager>();
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/record/stop", async (RecorderManager recorder, StopRecordingRequest req) =>
        {
            var cfg = LoadConfig();
            await recorder.StopRecordingAndGetDurationSecondsAsync(cfg, req.uiElapsedSeconds, req.programTimerStartOffsetSeconds);

            var session = app.Services.GetRequiredService<SessionManager>();
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/record/clipToggle", (ClipToggleRequest req, SessionManager session) =>
        {
            var nowSeconds = req.nowSeconds;

            if (session.OpenClipStartSeconds is null)
            {
                var lastClipEnd = 0.0;
                foreach (var clip in session.Clips)
                {
                    if (clip.EndSeconds > lastClipEnd)
                        lastClipEnd = clip.EndSeconds;
                }

                nowSeconds = Math.Max(nowSeconds, lastClipEnd);
            }

            session.ToggleClipMarker(nowSeconds);
            var cfg = LoadConfig();
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/record/undo", (SessionManager session) =>
        {
            session.UndoLastClipAction();
            var cfg = LoadConfig();
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/record/redo", (SessionManager session) =>
        {
            session.RedoLastClipAction();
            var cfg = LoadConfig();
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/session/clear", (SessionManager session, RecorderManager recorder) =>
        {
            recorder.StopIfRunning();

            try { if (File.Exists(recorder.HighResOutputFilePath)) File.Delete(recorder.HighResOutputFilePath); } catch { }
            try { if (File.Exists(recorder.HighResTempFilePath)) File.Delete(recorder.HighResTempFilePath); } catch { }
            try { if (File.Exists(recorder.LowResOutputFilePath)) File.Delete(recorder.LowResOutputFilePath); } catch { }
            try { if (File.Exists(recorder.LowResTempFilePath)) File.Delete(recorder.LowResTempFilePath); } catch { }

            session.ClearAll();
            var cfg = LoadConfig();
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapGet("/api/recording/file", async (HttpContext http, RecorderManager recorder, SessionManager session, string? kind, string? v) =>
        {
            if (!session.IsReplayMediaAvailable())
            {
                http.Response.StatusCode = StatusCodes.Status404NotFound;
                await http.Response.WriteAsync("No replay clips currently available.");
                return;
            }

            var wantLowRes = string.Equals(kind, "low-res", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(kind, "lowres", StringComparison.OrdinalIgnoreCase);
            if (wantLowRes && !session.IsReplayMediaTokenCurrent(v))
            {
                http.Response.StatusCode = StatusCodes.Status404NotFound;
                await http.Response.WriteAsync("Replay media token is no longer current.");
                return;
            }

            var path = wantLowRes
                ? recorder.LowResOutputFilePath
                : recorder.HighResOutputFilePath;

            if (!File.Exists(path))
            {
                http.Response.StatusCode = StatusCodes.Status404NotFound;
                await http.Response.WriteAsync("No recording found.");
                return;
            }

            var fileInfo = new FileInfo(path);
            var lastModified = new DateTimeOffset(fileInfo.LastWriteTimeUtc, TimeSpan.Zero);
            var entityTag = new EntityTagHeaderValue($"\"{fileInfo.Length:x}-{fileInfo.LastWriteTimeUtc.Ticks:x}\"");
            http.Response.Headers[HeaderNames.CacheControl] = wantLowRes
                ? "private, max-age=31536000, immutable"
                : "public, max-age=0, must-revalidate";

            await Results.File(
                path,
                contentType: "video/mp4",
                lastModified: lastModified,
                entityTag: entityTag,
                enableRangeProcessing: true).ExecuteAsync(http);
        });

        app.MapPost("/api/replay/delete", async (HttpRequest req, SessionManager session) =>
        {
            var cfg = LoadConfig();
            var root = await ReadJsonRootAsync(req);
            if (root is null) return Results.BadRequest("Missing JSON body.");

            var clipIndex = TryGetInt(root.Value, "index");
            if (clipIndex is null || clipIndex.Value <= 0) return Results.BadRequest("Missing index.");

            session.DeleteClip(clipIndex.Value);
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/record/delete", async (HttpRequest req, SessionManager session) =>
        {
            var cfg = LoadConfig();
            var root = await ReadJsonRootAsync(req);
            if (root is null) return Results.BadRequest("Missing JSON body.");

            var clipIndex = TryGetInt(root.Value, "index");
            if (clipIndex is null || clipIndex.Value <= 0) return Results.BadRequest("Missing index.");

            session.DeleteClipWhileRecording(clipIndex.Value);
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/replay/split", async (HttpRequest req, SessionManager session) =>
        {
            var cfg = LoadConfig();
            var root = await ReadJsonRootAsync(req);
            if (root is null) return Results.BadRequest("Missing JSON body.");

            var clipIndex = TryGetInt(root.Value, "index");
            var splitSeconds = TryGetDouble(root.Value, "splitSeconds");

            if (clipIndex is null || clipIndex.Value <= 0) return Results.BadRequest("Missing index.");
            if (splitSeconds is null) return Results.BadRequest("Missing splitSeconds.");

            session.SplitClip(clipIndex.Value, splitSeconds.Value);
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/replay/insert", async (HttpRequest req, SessionManager session) =>
        {
            var cfg = LoadConfig();
            var root = await ReadJsonRootAsync(req);
            if (root is null) return Results.BadRequest("Missing JSON body.");

            var startSeconds = TryGetDouble(root.Value, "startSeconds");
            var endSeconds = TryGetDouble(root.Value, "endSeconds");
            if (startSeconds is null || endSeconds is null)
                return Results.BadRequest("Missing startSeconds or endSeconds.");

            session.InsertClip(startSeconds.Value, endSeconds.Value);
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/replay/trimIn", async (HttpRequest req, SessionManager session) =>
        {
            var cfg = LoadConfig();
            var root = await ReadJsonRootAsync(req);
            if (root is null) return Results.BadRequest("Missing JSON body.");

            var clipIndex = TryGetInt(root.Value, "clipIndex");
            var atSeconds = TryGetDouble(root.Value, "atSeconds");

            if (clipIndex is null || clipIndex.Value <= 0) return Results.BadRequest("Missing clipIndex.");
            if (atSeconds is null) return Results.BadRequest("Missing atSeconds.");

            session.TrimIn(clipIndex.Value, atSeconds.Value);
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/replay/trimOut", async (HttpRequest req, SessionManager session) =>
        {
            var cfg = LoadConfig();
            var root = await ReadJsonRootAsync(req);
            if (root is null) return Results.BadRequest("Missing JSON body.");

            var clipIndex = TryGetInt(root.Value, "clipIndex");
            var atSeconds = TryGetDouble(root.Value, "atSeconds");

            if (clipIndex is null || clipIndex.Value <= 0) return Results.BadRequest("Missing clipIndex.");
            if (atSeconds is null) return Results.BadRequest("Missing atSeconds.");

            session.TrimOut(clipIndex.Value, atSeconds.Value);
            return Results.Ok(session.GetStatus(cfg.SourceFps));
        });

        app.MapPost("/api/app/restart", () =>
        {
            if (ShellCommands.RequestRestart())
                return Results.Ok(new { ok = true });

            return Results.BadRequest("Restart is only available when running the native shell app.");
        });

        app.MapPost("/api/panel/restart", () =>
        {
            return Results.Ok(new { ok = true });
        });

        app.MapGet("/api/hostping", async (string? host) =>
        {
            host = (host ?? "").Trim();

            if (string.IsNullOrWhiteSpace(host))
            {
                return Results.Ok(new
                {
                    ok = false,
                    host = "",
                    roundTripMs = (long?)null,
                    color = "red",
                    error = "Missing host."
                });
            }

            var sw = Stopwatch.StartNew();

            try
            {
                using var ping = new Ping();
                var reply = await ping.SendPingAsync(host, 500);
                sw.Stop();

                if (reply.Status != IPStatus.Success)
                {
                    return Results.Ok(new
                    {
                        ok = false,
                        host,
                        roundTripMs = (long?)null,
                        color = "red",
                        error = reply.Status.ToString()
                    });
                }

                var roundTripMs = Math.Max(1L, sw.ElapsedMilliseconds);
                var color = roundTripMs <= 100 ? "green" : "yellow";

                return Results.Ok(new
                {
                    ok = true,
                    host,
                    roundTripMs,
                    color
                });
            }
            catch (Exception ex)
            {
                sw.Stop();

                return Results.Ok(new
                {
                    ok = false,
                    host,
                    roundTripMs = (long?)null,
                    color = "red",
                    error = ex.Message
                });
            }
        });

        return app;
    }
}

public record StartRecordingRequest(double? demoStartSeconds);
public record StopRecordingRequest(double? uiElapsedSeconds, double? programTimerStartOffsetSeconds);
