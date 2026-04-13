using Microsoft.AspNetCore.Hosting;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using ElementReview.Models;

//RecorderManager.cs
namespace ElementReview.Services;

// Coordinates the ffmpeg-based recording pipeline. It starts and stops
// captures, produces replay assets, and optionally exports saved videos using
// SessionInfo metadata for naming.
public class RecorderManager
{
    private readonly object _lock = new();
    private Process? _ffmpeg;
    private CancellationTokenSource? _startMonitorCts;
    private Task? _startMonitorTask;
    private TaskCompletionSource<bool>? _startResultTcs;
    private Task? _inputWarmupTask;
    private DateTime _lastInputWarmupUtc = DateTime.MinValue;

    private readonly string _contentRoot;
    private readonly string _toolsDir;
    private readonly string _dataDir;

    private readonly string _encodedFile;
    private readonly string _encodedTempFile;
    private readonly string _copiedFile;
    private readonly string _copiedTempFile;

    private readonly SessionManager _session;

    private HashSet<string>? _availableEncoders;
    private string? _resolvedHardwareEncoderName;

    private static readonly TimeSpan RecordingStartTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan InputWarmupCooldown = TimeSpan.FromSeconds(10);
    private const int RtspAnalyzeDurationUsec = 1_000_000;
    private const int RtspProbeSizeBytes = 262_144;

    public RecorderManager(IWebHostEnvironment env, SessionManager session)
    {
        _contentRoot = env.ContentRootPath;
        _toolsDir = Path.Combine(_contentRoot, "tools");
        _dataDir = AppPaths.LocalDataDir;
        Directory.CreateDirectory(_dataDir);

        _encodedFile = AppPaths.LocalEncodedVideoPath;
        _encodedTempFile = AppPaths.LocalEncodedTempVideoPath;
        _copiedFile = AppPaths.LocalCopiedVideoPath;
        _copiedTempFile = AppPaths.LocalCopiedTempVideoPath;

        _session = session;
    }

    // Backward-compatible aliases used elsewhere in the app.
    public string OutputFilePath => _encodedFile;
    public string TempFilePath => _encodedTempFile;

    public string EncodedOutputFilePath => _encodedFile;
    public string EncodedTempFilePath => _encodedTempFile;
    public string CopiedOutputFilePath => _copiedFile;
    public string CopiedTempFilePath => _copiedTempFile;

    // Recording process lifecycle
    public bool IsRecording
    {
        get
        {
            lock (_lock) return _ffmpeg != null && !_ffmpeg.HasExited;
        }
    }

    public void StopIfRunning()
    {
        Process? p;
        lock (_lock)
        {
            CancelStartMonitor_NoLock();
            p = _ffmpeg;
            _ffmpeg = null;
        }

        if (p == null) return;

        try
        {
            TryGracefulStop(p);

            if (!p.WaitForExit(1500))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                try { p.WaitForExit(1500); } catch { }
            }
        }
        catch
        {
            // ignore
        }
        finally
        {
            try { p.Dispose(); } catch { }
        }
    }

    // Warm up encoder detection before the user presses Start Recording.
    // This moves ffmpeg capability probing off the operator's critical path.
    public void Warmup(AppConfig cfg)
    {
        string? ffmpegExe = null;
        bool shouldWarmInput = false;

        lock (_lock)
        {
            ffmpegExe = Path.Combine(_toolsDir, "ffmpeg.exe");
            if (!File.Exists(ffmpegExe)) return;

            var gop = GetConfiguredGop(cfg);
            _ = ResolveEncoderName(ffmpegExe, cfg, gop);

            if (!cfg.DemoMode &&
                (_inputWarmupTask == null || _inputWarmupTask.IsCompleted) &&
                DateTime.UtcNow - _lastInputWarmupUtc >= InputWarmupCooldown)
            {
                _lastInputWarmupUtc = DateTime.UtcNow;
                shouldWarmInput = true;
            }
        }

        if (shouldWarmInput && ffmpegExe != null)
        {
            _inputWarmupTask = Task.Run(() => WarmupRtspInput(ffmpegExe));
        }
    }

    public async Task<bool> StartRecordingAsync(AppConfig cfg, double? demoStartSeconds = null)
    {
        Process? startedProcess = null;
        CancellationTokenSource? startMonitorCts = null;
        TaskCompletionSource<bool>? firstFrameSeenTcs = null;
        Task<bool>? startResultTask = null;

        lock (_lock)
        {
            if (IsRecording) return true;

            CancelStartMonitor_NoLock();
            TryDelete(_encodedTempFile);
            TryDelete(_copiedTempFile);

            var ffmpegExe = Path.Combine(_toolsDir, "ffmpeg.exe");
            if (!File.Exists(ffmpegExe))
                throw new FileNotFoundException("Missing tools/ffmpeg.exe", ffmpegExe);

            var gop = GetConfiguredGop(cfg);
            var encoderName = ResolveEncoderName(ffmpegExe, cfg, gop);
            var inputArgs = BuildInputArgs(cfg, demoStartSeconds);

            var args =
                $"-hide_banner -loglevel warning -nostats -stats_period 0.1 -progress pipe:1 -y " +
                inputArgs +
                BuildEncodedOutputArgs(encoderName, gop) +
                BuildCopiedOutputArgs();

            var psi = new ProcessStartInfo
            {
                FileName = ffmpegExe,
                Arguments = args,
                WorkingDirectory = _toolsDir,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };

            var process = new Process { StartInfo = psi };
            var localFirstFrameSeenTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            process.OutputDataReceived += (_, e) =>
            {
                if (TryParseProgressFrameCount(e.Data, out var frameCount) && frameCount > 0)
                {
                    localFirstFrameSeenTcs.TrySetResult(true);
                }
            };
            process.ErrorDataReceived += (_, _) => { };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            _ffmpeg = process;
            startedProcess = process;
            firstFrameSeenTcs = localFirstFrameSeenTcs;
            _startResultTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            startResultTask = _startResultTcs.Task;

            _session.OnRecordingArming();

            startMonitorCts = new CancellationTokenSource();
            _startMonitorCts = startMonitorCts;
        }

        if (startedProcess != null && startMonitorCts != null && firstFrameSeenTcs != null)
        {
            _startMonitorTask = Task.Run(() => MonitorRecordingStartAsync(startedProcess, firstFrameSeenTcs.Task, startMonitorCts.Token));
        }

        if (startResultTask == null)
            return _session.IsRecording;

        var completed = await Task.WhenAny(startResultTask, Task.Delay(RecordingStartTimeout + TimeSpan.FromSeconds(1)));
        if (completed != startResultTask)
            return _session.IsRecording;

        return await startResultTask;
    }

    private void CancelStartMonitor_NoLock()
    {
        try
        {
            _startMonitorCts?.Cancel();
            _startResultTcs?.TrySetResult(false);
        }
        catch
        {
            // ignore
        }
        finally
        {
            _startMonitorCts?.Dispose();
            _startMonitorCts = null;
            _startMonitorTask = null;
        }
    }

    private async Task MonitorRecordingStartAsync(Process process, Task firstFrameSeenTask, CancellationToken cancellationToken)
    {
        var deadlineUtc = DateTime.UtcNow + RecordingStartTimeout;

        try
        {
            while (!cancellationToken.IsCancellationRequested && DateTime.UtcNow < deadlineUtc)
            {
                if (process.HasExited)
                {
                    _session.CancelRecordingStart();
                    _startResultTcs?.TrySetResult(false);
                    return;
                }

                if (firstFrameSeenTask.IsCompletedSuccessfully)
                {
                    _session.OnRecordingStarted();
                    _startResultTcs?.TrySetResult(true);
                    return;
                }

                var remaining = deadlineUtc - DateTime.UtcNow;
                if (remaining <= TimeSpan.Zero) break;

                var delayTask = Task.Delay(
                    remaining < TimeSpan.FromMilliseconds(100) ? remaining : TimeSpan.FromMilliseconds(100),
                    cancellationToken
                );

                var completed = await Task.WhenAny(firstFrameSeenTask, delayTask);
                if (completed == firstFrameSeenTask && firstFrameSeenTask.IsCompletedSuccessfully)
                {
                    _session.OnRecordingStarted();
                    _startResultTcs?.TrySetResult(true);
                    return;
                }
            }

            if (!cancellationToken.IsCancellationRequested)
            {
                _session.CancelRecordingStart();
                _startResultTcs?.TrySetResult(false);
                TryTerminateProcess(process);
            }
        }
        catch (OperationCanceledException)
        {
            // ignore
        }
        catch
        {
            _session.CancelRecordingStart();
            _startResultTcs?.TrySetResult(false);
        }
    }

    private static bool TryParseProgressFrameCount(string? line, out long frameCount)
    {
        frameCount = 0;
        if (string.IsNullOrWhiteSpace(line)) return false;

        var trimmed = line.Trim();
        if (!trimmed.StartsWith("frame=", StringComparison.OrdinalIgnoreCase)) return false;

        var separatorIndex = trimmed.IndexOf('=');
        if (separatorIndex < 0 || separatorIndex == trimmed.Length - 1) return false;

        var value = trimmed[(separatorIndex + 1)..].Trim();
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out frameCount);
    }

    // Encoder selection and capability probing
    private static int GetConfiguredGop(AppConfig cfg)
    {
        var gop = cfg.RecordingGop;
        if (gop < 1) gop = 1;
        if (gop > 1000) gop = 1000;
        return gop;
    }

    private string ResolveEncoderName(string ffmpegExe, AppConfig cfg, int gop)
    {
        if (!cfg.UseHardwareEncodingWhenAvailable)
            return "libx264";

        if (!string.IsNullOrWhiteSpace(_resolvedHardwareEncoderName))
            return _resolvedHardwareEncoderName!;

        var available = GetAvailableEncoders(ffmpegExe);

        if (available.Contains("h264_qsv") && CanUseEncoder(ffmpegExe, "h264_qsv", gop))
        {
            _resolvedHardwareEncoderName = "h264_qsv";
            return _resolvedHardwareEncoderName;
        }

        if (available.Contains("h264_mf") && CanUseEncoder(ffmpegExe, "h264_mf", gop))
        {
            _resolvedHardwareEncoderName = "h264_mf";
            return _resolvedHardwareEncoderName;
        }

        _resolvedHardwareEncoderName = "libx264";
        return _resolvedHardwareEncoderName;
    }

    private HashSet<string> GetAvailableEncoders(string ffmpegExe)
    {
        if (_availableEncoders != null) return _availableEncoders;

        var psi = new ProcessStartInfo
        {
            FileName = ffmpegExe,
            Arguments = "-hide_banner -encoders",
            WorkingDirectory = _toolsDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        using var proc = new Process { StartInfo = psi };
        proc.Start();

        var text = proc.StandardOutput.ReadToEnd() + Environment.NewLine + proc.StandardError.ReadToEnd();
        proc.WaitForExit(3000);

        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var rawLine in text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var line = rawLine.Trim();
            if (line.Length == 0) continue;

            var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) continue;

            var name = parts[1];

            if (name.Equals("h264_qsv", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("h264_mf", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("libx264", StringComparison.OrdinalIgnoreCase))
            {
                found.Add(name);
            }
        }

        _availableEncoders = found;
        return found;
    }

    private bool CanUseEncoder(string ffmpegExe, string encoderName, int gop)
    {
        var args =
            $"-hide_banner -loglevel error " +
            $"-f lavfi -i color=size=128x72:rate=30:color=black " +
            BuildEncodedCodecArgs(encoderName, gop) +
            $"-frames:v 1 -f null -";

        var psi = new ProcessStartInfo
        {
            FileName = ffmpegExe,
            Arguments = args,
            WorkingDirectory = _toolsDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        using var proc = new Process { StartInfo = psi };
        proc.Start();

        proc.StandardOutput.ReadToEnd();
        proc.StandardError.ReadToEnd();

        if (!proc.WaitForExit(5000))
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            return false;
        }

        return proc.ExitCode == 0;
    }

    // Input and output argument builders
    private string BuildInputArgs(AppConfig cfg, double? demoStartSeconds = null)
    {
        if (cfg.DemoMode)
        {
            return BuildDemoInputArgs(demoStartSeconds);
        }

        return BuildRtspInputArgs();
    }

    private string BuildDemoInputArgs(double? demoStartSeconds)
    {
        var demoFile = AppPaths.ResolveDemoVideoPath(_contentRoot);
        if (!File.Exists(demoFile))
            throw new FileNotFoundException("Missing demo video", demoFile);

        var seek = Math.Max(0, demoStartSeconds ?? 0);

        return seek > 0.001
            ? $"-stream_loop -1 -ss {seek.ToString(CultureInfo.InvariantCulture)} -re -i \"{demoFile}\" "
            : $"-stream_loop -1 -re -i \"{demoFile}\" ";
    }

    private string BuildRtspInputArgs()
    {
        var localMtxRtsp = "rtsp://127.0.0.1:8554/mystream";

        // The recorder reads from a local MediaMTX relay, so we can bias toward
        // lower startup latency without paying for lossy network conditions here.
        return
            "-rtsp_transport tcp " +
            "-fflags +genpts+nobuffer " +
            "-flags low_delay " +
            $"-analyzeduration {RtspAnalyzeDurationUsec} " +
            $"-probesize {RtspProbeSizeBytes} " +
            $"-i \"{localMtxRtsp}\" ";
    }

    private void WarmupRtspInput(string ffmpegExe)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = ffmpegExe,
                Arguments =
                    "-hide_banner -loglevel error -y " +
                    BuildRtspInputArgs() +
                    "-map 0:v:0 -frames:v 1 -f null -",
                WorkingDirectory = _toolsDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            using var proc = new Process { StartInfo = psi };
            proc.Start();

            proc.StandardOutput.ReadToEnd();
            proc.StandardError.ReadToEnd();

            if (!proc.WaitForExit(6000))
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
            }
        }
        catch
        {
            // Best-effort only. A failed warm-up should never block recording.
        }
    }

    private string BuildEncodedOutputArgs(string encoderName, int gop)
    {
        return
            "-map 0:v:0 " +
            "-an " +
            BuildEncodedCodecArgs(encoderName, gop) +
            "-movflags +faststart " +
            "-avoid_negative_ts make_zero " +
            $"\"{_encodedTempFile}\" ";
    }

    private static string BuildEncodedCodecArgs(string encoderName, int gop)
    {
        return encoderName switch
        {
            "h264_qsv" =>
                "-c:v h264_qsv " +
                "-pix_fmt nv12 " +
                $"-g {gop} " +
                "-bf 0 " +
                "-look_ahead 0 ",

            "h264_mf" =>
                "-c:v h264_mf " +
                "-hw_encoding 1 " +
                "-pix_fmt nv12 " +
                $"-g {gop} " +
                "-bf 0 ",

            _ =>
                "-c:v libx264 " +
                "-preset ultrafast " +
                "-tune zerolatency " +
                "-pix_fmt yuv420p " +
                $"-g {gop} " +
                $"-keyint_min {gop} " +
                "-bf 0 " +
                "-sc_threshold 0 "
        };
    }

    private string BuildCopiedOutputArgs()
    {
        // Keep the source GOP by copying video directly.
        // Audio is encoded to AAC so the saved MP4 stays browser-friendly.
        return
            "-map 0:v:0 -map 0:a? " +
            "-c:v copy " +
            "-c:a aac " +
            "-b:a 128k " +
            "-movflags +faststart " +
            "-avoid_negative_ts make_zero " +
            $"\"{_copiedTempFile}\" ";
    }

    // Stop/finalize helpers and replay asset management
    public async Task<double> StopRecordingAndGetDurationSecondsAsync(AppConfig cfg, double? uiElapsedSeconds = null)
    {
        Process? p;
        lock (_lock)
        {
            CancelStartMonitor_NoLock();
            p = _ffmpeg;
            _ffmpeg = null;
        }

        if (p == null) return 0;

        try
        {
            if (!p.HasExited)
            {
                TryGracefulStop(p);

                if (!p.WaitForExit(4000))
                {
                    try { p.Kill(entireProcessTree: true); } catch { }
                    try { p.WaitForExit(2000); } catch { }
                }
            }
        }
        finally
        {
            try { p.Dispose(); } catch { }
        }

        FinalizeRecordingFiles();

        var dur = await ProbeDurationSecondsAsync(_encodedFile);
        _session.OnRecordingStopped(dur, uiElapsedSeconds);

        SaveRecordingCopyIfNeeded(cfg);

        return dur;
    }

    private static void TryGracefulStop(Process p)
    {
        try
        {
            if (p.StartInfo.RedirectStandardInput && p.StandardInput != null)
            {
                p.StandardInput.WriteLine("q");
                p.StandardInput.Flush();
                try { p.StandardInput.Close(); } catch { }
            }
        }
        catch
        {
            // ignore
        }
    }

    private static void TryTerminateProcess(Process p)
    {
        try
        {
            if (p.HasExited) return;

            TryGracefulStop(p);

            if (!p.WaitForExit(1500))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                try { p.WaitForExit(1500); } catch { }
            }
        }
        catch
        {
            // ignore
        }
    }

    private void FinalizeRecordingFiles()
    {
        MoveTempToFinal(_encodedTempFile, _encodedFile);
        MoveTempToFinal(_copiedTempFile, _copiedFile);
    }

    private static void MoveTempToFinal(string tempPath, string finalPath)
    {
        for (int i = 0; i < 20; i++)
        {
            try
            {
                TryDelete(finalPath);

                if (File.Exists(tempPath))
                    File.Move(tempPath, finalPath, overwrite: true);

                return;
            }
            catch
            {
                Thread.Sleep(100);
            }
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
        }
    }

    public async Task<double> ProbeDurationSecondsAsync(string filePath)
    {
        if (!File.Exists(filePath)) return 0;

        var ffprobeExe = Path.Combine(_toolsDir, "ffprobe.exe");
        if (!File.Exists(ffprobeExe))
            throw new FileNotFoundException("Missing tools/ffprobe.exe", ffprobeExe);

        var psi = new ProcessStartInfo
        {
            FileName = ffprobeExe,
            Arguments = $"-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \"{filePath}\"",
            WorkingDirectory = _toolsDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        using var proc = new Process { StartInfo = psi };
        proc.Start();

        var output = (await proc.StandardOutput.ReadToEndAsync()).Trim();
        proc.WaitForExit(2000);

        if (double.TryParse(
                output,
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture,
                out var d))
        {
            return Math.Max(0, d);
        }

        return 0;
    }

    // Saved-video export helpers
    private void SaveRecordingCopyIfNeeded(AppConfig cfg)
    {
        _session.SetSavedMarkerJsonPath(null);

        if (!cfg.SaveVideos) return;

        var sourceVideoPath = File.Exists(_copiedFile)
            ? _copiedFile
            : _encodedFile;

        if (!File.Exists(sourceVideoPath)) return;

        try
        {
            var exportInfo = ReadExportInfoFromElementsJson();

            var videosRoot = string.IsNullOrWhiteSpace(cfg.SavedVideosFolder)
                ? AppPaths.DefaultSavedVideosFolder
                : cfg.SavedVideosFolder.Trim();

            var targetFolder = videosRoot;

            var category = SanitizePathPart(exportInfo.CategoryName);
            var segment = SanitizePathPart(exportInfo.SegmentName);

            if (!string.IsNullOrWhiteSpace(category) && !string.IsNullOrWhiteSpace(segment))
            {
                targetFolder = Path.Combine(videosRoot, category, segment);
            }

            Directory.CreateDirectory(targetFolder);

            var baseName = BuildBaseFileName(exportInfo);
            if (string.IsNullOrWhiteSpace(baseName))
                baseName = DateTime.Now.ToString("yyyyMMddHHmmss");

            var savedVideoPath = Path.Combine(targetFolder, baseName + ".mp4");
            var savedJsonPath = Path.Combine(targetFolder, baseName + ".json");

            File.Copy(sourceVideoPath, savedVideoPath, overwrite: true);

            _session.SetSavedMarkerJsonPath(savedJsonPath);
        }
        catch
        {
            _session.SetSavedMarkerJsonPath(null);
        }
    }

    private ExportInfo ReadExportInfoFromElementsJson()
    {
        var path = AppPaths.ResolveElementsPath(_contentRoot);

        if (!File.Exists(path)) return new ExportInfo();

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;

            var info = new ExportInfo
            {
                CategoryName = FindStringRecursive(root, "categoryName", "CategoryName", "category", "Category"),
                SegmentName = FindStringRecursive(root, "segmentName", "SegmentName", "segment", "Segment", "segDesc", "SegDesc"),
                CompetitorFirstName = FindStringRecursive(root, "competitorFirstName", "CompetitorFirstName", "firstName", "FirstName"),
                CompetitorLastName = FindStringRecursive(root, "competitorLastName", "CompetitorLastName", "lastName", "LastName"),
                CompetitorClub = FindStringRecursive(root, "competitorClub", "CompetitorClub", "clubName", "ClubName", "club", "Club"),
                CompetitorSection = FindStringRecursive(root, "competitorSection", "CompetitorSection", "section", "Section")
            };

            if (string.IsNullOrWhiteSpace(info.CompetitorFirstName) && string.IsNullOrWhiteSpace(info.CompetitorLastName))
            {
                var fullName = FindStringRecursive(
                    root,
                    "competitorName",
                    "CompetitorName",
                    "competitorFullName",
                    "CompetitorFullName",
                    "skaterName",
                    "SkaterName");

                SplitFullName(fullName, out var firstName, out var lastName);

                info.CompetitorFirstName = firstName;
                info.CompetitorLastName = lastName;
            }

            return info;
        }
        catch
        {
            return new ExportInfo();
        }
    }

    private static string BuildBaseFileName(ExportInfo info)
    {
        var parts = new List<string>();

        var last = SanitizePathPart(info.CompetitorLastName);
        var first = SanitizePathPart(info.CompetitorFirstName);
        var club = SanitizePathPart(info.CompetitorClub);
        var section = SanitizePathPart(info.CompetitorSection);

        if (!string.IsNullOrWhiteSpace(last)) parts.Add(last);
        if (!string.IsNullOrWhiteSpace(first)) parts.Add(first);
        if (!string.IsNullOrWhiteSpace(club)) parts.Add(club);
        if (!string.IsNullOrWhiteSpace(section)) parts.Add(section);

        return parts.Count > 0
            ? string.Join("-", parts)
            : DateTime.Now.ToString("yyyyMMddHHmmss");
    }

    private static void SplitFullName(string? fullName, out string firstName, out string lastName)
    {
        firstName = "";
        lastName = "";

        if (string.IsNullOrWhiteSpace(fullName)) return;

        var trimmed = fullName.Trim();

        var commaParts = trimmed.Split(',', 2, StringSplitOptions.TrimEntries);
        if (commaParts.Length == 2)
        {
            lastName = commaParts[0];
            firstName = commaParts[1];
            return;
        }

        var parts = trimmed.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 1)
        {
            firstName = parts[0];
            return;
        }

        lastName = parts[^1];
        firstName = string.Join(" ", parts, 0, parts.Length - 1);
    }

    private static string SanitizePathPart(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";

        var pieces = value.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var cleaned = string.Join("_", pieces);

        foreach (var ch in Path.GetInvalidFileNameChars())
            cleaned = cleaned.Replace(ch, '_');

        return cleaned.Trim(' ', '_', '.');
    }

    private static string FindStringRecursive(JsonElement element, params string[] propertyNames)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var prop in element.EnumerateObject())
                {
                    for (int i = 0; i < propertyNames.Length; i++)
                    {
                        if (prop.Name.Equals(propertyNames[i], StringComparison.OrdinalIgnoreCase))
                        {
                            var value = JsonElementToString(prop.Value);
                            if (!string.IsNullOrWhiteSpace(value))
                                return value;
                        }
                    }
                }

                foreach (var prop in element.EnumerateObject())
                {
                    var nested = FindStringRecursive(prop.Value, propertyNames);
                    if (!string.IsNullOrWhiteSpace(nested))
                        return nested;
                }
                break;

            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    var nested = FindStringRecursive(item, propertyNames);
                    if (!string.IsNullOrWhiteSpace(nested))
                        return nested;
                }
                break;
        }

        return "";
    }

    private static string JsonElementToString(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? "",
            JsonValueKind.Number => element.ToString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => ""
        };
    }

    private sealed class ExportInfo
    {
        public string CategoryName { get; set; } = "";
        public string SegmentName { get; set; } = "";
        public string CompetitorFirstName { get; set; } = "";
        public string CompetitorLastName { get; set; } = "";
        public string CompetitorClub { get; set; } = "";
        public string CompetitorSection { get; set; } = "";
    }
}
