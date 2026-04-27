using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace PanelReplay;

public sealed class PanelMainForm : Form
{
    private const string SettingsVirtualHost = "panel-replay.local";
    private const string AssetVersion = "20260426-demand1";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly WebView2 _webView;
    private readonly HttpClient _apiClient = new()
    {
        Timeout = TimeSpan.FromSeconds(30)
    };
    private readonly ReplayMediaCacheServer _mediaCacheServer;

    public PanelMainForm()
    {
        Text = "Panel Replay";
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        MinimumSize = new Size(900, 650);

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.Black
        };

        Controls.Add(_webView);
        _mediaCacheServer = new ReplayMediaCacheServer(_apiClient, PanelConfigStore.Load);
        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosed += (_, _) => _mediaCacheServer.Dispose();
    }

    private static string BuildRemotePanelUrl(PanelConfig config)
    {
        var url = $"https://{SettingsVirtualHost}/panel.html?0&v={AssetVersion}&panelReplay=true";
        return config.TimerEnabled ? url + "&timer=true" : url;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var environment = await WebViewEnvironmentProvider.GetAsync();
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                SettingsVirtualHost,
                Path.Combine(AppContext.BaseDirectory, "wwwroot"),
                CoreWebView2HostResourceAccessKind.Allow);
            _webView.CoreWebView2.Settings.IsZoomControlEnabled = true;
            _webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            await NavigatePanelAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "WebView2 could not be initialized.\r\n\r\n" + ex.Message,
                "Panel Replay",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private async Task NavigatePanelAsync()
    {
        if (_webView.CoreWebView2 == null) return;
        var config = PanelConfigStore.Load();
        _webView.CoreWebView2.Navigate(BuildRemotePanelUrl(config));
    }

    private static Uri BuildBackendUri(PanelConfig config, string pathAndQuery)
    {
        if (!pathAndQuery.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Only /api requests can be proxied.");
        }

        var separatorIndex = pathAndQuery.IndexOf('?');
        var path = separatorIndex >= 0 ? pathAndQuery[..separatorIndex] : pathAndQuery;
        var query = separatorIndex >= 0 ? pathAndQuery[(separatorIndex + 1)..] : "";

        return new UriBuilder("http", config.ServerIp, 5050)
        {
            Path = path,
            Query = query
        }.Uri;
    }

    private async Task<JsonElement> GetApiJsonAsync(string pathAndQuery)
    {
        var targetUri = BuildBackendUri(PanelConfigStore.Load(), pathAndQuery);
        using var response = await _apiClient.GetAsync(targetUri);
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    private object CacheReplayMedia(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            throw new InvalidOperationException("Missing replay media token.");
        }

        var safeToken = string.Concat(token.Where(char.IsLetterOrDigit));
        if (safeToken.Length == 0)
        {
            throw new InvalidOperationException("Invalid replay media token.");
        }

        return _mediaCacheServer.GetMediaInfo(safeToken);
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        int id = 0;
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            id = root.TryGetProperty("id", out var idProperty) ? idProperty.GetInt32() : 0;
            var action = root.TryGetProperty("action", out var actionProperty)
                ? actionProperty.GetString()
                : "";

            if (action == "loadConfig")
            {
                PostSuccess(id, PanelConfigStore.Load());
                return;
            }

            if (action == "apiGet")
            {
                var payload = root.GetProperty("payload");
                var path = payload.TryGetProperty("path", out var pathProperty)
                    ? pathProperty.GetString()
                    : "";
                if (string.IsNullOrWhiteSpace(path))
                {
                    throw new InvalidOperationException("Missing API path.");
                }

                PostSuccess(id, await GetApiJsonAsync(path));
                return;
            }

            if (action == "cacheMedia")
            {
                var payload = root.GetProperty("payload");
                var token = payload.TryGetProperty("token", out var tokenProperty)
                    ? tokenProperty.GetString()
                    : "";
                PostSuccess(id, CacheReplayMedia(token ?? ""));
                return;
            }

            if (action == "cleanupMediaCache")
            {
                PostSuccess(id, _mediaCacheServer.CleanupOldMedia(TimeSpan.FromHours(3)));
                return;
            }

            if (action == "saveConfig" || action == "saveConfigAndReload")
            {
                var payload = root.GetProperty("payload").GetRawText();
                var incoming = JsonSerializer.Deserialize<PanelConfig>(payload, JsonOptions);
                var saved = PanelConfigStore.Save(incoming);
                PostSuccess(id, saved);
                return;
            }

            PostError(id, "Unknown panel action.");
        }
        catch (Exception ex)
        {
            PostError(id, ex.Message);
        }
    }

    private void PostSuccess(int id, object? data)
    {
        PostMessage(new { id, ok = true, data });
    }

    private void PostError(int id, string error)
    {
        PostMessage(new { id, ok = false, error });
    }

    private void PostMessage(object message)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => PostMessage(message)));
            return;
        }

        var json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }
}
