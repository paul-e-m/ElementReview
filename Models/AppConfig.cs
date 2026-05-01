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
    public string RtspTransportProtocol { get; set; } = "UDP";

    [JsonPropertyOrder(7)]
    public bool UseHardwareEncodingWhenAvailable { get; set; } = true;

    [JsonPropertyName("highresVideoGop")]
    [JsonPropertyOrder(8)]
    public int HighresVideoGop { get; set; } = 10;

    [JsonPropertyName("lowresVideoBitrate")]
    [JsonPropertyOrder(9)]
    public int LowresVideoBitrate { get; set; } = 2500;

    [JsonPropertyOrder(10)]
    [JsonPropertyName("lowresVideoGop")]
    public int LowresVideoGop { get; set; } = 60;

    [JsonPropertyOrder(11)]
    public string CSSLink { get; set; } = "Legacy";

    [JsonPropertyOrder(12)]
    public string DatabaseLocation { get; set; } = "localhost";

    [JsonPropertyOrder(13)]
    public string EventId { get; set; } = "";

    [JsonPropertyOrder(14)]
    public string CSSServerHost { get; set; } = "";

    [JsonPropertyOrder(15)]
    public bool SaveVideos { get; set; } = false;

    [JsonPropertyOrder(16)]
    public string SavedVideosFolder { get; set; } = "C:/Event_Videos";

    [JsonPropertyOrder(17)]
    public bool AutoplaySelectedClip { get; set; } = false;
}
