using System.Text.Json.Serialization;

namespace ElementReview.Models;

public class AppConfig
{
    [JsonPropertyOrder(0)]
    public string Language { get; set; } = "en";

    [JsonPropertyOrder(1)]
    public int UiZoomPercent { get; set; } = 90;

    [JsonPropertyOrder(2)]
    public int ClipMarkerAdvanceMsec { get; set; } = 500;

    [JsonPropertyOrder(3)]
    public bool DemoMode { get; set; } = true;

    [JsonPropertyOrder(4)]
    public string RtspUrl { get; set; } = "rtsp://192.168.6.200:8554/0";

    [JsonPropertyOrder(5)]
    public int SourceFps { get; set; } = 30;

    [JsonPropertyOrder(6)]
    public bool UseHardwareEncodingWhenAvailable { get; set; } = true;

    [JsonPropertyOrder(7)]
    public int RecordingGop { get; set; } = 10;

    [JsonPropertyOrder(8)]
    public string CSSLink { get; set; } = "Legacy";

    [JsonPropertyOrder(9)]
    public string DatabaseLocation { get; set; } = "localhost";

    [JsonPropertyOrder(10)]
    public string EventId { get; set; } = "";

    [JsonPropertyOrder(11)]
    public string CSSServerHost { get; set; } = "";

    [JsonPropertyOrder(12)]
    public bool SaveVideos { get; set; } = false;

    [JsonPropertyOrder(13)]
    public string SavedVideosFolder { get; set; } = "C:/Event_Videos";

    [JsonPropertyOrder(14)]
    public bool? HalfwayEnabled { get; set; } = true;
}
