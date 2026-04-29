namespace ElementReview.Models;

public sealed class JudgeVideoReplayConfig
{
    public string ServerIp { get; set; } = "127.0.0.1";
    public bool TimerEnabled { get; set; } = true;
    public string Language { get; set; } = "en";
    public int UiZoomPercent { get; set; } = 100;
}
