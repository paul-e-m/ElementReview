using Microsoft.Extensions.Hosting;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using ElementReview.Hosting;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Forms;

//MainForm.cs
namespace ElementReview.Shell;

public sealed class MainForm : Form
{
    private readonly IHost _app;
    private readonly WebView2 _webView;

    private SettingsForm? _settingsForm;
    private bool _restarting;

    // ------------------------------------------------------------
    // UI zoom notes
    //
    // WebView2 uses a zoom factor where:
    //   1.0 = 100%
    //   0.9 =  90%
    //
    // We store the setting in data\appconfig.json as UiZoomPercent
    // so the shell and config.html both read/write the same value.
    //
    // Ctrl+ / Ctrl- continue to work because WebView2 zoom controls
    // remain enabled. When the user changes zoom, we save the new
    // value back into appconfig.json so it persists across sessions.
    // ------------------------------------------------------------
    private const int DefaultUiZoomPercent = 90;
    private const int MinUiZoomPercent = 50;
    private const int MaxUiZoomPercent = 250;

    private static readonly string AppConfigPath =
        Path.Combine(AppContext.BaseDirectory, "data", "appconfig.json");

    public MainForm(IHost app)
    {
        _app = app;

        Text = "Element Review";
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
        FormClosing += OnFormClosing;
        ShellCommands.RestartRequested += OnRestartRequested;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            await _webView.EnsureCoreWebView2Async();

            _webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;

            // Keep normal browser-like zoom controls enabled:
            // Ctrl+, Ctrl-, Ctrl+0, Ctrl+mouse wheel, etc.
            _webView.CoreWebView2.Settings.IsZoomControlEnabled = true;

            // Apply the saved default zoom before loading the main page.
            _webView.ZoomFactor = ReadUiZoomFactorFromConfig();

            // Save zoom whenever the user changes it.
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

        _settingsForm = new SettingsForm(url ?? AppServer.SettingsPageUrl);
        _settingsForm.FormClosed += (_, _) => _settingsForm = null;
        _settingsForm.Show(this);
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

            // Backward-compatible fallback in case a factor is ever stored instead.
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

            JsonObject root;

            if (File.Exists(AppConfigPath))
            {
                var json = File.ReadAllText(AppConfigPath);
                root = JsonNode.Parse(json) as JsonObject ?? new JsonObject();
            }
            else
            {
                root = new JsonObject();
            }

            root["UiZoomPercent"] = percent;

            File.WriteAllText(
                AppConfigPath,
                root.ToJsonString(new JsonSerializerOptions
                {
                    WriteIndented = true
                }));
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
