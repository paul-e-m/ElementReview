using ElementReview.Models;

namespace ElementReview.Models;

public class StatusDto
{
    public string Mode { get; set; } = "record";
    public bool IsArming { get; set; }
    public bool IsRecording { get; set; }

    // Filled after recording stops so replay clients know the full recording length.
    public double? RecordingDurationSeconds { get; set; }

    public List<ClipSegment> Clips { get; set; } = new();
    public double? OpenClipStartSeconds { get; set; }
    public bool CanUndoClipAction { get; set; }
    public bool CanRedoClipAction { get; set; }

    public int SourceFps { get; set; } = 60;
}
