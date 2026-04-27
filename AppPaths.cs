namespace ElementReview;

internal static class AppPaths
{
    private const string AppFolderName = "ElementReview";

    public static string LocalAppRootDir =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            AppFolderName);

    public static string LocalDataDir => Path.Combine(LocalAppRootDir, "data");
    public static string LocalConfigPath => Path.Combine(LocalDataDir, "appconfig.json");
    public static string LocalPanelConfigPath => Path.Combine(LocalDataDir, "panelConfig.json");
    public static string LocalElementsPath => Path.Combine(LocalDataDir, "SessionInfo.json");
    public static string LocalDemoVideoPath => Path.Combine(LocalDataDir, "demovideo.mp4");
    public static string LocalMediaMtxConfigPath => Path.Combine(LocalDataDir, "mediamtx.yml");
    public static string LocalHighResVideoPath => Path.Combine(LocalDataDir, "current-high-res.mp4");
    public static string LocalHighResTempVideoPath => Path.Combine(LocalDataDir, "current-high-res-recording.mp4");
    public static string LocalLowResVideoPath => Path.Combine(LocalDataDir, "current-low-res.mp4");
    public static string LocalLowResTempVideoPath => Path.Combine(LocalDataDir, "current-low-res-recording.mp4");
    public static string WebView2UserDataDir => Path.Combine(LocalAppRootDir, "WebView2");

    public static string DefaultSavedVideosFolder
    {
        get
        {
            var videosRoot = Environment.GetFolderPath(Environment.SpecialFolder.MyVideos);

            if (string.IsNullOrWhiteSpace(videosRoot))
                return Path.Combine(LocalAppRootDir, "videos");

            return Path.Combine(videosRoot, AppFolderName);
        }
    }

    public static void EnsureLocalDataDirectory()
    {
        Directory.CreateDirectory(LocalDataDir);
    }

    public static string GetBundledDataDir(string contentRoot) => Path.Combine(contentRoot, "data");
    public static string GetBundledConfigPath(string contentRoot) => Path.Combine(GetBundledDataDir(contentRoot), "appconfig.json");
    public static string GetBundledElementsPath(string contentRoot) => Path.Combine(GetBundledDataDir(contentRoot), "SessionInfo.json");
    public static string GetBundledDemoVideoPath(string contentRoot) => Path.Combine(GetBundledDataDir(contentRoot), "demovideo.mp4");

    public static string ResolveDemoVideoPath(string contentRoot)
    {
        if (File.Exists(LocalDemoVideoPath))
            return LocalDemoVideoPath;

        var bundledDemoVideoPath = GetBundledDemoVideoPath(contentRoot);
        if (File.Exists(bundledDemoVideoPath))
            return bundledDemoVideoPath;

        return LocalDemoVideoPath;
    }

    public static string ResolveElementsPath(string contentRoot)
    {
        if (File.Exists(LocalElementsPath))
            return LocalElementsPath;

        var bundledElementsPath = GetBundledElementsPath(contentRoot);
        if (File.Exists(bundledElementsPath))
            return bundledElementsPath;

        return LocalElementsPath;
    }

    public static void TryMigrateLegacyConfig(string contentRoot)
    {
        if (File.Exists(LocalConfigPath))
            return;

        var legacyConfigPath = GetBundledConfigPath(contentRoot);
        if (!File.Exists(legacyConfigPath))
            return;

        EnsureLocalDataDirectory();
        File.Copy(legacyConfigPath, LocalConfigPath, overwrite: false);
    }
}
