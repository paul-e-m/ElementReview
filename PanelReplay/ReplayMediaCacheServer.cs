using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;

namespace PanelReplay;

internal sealed class ReplayMediaCacheServer : IDisposable
{
    private const int ChunkSize = 512 * 1024;

    private readonly HttpClient _httpClient;
    private readonly Func<PanelConfig> _loadConfig;
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _chunkLocks = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, long> _lengths = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _remoteFetchGate = new(1, 1);
    private readonly Task _listenTask;

    public ReplayMediaCacheServer(HttpClient httpClient, Func<PanelConfig> loadConfig)
    {
        _httpClient = httpClient;
        _loadConfig = loadConfig;
        Port = FindFreePort();
        BaseUrl = $"http://127.0.0.1:{Port}";
        Directory.CreateDirectory(PanelConfigStore.ReplayMediaDirectory);
        _listener.Prefixes.Add(BaseUrl + "/");
        _listener.Start();
        _listenTask = Task.Run(() => ListenAsync(_cts.Token));
    }

    public int Port { get; }
    public string BaseUrl { get; }

    public object GetMediaInfo(string token)
    {
        var safeToken = SanitizeToken(token);
        if (safeToken.Length == 0)
        {
            throw new InvalidOperationException("Invalid replay media token.");
        }

        Directory.CreateDirectory(GetTokenDirectory(safeToken));
        return new { url = $"{BaseUrl}/media/replay-{safeToken}.mp4", cached = true };
    }

    public object CleanupOldMedia(TimeSpan maxAge)
    {
        Directory.CreateDirectory(PanelConfigStore.ReplayMediaDirectory);

        var cutoffUtc = DateTime.UtcNow - maxAge;
        var deleted = 0;

        foreach (var directoryPath in Directory.GetDirectories(PanelConfigStore.ReplayMediaDirectory))
        {
            try
            {
                var directory = new DirectoryInfo(directoryPath);
                if (!directory.Exists || directory.LastWriteTimeUtc > cutoffUtc)
                    continue;

                directory.Delete(recursive: true);
                deleted++;
            }
            catch
            {
                // A cache folder can be in use by an active media request. Leave
                // it for the next waiting-state cleanup pass.
            }
        }

        return new { deleted };
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            HttpListenerContext? context = null;
            try
            {
                context = await _listener.GetContextAsync();
                _ = Task.Run(() => HandleRequestAsync(context, cancellationToken), cancellationToken);
            }
            catch when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                if (context != null)
                {
                    TryClose(context.Response);
                }
            }
        }
    }

    private async Task HandleRequestAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        try
        {
            var requestPath = context.Request.Url?.AbsolutePath ?? "";
            var fileName = Path.GetFileName(requestPath);

            if (!requestPath.StartsWith("/media/", StringComparison.OrdinalIgnoreCase) ||
                !fileName.StartsWith("replay-", StringComparison.OrdinalIgnoreCase) ||
                !fileName.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.StatusCode = (int)HttpStatusCode.NotFound;
                return;
            }

            var token = fileName["replay-".Length..^".mp4".Length];
            token = SanitizeToken(token);
            if (token.Length == 0)
            {
                context.Response.StatusCode = (int)HttpStatusCode.BadRequest;
                return;
            }

            await ServeRangeAsync(context, token, cancellationToken);
        }
        catch
        {
            if (context.Response.OutputStream.CanWrite)
            {
                context.Response.StatusCode = (int)HttpStatusCode.BadGateway;
            }
        }
        finally
        {
            TryClose(context.Response);
        }
    }

    private async Task ServeRangeAsync(HttpListenerContext context, string token, CancellationToken cancellationToken)
    {
        var range = ParseRange(context.Request.Headers["Range"]);
        var start = Math.Max(0, range.start ?? 0);
        var requestedEnd = range.end;

        var firstChunk = start / ChunkSize;
        await EnsureChunkAsync(token, firstChunk, cancellationToken);

        var totalLength = _lengths[token];
        if (start >= totalLength)
        {
            context.Response.StatusCode = (int)HttpStatusCode.RequestedRangeNotSatisfiable;
            context.Response.Headers["Content-Range"] = $"bytes */{totalLength}";
            return;
        }

        var maxEnd = Math.Min(start + ChunkSize - 1, totalLength - 1);
        var end = requestedEnd.HasValue
            ? Math.Min(requestedEnd.Value, maxEnd)
            : maxEnd;

        context.Response.StatusCode = (int)HttpStatusCode.PartialContent;
        context.Response.ContentType = "video/mp4";
        context.Response.Headers["Accept-Ranges"] = "bytes";
        context.Response.Headers["Cache-Control"] = "private, max-age=31536000, immutable";
        context.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{totalLength}";
        context.Response.ContentLength64 = end - start + 1;

        var current = start;
        while (current <= end)
        {
            var chunkIndex = current / ChunkSize;
            await EnsureChunkAsync(token, chunkIndex, cancellationToken);

            var chunkPath = GetChunkPath(token, chunkIndex);
            var offset = current - (chunkIndex * ChunkSize);
            var bytesToWrite = (int)Math.Min(end - current + 1, new FileInfo(chunkPath).Length - offset);

            await using var file = File.OpenRead(chunkPath);
            file.Position = offset;
            await CopyBytesAsync(file, context.Response.OutputStream, bytesToWrite, cancellationToken);
            current += bytesToWrite;
        }
    }

    private async Task EnsureChunkAsync(string token, long chunkIndex, CancellationToken cancellationToken)
    {
        var chunkPath = GetChunkPath(token, chunkIndex);
        if (IsUsableChunk(token, chunkIndex, chunkPath)) return;

        var key = $"{token}:{chunkIndex}";
        var gate = _chunkLocks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (IsUsableChunk(token, chunkIndex, chunkPath)) return;

            Directory.CreateDirectory(GetTokenDirectory(token));
            var start = chunkIndex * ChunkSize;
            var end = start + ChunkSize - 1;
            await _remoteFetchGate.WaitAsync(cancellationToken);
            try
            {
                var request = new HttpRequestMessage(
                    HttpMethod.Get,
                    BuildBackendUri(_loadConfig(), BuildRecordingFilePath(token)))
                {
                    Headers =
                    {
                        Range = new RangeHeaderValue(start, end)
                    }
                };

                using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                response.EnsureSuccessStatusCode();

                var totalLength = response.Content.Headers.ContentRange?.Length;
                if (totalLength.HasValue)
                {
                    _lengths[token] = totalLength.Value;
                }

                var tempPath = chunkPath + ".tmp";
                await using (var source = await response.Content.ReadAsStreamAsync(cancellationToken))
                await using (var destination = File.Create(tempPath))
                {
                    await source.CopyToAsync(destination, cancellationToken);
                }

                File.Move(tempPath, chunkPath, overwrite: true);

                if (!_lengths.ContainsKey(token) && response.Content.Headers.ContentLength.HasValue)
                {
                    _lengths[token] = start + response.Content.Headers.ContentLength.Value;
                }
            }
            finally
            {
                _remoteFetchGate.Release();
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private bool IsUsableChunk(string token, long chunkIndex, string chunkPath)
    {
        if (!File.Exists(chunkPath)) return false;
        var length = new FileInfo(chunkPath).Length;
        if (length <= 0) return false;
        if (!_lengths.TryGetValue(token, out var totalLength)) return false;

        var expected = Math.Min(ChunkSize, Math.Max(0, totalLength - (chunkIndex * ChunkSize)));
        return expected <= 0 || length == expected;
    }

    private static async Task CopyBytesAsync(Stream source, Stream destination, int bytesToCopy, CancellationToken cancellationToken)
    {
        var buffer = new byte[Math.Min(64 * 1024, Math.Max(1, bytesToCopy))];
        var remaining = bytesToCopy;
        while (remaining > 0)
        {
            var read = await source.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remaining)), cancellationToken);
            if (read <= 0) break;
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            remaining -= read;
        }
    }

    private static (long? start, long? end) ParseRange(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return (null, null);
        if (!header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)) return (null, null);

        var parts = header["bytes=".Length..].Split(',', 2)[0].Split('-', 2);
        var start = long.TryParse(parts.ElementAtOrDefault(0), out var parsedStart) ? parsedStart : (long?)null;
        var end = long.TryParse(parts.ElementAtOrDefault(1), out var parsedEnd) ? parsedEnd : (long?)null;
        return (start, end);
    }

    private static Uri BuildBackendUri(PanelConfig config, string pathAndQuery)
    {
        var separatorIndex = pathAndQuery.IndexOf('?');
        var path = separatorIndex >= 0 ? pathAndQuery[..separatorIndex] : pathAndQuery;
        var query = separatorIndex >= 0 ? pathAndQuery[(separatorIndex + 1)..] : "";

        return new UriBuilder("http", config.ServerIp, 5050)
        {
            Path = path,
            Query = query
        }.Uri;
    }

    private static string BuildRecordingFilePath(string token)
        => $"/api/recording/file?kind=low-res&v={Uri.EscapeDataString(token)}";

    private static string SanitizeToken(string token)
        => string.Concat((token ?? "").Where(char.IsLetterOrDigit));

    private static string GetTokenDirectory(string token)
        => Path.Combine(PanelConfigStore.ReplayMediaDirectory, token);

    private static string GetChunkPath(string token, long chunkIndex)
        => Path.Combine(GetTokenDirectory(token), $"chunk-{chunkIndex:D8}.bin");

    private static int FindFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static void TryClose(HttpListenerResponse response)
    {
        try { response.OutputStream.Close(); } catch { }
        try { response.Close(); } catch { }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }
        try { _listener.Close(); } catch { }
        try { _listenTask.Wait(TimeSpan.FromSeconds(1)); } catch { }
        _cts.Dispose();
        _remoteFetchGate.Dispose();

        foreach (var gate in _chunkLocks.Values)
        {
            gate.Dispose();
        }
    }
}
