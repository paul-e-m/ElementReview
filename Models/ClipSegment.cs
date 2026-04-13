//ClipSegment.cs
namespace ElementReview.Models;

public class ClipSegment
{
    public int Index { get; set; }
    public double StartSeconds { get; set; }
    public double EndSeconds { get; set; }
    public bool EverMarkedForReview { get; set; } = false;
}
