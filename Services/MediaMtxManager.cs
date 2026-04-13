using Microsoft.AspNetCore.Hosting;
//MediaMtxManager.cs
using System.Diagnostics;
using System.Text;
using ElementReview.Models;

namespace ElementReview.Services;

// Owns the lightweight MediaMTX sidecar that relays the configured RTSP source
// into a stable local endpoint for the browser UI and recorder pipeline.
public class MediaMtxManager
{
    private readonly object _lock = new();
    private Process? _proc;

    private readonly string _contentRoot;
    private readonly string _toolsDir;
    private readonly string _dataDir;

    public MediaMtxManager(IWebHostEnvironment env)
    {
        _contentRoot = env.ContentRootPath;
        _toolsDir = Path.Combine(_contentRoot, "tools");
        _dataDir = Path.Combine(_contentRoot, "data");
        Directory.CreateDirectory(_dataDir);
    }

    public string WebRtcEmbedUrl(string pathName = "mystream")
        => $"http://127.0.0.1:8889/{pathName}?controls=false&muted=true&autoplay=true";

    // Public lifecycle methods used by the app server when config changes or
    // when live viewing needs to ensure the local relay is ready.
    public void Restart(AppConfig cfg)
    {
        lock (_lock)
        {
            Stop_NoLock();
            WriteConfig(cfg);
            Start_NoLock();
        }
    }

    public void EnsureRunning(AppConfig cfg)
    {
        lock (_lock)
        {
            if (_proc != null && !_proc.HasExited) return;
            WriteConfig(cfg);
            Start_NoLock();
        }
    }

    private void WriteConfig(AppConfig cfg)
    {
        var ymlPath = Path.Combine(_dataDir, "mediamtx.yml");

        var sb = new StringBuilder();
        sb.AppendLine("logLevel: info");
        sb.AppendLine("logDestinations: [stdout]");
        sb.AppendLine();

        // Optional: a larger buffer can smooth minor RTSP jitter (RAM, not CPU)
        // Keep modest to avoid unnecessary memory use.
        sb.AppendLine("readBufferCount: 1024");
        sb.AppendLine();

        sb.AppendLine("api: yes");
        sb.AppendLine("apiAddress: 127.0.0.1:9997");
        sb.AppendLine();

        sb.AppendLine("webrtc: yes");
        sb.AppendLine("webrtcAddress: :8889");
        sb.AppendLine("webrtcLocalUDPAddress: :8189");
        sb.AppendLine();

        sb.AppendLine("rtsp: yes");
        sb.AppendLine("rtspAddress: 127.0.0.1:8554");
        sb.AppendLine();

        sb.AppendLine("paths:");
        sb.AppendLine("  mystream:");
        sb.AppendLine($"    source: \"{cfg.RtspUrl}\"");
        sb.AppendLine("    sourceOnDemand: yes");

        // Important: force TCP to reduce packet-loss/jitter issues (stability > latency spikes).
        sb.AppendLine("    sourceProtocol: tcp");

        File.WriteAllText(ymlPath, sb.ToString(), Encoding.UTF8);
    }

    // MediaMTX runs as a quiet child process in the background.
    private void Start_NoLock()
    {
        var exe = Path.Combine(_toolsDir, "mediamtx.exe");
        var cfg = Path.Combine(_dataDir, "mediamtx.yml");

        if (!File.Exists(exe))
            throw new FileNotFoundException("Missing tools/mediamtx.exe", exe);

        _proc = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = $"\"{cfg}\"",
                WorkingDirectory = _toolsDir,
                UseShellExecute = false,
                CreateNoWindow = true
            },
            EnableRaisingEvents = true
        };
        _proc.Start();
    }

    private void Stop_NoLock()
    {
        try
        {
            if (_proc == null) return;
            if (_proc.HasExited) { _proc.Dispose(); _proc = null; return; }

            _proc.Kill(entireProcessTree: true);
            _proc.WaitForExit(2000);
        }
        catch { /* best-effort */ }
        finally
        {
            _proc?.Dispose();
            _proc = null;
        }
    }
}
