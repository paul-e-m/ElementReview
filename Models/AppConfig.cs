//AppConfig.cs
namespace ElementReview.Models;

public class AppConfig
{
    public int RecordingGop { get; set; } = 1;
    public string RtspUrl { get; set; } = "rtsp://192.168.6.200:8554/0";
    public bool DemoMode { get; set; } = false;
    public bool UseHardwareEncodingWhenAvailable { get; set; } = false;
    public int SourceFps { get; set; } = 60; // 30 or 60 typically
    public int ClipMarkerAdvanceMsec { get; set; } = 0;
    public bool SaveVideos { get; set; } = false;
    public string CSSLink { get; set; } = "None";
    public string EventId { get; set; } = "";
    public string DatabaseLocation { get; set; } = "192.168.6.50";
    public string CSSServerHost { get; set; } = "";
    public string SavedVideosFolder { get; set; } = global::ElementReview.AppPaths.DefaultSavedVideosFolder;
    public string Language { get; set; } = "en";
    public int UiZoomPercent { get; set; } = 90;
}
