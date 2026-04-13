using ElementReview.Models;

//StatusDto.cs
namespace ElementReview.Models;

public class StatusDto
{
    public string Mode { get; set; } = "record"; // "record" or "replay"
    public bool IsArming { get; set; }
    public bool IsRecording { get; set; }

    // Only meaningful after stop (for replay scaling)
    public double? RecordingDurationSeconds { get; set; }

    public List<ClipSegment> Clips { get; set; } = new();
    public double? OpenClipStartSeconds { get; set; }
    public bool CanUndoClipAction { get; set; }
    public bool CanRedoClipAction { get; set; }

    public int SourceFps { get; set; } = 60;
}
