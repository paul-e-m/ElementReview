using Microsoft.Extensions.Hosting;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using ElementReview.Hosting;
using ElementReview.Models;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace ElementReview.Shell;

public sealed class MainForm : Form
{
    private readonly IHost _app;
    private readonly WebView2 _webView;

    private SettingsForm? _settingsForm;
    private bool _restarting;

    // WebView2 uses fractional zoom factors, while appconfig stores whole percents.
    // These bounds keep both representations aligned across the shell and config page.
    private const int DefaultUiZoomPercent = 90;
    private const int MinUiZoomPercent = 50;
    private const int MaxUiZoomPercent = 150;

    private static readonly string AppConfigPath = AppPaths.LocalConfigPath;
    private static readonly JsonSerializerOptions AppConfigJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    public MainForm(IHost app)
    {
        _app = app;

        Text = "Element Review";
        Icon = AppWindowIcon.Extract() ?? Icon;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1100, 750);
        Width = 1400;
        Height = 900;
        WindowState = FormWindowState.Maximized;

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.Black
        };

        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebViewAsync();
        HandleCreated += (_, _) => UpdateWindowBoundsForCurrentScreen(applyCurrentState: false);
        Shown += (_, _) => BeginInvoke(new Action(() => UpdateWindowBoundsForCurrentScreen(applyCurrentState: true)));
        LocationChanged += (_, _) => UpdateWindowBoundsForCurrentScreen(applyCurrentState: false);
        FormClosing += OnFormClosing;
        ShellCommands.RestartRequested += OnRestartRequested;
    }

    private void UpdateWindowBoundsForCurrentScreen(bool applyCurrentState)
    {
        if (!IsHandleCreated)
            return;

        var workingArea = Screen.FromHandle(Handle).WorkingArea;
        if (MaximizedBounds != workingArea)
            MaximizedBounds = workingArea;

        if (!applyCurrentState || WindowState != FormWindowState.Maximized)
            return;

        var bounds = Bounds;
        var alreadyFits =
            bounds.Left >= workingArea.Left &&
            bounds.Top >= workingArea.Top &&
            bounds.Right <= workingArea.Right &&
            bounds.Bottom <= workingArea.Bottom;

        if (alreadyFits)
            return;

        // Re-apply the working area if Windows reports a maximized window that still overlaps the taskbar.
        WindowState = FormWindowState.Normal;
        Bounds = workingArea;
        WindowState = FormWindowState.Maximized;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var webViewEnvironment = await WebViewEnvironmentProvider.GetAsync();
            await _webView.EnsureCoreWebView2Async(webViewEnvironment);
            await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                BuildOperatorTokenInjectionScript(AppServer.OperatorAuthToken));

            _webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;

            // Leave WebView2 zoom shortcuts enabled and persist the resulting factor back to appconfig.
            _webView.CoreWebView2.Settings.IsZoomControlEnabled = true;
            _webView.ZoomFactor = ReadUiZoomFactorFromConfig();
            _webView.ZoomFactorChanged += (_, _) =>
            {
                SaveCurrentZoomToConfig();
            };

            _webView.Source = new Uri(AppServer.MainPageUrl);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "WebView2 could not be initialized.\r\n\r\n" + ex.Message,
                "Element Review",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        var target = e.Uri ?? "";

        if (IsSettingsUrl(target))
        {
            BeginInvoke(new Action(() => OpenSettingsWindow(target)));
            e.Handled = true;
            return;
        }

        BeginInvoke(new Action(() => OpenInBrowser(string.IsNullOrWhiteSpace(target) ? AppServer.MainPageUrl : target)));
        e.Handled = true;
    }

    private void OpenSettingsWindow(string? url = null)
    {
        if (_settingsForm != null && !_settingsForm.IsDisposed)
        {
            _settingsForm.NavigateTo(url ?? AppServer.SettingsPageUrl);

            if (_settingsForm.WindowState == FormWindowState.Minimized)
                _settingsForm.WindowState = FormWindowState.Normal;

            _settingsForm.BringToFront();
            _settingsForm.Focus();
            return;
        }

        _settingsForm = new SettingsForm(url ?? AppServer.SettingsPageUrl, AppServer.OperatorAuthToken);
        _settingsForm.FormClosed += (_, _) => _settingsForm = null;
        _settingsForm.Show(this);
    }

    private static string BuildOperatorTokenInjectionScript(string token)
    {
        var tokenJson = JsonSerializer.Serialize(token ?? "");

        return "(() => {\n" +
            "  const host = window.location.hostname;\n" +
            "  if (host !== \"127.0.0.1\" && host !== \"localhost\" && host !== \"::1\") return;\n" +
            "  Object.defineProperty(window, \"__ELEMENT_REVIEW_OPERATOR_TOKEN\", {\n" +
            "    value: " + tokenJson + ",\n" +
            "    writable: false,\n" +
            "    configurable: false\n" +
            "  });\n" +
            "})();";
    }

    private static bool IsSettingsUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return false;

        return url.Contains("/config.html", StringComparison.OrdinalIgnoreCase);
    }

    private static void OpenInBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch
        {
        }
    }

    private void OnRestartRequested()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(OnRestartRequested));
            return;
        }

        if (_restarting)
            return;

        _restarting = true;

        try
        {
            var exePath = Application.ExecutablePath;

            Process.Start(new ProcessStartInfo
            {
                FileName = exePath,
                WorkingDirectory = AppContext.BaseDirectory,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            _restarting = false;
            MessageBox.Show(
                this,
                "Element Review could not restart itself.\r\n\r\n" + ex.Message,
                "Element Review",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        ShellCommands.RestartRequested -= OnRestartRequested;

        try
        {
            if (_settingsForm != null && !_settingsForm.IsDisposed)
                _settingsForm.Close();
        }
        catch
        {
        }
    }

    private static double ReadUiZoomFactorFromConfig()
    {
        var percent = ReadUiZoomPercentFromConfig();
        return percent / 100.0;
    }

    private static int ReadUiZoomPercentFromConfig()
    {
        try
        {
            if (!File.Exists(AppConfigPath))
                return DefaultUiZoomPercent;

            var json = File.ReadAllText(AppConfigPath);
            var root = JsonNode.Parse(json) as JsonObject;
            if (root == null)
                return DefaultUiZoomPercent;

            if (TryReadInt(root, "UiZoomPercent", out var percent))
                return ClampUiZoomPercent(percent);

            // Accept either whole percents or a pre-scaled factor.
            if (TryReadDouble(root, "UiZoomFactor", out var factor))
                return ClampUiZoomPercent((int)Math.Round(factor * 100.0));

            return DefaultUiZoomPercent;
        }
        catch
        {
            return DefaultUiZoomPercent;
        }
    }

    private void SaveCurrentZoomToConfig()
    {
        try
        {
            var percent = ClampUiZoomPercent(
                (int)Math.Round(_webView.ZoomFactor * 100.0));

            WriteUiZoomPercentToConfig(percent);
        }
        catch
        {
        }
    }

    private static void WriteUiZoomPercentToConfig(int percent)
    {
        try
        {
            percent = ClampUiZoomPercent(percent);

            Directory.CreateDirectory(Path.GetDirectoryName(AppConfigPath)!);
            AppConfig config;

            if (File.Exists(AppConfigPath))
            {
                var json = File.ReadAllText(AppConfigPath);
                config = JsonSerializer.Deserialize<AppConfig>(json, AppConfigJsonOptions) ?? new AppConfig();
            }
            else
            {
                config = new AppConfig();
            }

            config.UiZoomPercent = percent;

            File.WriteAllText(AppConfigPath, JsonSerializer.Serialize(config, AppConfigJsonOptions));
        }
        catch
        {
        }
    }

    private static int ClampUiZoomPercent(int percent)
    {
        if (percent < MinUiZoomPercent) return MinUiZoomPercent;
        if (percent > MaxUiZoomPercent) return MaxUiZoomPercent;
        return percent;
    }

    private static bool TryReadInt(JsonObject root, string propertyName, out int value)
    {
        value = 0;

        if (!root.TryGetPropertyValue(propertyName, out var node) || node == null)
            return false;

        if (node is JsonValue jsonValue)
        {
            if (jsonValue.TryGetValue<int>(out var intValue))
            {
                value = intValue;
                return true;
            }

            if (jsonValue.TryGetValue<double>(out var doubleValue))
            {
                value = (int)Math.Round(doubleValue);
                return true;
            }

            if (jsonValue.TryGetValue<string>(out var stringValue) &&
                int.TryParse(stringValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                value = parsed;
                return true;
            }
        }

        return false;
    }

    private static bool TryReadDouble(JsonObject root, string propertyName, out double value)
    {
        value = 0;

        if (!root.TryGetPropertyValue(propertyName, out var node) || node == null)
            return false;

        if (node is JsonValue jsonValue)
        {
            if (jsonValue.TryGetValue<double>(out var doubleValue))
            {
                value = doubleValue;
                return true;
            }

            if (jsonValue.TryGetValue<int>(out var intValue))
            {
                value = intValue;
                return true;
            }

            if (jsonValue.TryGetValue<string>(out var stringValue) &&
                double.TryParse(stringValue, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var parsed))
            {
                value = parsed;
                return true;
            }
        }

        return false;
    }
}
