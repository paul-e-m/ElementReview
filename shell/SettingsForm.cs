using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Diagnostics;
using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace ElementReview.Shell;

public sealed class SettingsForm : Form
{
    private readonly WebView2 _webView;
    private readonly string _operatorAuthToken;
    private string _pendingUrl;

    public SettingsForm(string url, string operatorAuthToken)
    {
        _pendingUrl = url;
        _operatorAuthToken = operatorAuthToken;

        Text = "Element Review Settings";
        Icon = AppWindowIcon.Extract() ?? Icon;
        StartPosition = FormStartPosition.CenterParent;
        MinimumSize = new Size(900, 650);
        Width = 1100;
        Height = 800;

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.White
        };

        Controls.Add(_webView);
        Load += async (_, _) => await InitializeWebViewAsync();
    }

    public void NavigateTo(string url)
    {
        _pendingUrl = url;

        if (_webView.CoreWebView2 != null)
            _webView.CoreWebView2.Navigate(_pendingUrl);
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var webViewEnvironment = await WebViewEnvironmentProvider.GetAsync();
            await _webView.EnsureCoreWebView2Async(webViewEnvironment);
            await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                BuildOperatorTokenInjectionScript(_operatorAuthToken));
            _webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
            _webView.CoreWebView2.WindowCloseRequested += (_, _) => BeginInvoke(new Action(Close));
            _webView.CoreWebView2.Navigate(_pendingUrl);
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

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        var target = e.Uri ?? "";

        if (!string.IsNullOrWhiteSpace(target))
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = target,
                    UseShellExecute = true
                });
            }
            catch
            {
            }
        }

        e.Handled = true;
    }
}
