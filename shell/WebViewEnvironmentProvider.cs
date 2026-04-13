using Microsoft.Web.WebView2.Core;

namespace ElementReview.Shell;

internal static class WebViewEnvironmentProvider
{
    private static readonly Lazy<Task<CoreWebView2Environment>> SharedEnvironment =
        new(CreateSharedEnvironmentAsync);

    public static Task<CoreWebView2Environment> GetAsync() => SharedEnvironment.Value;

    private static async Task<CoreWebView2Environment> CreateSharedEnvironmentAsync()
    {
        var userDataFolder = AppPaths.WebView2UserDataDir;

        Directory.CreateDirectory(userDataFolder);

        return await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
    }
}
