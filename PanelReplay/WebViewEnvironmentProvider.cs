using Microsoft.Web.WebView2.Core;

namespace PanelReplay;

internal static class WebViewEnvironmentProvider
{
    private static readonly Lazy<Task<CoreWebView2Environment>> SharedEnvironment =
        new(CreateSharedEnvironmentAsync);

    public static Task<CoreWebView2Environment> GetAsync() => SharedEnvironment.Value;

    private static async Task<CoreWebView2Environment> CreateSharedEnvironmentAsync()
    {
        Directory.CreateDirectory(PanelConfigStore.WebView2UserDataDir);
        return await CoreWebView2Environment.CreateAsync(userDataFolder: PanelConfigStore.WebView2UserDataDir);
    }
}
