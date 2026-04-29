using System.Text.Json;

namespace JudgeVideoReplay;

internal static class JudgeVideoReplayConfigStore
{
    public const int DefaultUiZoomPercent = 100;
    public const int MinUiZoomPercent = 50;
    public const int MaxUiZoomPercent = 150;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    public static string AppDataRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "JudgeVideoReplay");

    public static string ConfigPath => Path.Combine(AppDataRoot, "appconfig.json");
    public static string ReplayMediaDirectory => Path.Combine(AppDataRoot, "media");
    public static string WebView2UserDataDir => Path.Combine(AppDataRoot, "WebView2");

    public static JudgeVideoReplayConfig Load()
    {
        if (!File.Exists(ConfigPath))
        {
            var config = Normalize(new JudgeVideoReplayConfig());
            Save(config);
            return config;
        }

        try
        {
            var json = File.ReadAllText(ConfigPath);
            return Normalize(JsonSerializer.Deserialize<JudgeVideoReplayConfig>(json, JsonOptions));
        }
        catch
        {
            return Normalize(new JudgeVideoReplayConfig());
        }
    }

    public static JudgeVideoReplayConfig Save(JudgeVideoReplayConfig? config)
    {
        config = Normalize(config);
        Directory.CreateDirectory(AppDataRoot);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonOptions));
        return config;
    }

    public static JudgeVideoReplayConfig Normalize(JudgeVideoReplayConfig? config)
    {
        config ??= new JudgeVideoReplayConfig();
        config.ServerIp = string.IsNullOrWhiteSpace(config.ServerIp)
            ? "127.0.0.1"
            : config.ServerIp.Trim();
        config.Language = string.Equals(config.Language?.Trim(), "fr", StringComparison.OrdinalIgnoreCase)
            ? "fr"
            : "en";
        config.UiZoomPercent = Math.Clamp(config.UiZoomPercent, MinUiZoomPercent, MaxUiZoomPercent);
        return config;
    }
}
