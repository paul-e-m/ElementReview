using System.Text.Json;

namespace PanelReplay;

internal static class PanelConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    public static string AppDataRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "PanelReview");

    public static string ConfigPath => Path.Combine(AppDataRoot, "panelConfig.json");
    public static string ReplayMediaDirectory => Path.Combine(AppDataRoot, "media");
    public static string WebView2UserDataDir => Path.Combine(AppDataRoot, "WebView2");

    public static PanelConfig Load()
    {
        if (!File.Exists(ConfigPath))
        {
            var config = Normalize(new PanelConfig());
            Save(config);
            return config;
        }

        try
        {
            var json = File.ReadAllText(ConfigPath);
            return Normalize(JsonSerializer.Deserialize<PanelConfig>(json, JsonOptions));
        }
        catch
        {
            return Normalize(new PanelConfig());
        }
    }

    public static PanelConfig Save(PanelConfig? config)
    {
        config = Normalize(config);
        Directory.CreateDirectory(AppDataRoot);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonOptions));
        return config;
    }

    public static PanelConfig Normalize(PanelConfig? config)
    {
        config ??= new PanelConfig();
        config.ServerIp = string.IsNullOrWhiteSpace(config.ServerIp)
            ? "127.0.0.1"
            : config.ServerIp.Trim();
        config.Language = string.Equals(config.Language?.Trim(), "fr", StringComparison.OrdinalIgnoreCase)
            ? "fr"
            : "en";
        return config;
    }
}
