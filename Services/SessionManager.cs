using System.Text.Json;
using ElementReview.Models;

//SessionManager.cs
namespace ElementReview.Services;

// Holds the in-memory session state that drives record mode, replay mode, and
// clip editing. It is the backend source of truth for clip timing and review
// history during a single competitor's session.
public class SessionManager
{
    private readonly object _lock = new();

    public string Mode { get; private set; } = "record";
    public bool IsArming { get; private set; } = false;
    public bool IsRecording { get; private set; } = false;

    public double? RecordingDurationSeconds { get; private set; }

    public List<ClipSegment> Clips { get; } = new();
    public double? OpenClipStartSeconds { get; private set; } = null;

    private readonly HashSet<int> _everReviewedIndices = new();
    private string? _savedMarkerJsonPath;

    // Undo support for record-mode clip start/stop actions.
    private enum ClipActionKind { Start, Stop }

    private sealed class ClipAction
    {
        public ClipActionKind Kind { get; init; }
        public double StartSeconds { get; init; }
        public ClipSegment? AddedClip { get; init; }
    }

    private readonly Stack<ClipAction> _history = new();
    private readonly Stack<ClipAction> _redoHistory = new();
    private const double MinClipLenSeconds = 0.05;
    private const double OverlapEps = 0.0005;

    // Recording and replay state transitions
    public void OnRecordingArming()
    {
        lock (_lock)
        {
            Mode = "record";
            IsArming = true;
            IsRecording = false;
            RecordingDurationSeconds = null;

            Clips.Clear();
            OpenClipStartSeconds = null;

            _history.Clear();
            _redoHistory.Clear();
            _everReviewedIndices.Clear();
            _savedMarkerJsonPath = null;
        }
    }

    public void OnRecordingStarted()
    {
        lock (_lock)
        {
            Mode = "record";
            IsArming = false;
            IsRecording = true;
            RecordingDurationSeconds = null;
        }
    }

    public void CancelRecordingStart()
    {
        lock (_lock)
        {
            Mode = "record";
            IsArming = false;
            IsRecording = false;
            RecordingDurationSeconds = null;

            Clips.Clear();
            OpenClipStartSeconds = null;

            _history.Clear();
            _redoHistory.Clear();
            _everReviewedIndices.Clear();
            _savedMarkerJsonPath = null;
        }
    }

    public void OnRecordingStopped(double durationSeconds, double? uiElapsedSeconds = null)
    {
        lock (_lock)
        {
            IsArming = false;
            IsRecording = false;
            RecordingDurationSeconds = durationSeconds;

            double ClampToRecording(double t) => Math.Clamp(t, 0.0, durationSeconds);

            for (int i = Clips.Count - 1; i >= 0; i--)
            {
                var c = Clips[i];
                var a = ClampToRecording(c.StartSeconds);
                var b = ClampToRecording(c.EndSeconds);

                if (b <= a + 0.03)
                {
                    Clips.RemoveAt(i);
                    continue;
                }

                c.StartSeconds = a;
                c.EndSeconds = b;
            }

            if (OpenClipStartSeconds.HasValue)
                OpenClipStartSeconds = ClampToRecording(OpenClipStartSeconds.Value);

            if (OpenClipStartSeconds.HasValue)
            {
                var start = OpenClipStartSeconds.Value;
                var end = durationSeconds;

                if (end > start + 0.05)
                {
                    Clips.Add(new ClipSegment
                    {
                        Index = Clips.Count + 1,
                        StartSeconds = start,
                        EndSeconds = end,
                        EverMarkedForReview = _everReviewedIndices.Contains(Clips.Count + 1)
                    });
                }

                OpenClipStartSeconds = null;
            }

            SortAndReindex_NoLock();

            foreach (var clip in Clips)
            {
                clip.EverMarkedForReview =
                    clip.EverMarkedForReview ||
                    _everReviewedIndices.Contains(clip.Index);
            }

            _history.Clear();
            _redoHistory.Clear();
            Mode = "replay";
        }
    }

    // Review flags are remembered so replay clips can stay marked even if the
    // SessionInfo payload changes between polls.
    public void UpdateReviewHistory(IReadOnlyDictionary<int, bool>? reviewFlags)
    {
        if (reviewFlags == null) return;

        lock (_lock)
        {
            foreach (var kvp in reviewFlags)
            {
                if (kvp.Key > 0 && kvp.Value)
                    _everReviewedIndices.Add(kvp.Key);
            }
        }
    }

    public void SetSavedMarkerJsonPath(string? markerJsonPath)
    {
        lock (_lock)
        {
            _savedMarkerJsonPath = string.IsNullOrWhiteSpace(markerJsonPath) ? null : markerJsonPath;
            PersistSavedClipMetadata_NoLock();
        }
    }

    public static Dictionary<int, bool> ExtractReviewFlagsFromElementsJson(string? json)
    {
        var result = new Dictionary<int, bool>();

        if (string.IsNullOrWhiteSpace(json))
            return result;

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (TryGetPropertyIgnoreCase(root, "elements", out var elementsRoot))
                root = elementsRoot;

            if (root.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in root.EnumerateArray())
                {
                    var idx = GetInt(item, "index", "Index", "id", "Id");
                    if (idx < 1) continue;

                    result[idx] = GetBool(item, "review", "Review", "reviewed", "Reviewed");
                }

                return result;
            }

            if (root.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in root.EnumerateObject())
                {
                    if (!int.TryParse(prop.Name, out var idx) || idx < 1) continue;

                    result[idx] = GetBool(prop.Value, "review", "Review", "reviewed", "Reviewed");
                }
            }
        }
        catch
        {
            // ignore malformed JSON
        }

        return result;
    }

    // Record-mode clip marking and undo
    public void ToggleClipMarker(double nowSeconds)
    {
        lock (_lock)
        {
            if (!IsRecording) return;

            if (!OpenClipStartSeconds.HasValue)
            {
                OpenClipStartSeconds = nowSeconds;
                _redoHistory.Clear();
                _history.Push(new ClipAction
                {
                    Kind = ClipActionKind.Start,
                    StartSeconds = nowSeconds,
                    AddedClip = null
                });
                return;
            }

            var start = OpenClipStartSeconds.Value;
            var end = nowSeconds;

            ClipSegment? added = null;

            if (end > start + 0.05)
            {
                var nextIndex = Clips.Count + 1;

                added = new ClipSegment
                {
                    Index = nextIndex,
                    StartSeconds = start,
                    EndSeconds = end,
                    EverMarkedForReview = _everReviewedIndices.Contains(nextIndex)
                };
                Clips.Add(added);
            }

            OpenClipStartSeconds = null;

            _redoHistory.Clear();
            _history.Push(new ClipAction
            {
                Kind = ClipActionKind.Stop,
                StartSeconds = start,
                AddedClip = added
            });
        }
    }

    public void UndoLastClipAction()
    {
        lock (_lock)
        {
            if (!IsRecording) return;
            if (_history.Count == 0) return;

            var last = _history.Pop();

            if (last.Kind == ClipActionKind.Start)
            {
                OpenClipStartSeconds = null;
                _redoHistory.Push(last);
                return;
            }

            if (last.AddedClip != null && Clips.Count > 0)
            {
                var tail = Clips[^1];
                if (tail.Index == last.AddedClip.Index &&
                    NearlyEqual(tail.StartSeconds, last.AddedClip.StartSeconds) &&
                    NearlyEqual(tail.EndSeconds, last.AddedClip.EndSeconds))
                {
                    Clips.RemoveAt(Clips.Count - 1);
                }
                else
                {
                    var idx = Clips.FindIndex(c =>
                        c.Index == last.AddedClip.Index &&
                        NearlyEqual(c.StartSeconds, last.AddedClip.StartSeconds) &&
                        NearlyEqual(c.EndSeconds, last.AddedClip.EndSeconds));

                    if (idx >= 0) Clips.RemoveAt(idx);
                }
            }

            OpenClipStartSeconds = last.StartSeconds;
            _redoHistory.Push(last);
        }
    }

    public void RedoLastClipAction()
    {
        lock (_lock)
        {
            if (!IsRecording) return;
            if (_redoHistory.Count == 0) return;

            var next = _redoHistory.Pop();

            if (next.Kind == ClipActionKind.Start)
            {
                OpenClipStartSeconds = next.StartSeconds;
                _history.Push(next);
                return;
            }

            OpenClipStartSeconds = null;

            if (next.AddedClip != null)
            {
                var existing = Clips.Any(c =>
                    NearlyEqual(c.StartSeconds, next.AddedClip.StartSeconds) &&
                    NearlyEqual(c.EndSeconds, next.AddedClip.EndSeconds));

                if (!existing)
                {
                    Clips.Add(new ClipSegment
                    {
                        Index = next.AddedClip.Index,
                        StartSeconds = next.AddedClip.StartSeconds,
                        EndSeconds = next.AddedClip.EndSeconds,
                        EverMarkedForReview = next.AddedClip.EverMarkedForReview
                    });
                    SortAndReindex_NoLock();
                }
            }

            _history.Push(next);
        }
    }

    // Replay-mode clip editing
    public void DeleteClip(int index)
    {
        lock (_lock)
        {
            if (!IsReplayReady_NoLock()) return;

            var i = Clips.FindIndex(c => c.Index == index);
            if (i < 0) return;

            Clips.RemoveAt(i);
            SortAndReindex_NoLock();
            PersistSavedClipMetadata_NoLock();
        }
    }

    public void DeleteClipWhileRecording(int index)
    {
        lock (_lock)
        {
            if (IsArming) return;
            if (!IsRecording) return;
            if (!string.Equals(Mode, "record", StringComparison.OrdinalIgnoreCase)) return;

            var i = Clips.FindIndex(c => c.Index == index);
            if (i < 0) return;

            Clips.RemoveAt(i);
            SortAndReindex_NoLock();

            if (_everReviewedIndices.Count > 0)
            {
                var shifted = new HashSet<int>();
                foreach (var reviewedIndex in _everReviewedIndices)
                {
                    if (reviewedIndex < index) shifted.Add(reviewedIndex);
                    else if (reviewedIndex > index) shifted.Add(reviewedIndex - 1);
                }

                _everReviewedIndices.Clear();
                foreach (var shiftedIndex in shifted)
                    _everReviewedIndices.Add(shiftedIndex);
            }

            // Deleting a completed clip changes the visible clip order, so the
            // record-mode undo stacks are no longer safe to replay.
            _history.Clear();
            _redoHistory.Clear();
        }
    }

    public void SplitClip(int index, double splitSeconds)
    {
        lock (_lock)
        {
            if (!IsReplayReady_NoLock()) return;

            var c = Clips.FirstOrDefault(x => x.Index == index);
            if (c == null) return;

            var a = c.StartSeconds;
            var b = c.EndSeconds;

            if (!(splitSeconds > a + MinClipLenSeconds && splitSeconds < b - MinClipLenSeconds))
                return;

            Clips.Remove(c);

            Clips.Add(new ClipSegment
            {
                Index = 0,
                StartSeconds = a,
                EndSeconds = splitSeconds,
                EverMarkedForReview = c.EverMarkedForReview
            });

            Clips.Add(new ClipSegment
            {
                Index = 0,
                StartSeconds = splitSeconds,
                EndSeconds = b,
                EverMarkedForReview = c.EverMarkedForReview
            });

            SortAndReindex_NoLock();
            PersistSavedClipMetadata_NoLock();
        }
    }

    public void TrimIn(int index, double newStartSeconds)
    {
        lock (_lock)
        {
            if (!IsReplayReady_NoLock()) return;

            var c = Clips.FirstOrDefault(x => x.Index == index);
            if (c == null) return;

            var a = c.StartSeconds;
            var b = c.EndSeconds;

            if (!(newStartSeconds < b - MinClipLenSeconds))
                return;

            if (WouldOverlap_NoLock(newStartSeconds, b, ignoreIndex: c.Index))
                return;

            c.StartSeconds = newStartSeconds;

            SortAndReindex_NoLock();
            PersistSavedClipMetadata_NoLock();
        }
    }

    public void TrimOut(int index, double newEndSeconds)
    {
        lock (_lock)
        {
            if (!IsReplayReady_NoLock()) return;

            var c = Clips.FirstOrDefault(x => x.Index == index);
            if (c == null) return;

            var a = c.StartSeconds;
            var b = c.EndSeconds;

            if (!(newEndSeconds > a + MinClipLenSeconds))
                return;

            if (WouldOverlap_NoLock(a, newEndSeconds, ignoreIndex: c.Index))
                return;

            c.EndSeconds = newEndSeconds;

            SortAndReindex_NoLock();
            PersistSavedClipMetadata_NoLock();
        }
    }

    public void InsertClip(double startSeconds, double endSeconds)
    {
        lock (_lock)
        {
            if (!IsReplayReady_NoLock()) return;

            if (!double.IsFinite(startSeconds) || !double.IsFinite(endSeconds)) return;
            if (endSeconds <= startSeconds + MinClipLenSeconds) return;

            if (RecordingDurationSeconds.HasValue && RecordingDurationSeconds.Value > 0.01)
            {
                var dur = RecordingDurationSeconds.Value;
                if (startSeconds < 0 || endSeconds > dur + 1e-6) return;
            }

            if (WouldOverlap_NoLock(startSeconds, endSeconds, ignoreIndex: null))
                return;

            Clips.Add(new ClipSegment
            {
                Index = 0,
                StartSeconds = startSeconds,
                EndSeconds = endSeconds,
                EverMarkedForReview = false
            });

            SortAndReindex_NoLock();
            PersistSavedClipMetadata_NoLock();
        }
    }

    // Internal validation and persistence helpers
    private bool IsReplayReady_NoLock()
    {
        if (IsArming) return false;
        if (IsRecording) return false;
        if (!string.Equals(Mode, "replay", StringComparison.OrdinalIgnoreCase)) return false;
        if (OpenClipStartSeconds.HasValue) return false;
        return true;
    }

    private bool WouldOverlap_NoLock(double start, double end, int? ignoreIndex)
    {
        foreach (var c in Clips)
        {
            if (ignoreIndex.HasValue && c.Index == ignoreIndex.Value) continue;

            var a = c.StartSeconds;
            var b = c.EndSeconds;

            if (b <= a) continue;

            if (start < b - OverlapEps && end > a + OverlapEps)
                return true;
        }
        return false;
    }

    private void SortAndReindex_NoLock()
    {
        Clips.Sort((x, y) => x.StartSeconds.CompareTo(y.StartSeconds));
        for (int i = 0; i < Clips.Count; i++)
            Clips[i].Index = i + 1;
    }

    public void ClearAll()
    {
        lock (_lock)
        {
            Mode = "record";
            IsArming = false;
            IsRecording = false;
            RecordingDurationSeconds = null;
            Clips.Clear();
            OpenClipStartSeconds = null;

            _history.Clear();
            _redoHistory.Clear();
            _everReviewedIndices.Clear();
            _savedMarkerJsonPath = null;
        }
    }

    public StatusDto GetStatus(int sourceFps)
    {
        lock (_lock)
        {
            return new StatusDto
            {
                Mode = Mode,
                IsArming = IsArming,
                IsRecording = IsRecording,
                RecordingDurationSeconds = RecordingDurationSeconds,
                SourceFps = sourceFps,
                CanUndoClipAction = IsRecording && _history.Count > 0,
                CanRedoClipAction = IsRecording && _redoHistory.Count > 0,
                Clips = Clips.Select(c => new ClipSegment
                {
                    Index = c.Index,
                    StartSeconds = c.StartSeconds,
                    EndSeconds = c.EndSeconds,
                    EverMarkedForReview = c.EverMarkedForReview
                }).ToList(),
                OpenClipStartSeconds = OpenClipStartSeconds
            };
        }
    }

    private void PersistSavedClipMetadata_NoLock()
    {
        if (string.IsNullOrWhiteSpace(_savedMarkerJsonPath)) return;

        try
        {
            var dir = Path.GetDirectoryName(_savedMarkerJsonPath);
            if (!string.IsNullOrWhiteSpace(dir))
                Directory.CreateDirectory(dir);

            var payload = new
            {
                clips = Clips.Select(c => new
                {
                    elementNumber = c.Index,
                    everMarkedForReview = c.EverMarkedForReview,
                    startSeconds = RoundToTenths(c.StartSeconds),
                    endSeconds = RoundToTenths(c.EndSeconds)
                }).ToList()
            };

            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                WriteIndented = true
            });

            File.WriteAllText(_savedMarkerJsonPath, json);
        }
        catch
        {
            // ignore marker export failures
        }
    }

    private static double RoundToTenths(double value)
        => Math.Round(Math.Max(0, value), 1, MidpointRounding.AwayFromZero);

    private static bool TryGetPropertyIgnoreCase(JsonElement element, string name, out JsonElement value)
    {
        value = default;

        if (element.ValueKind != JsonValueKind.Object)
            return false;

        foreach (var prop in element.EnumerateObject())
        {
            if (prop.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                value = prop.Value;
                return true;
            }
        }

        return false;
    }

    private static int GetInt(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!TryGetPropertyIgnoreCase(element, name, out var value))
                continue;

            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n))
                return n;

            if (value.ValueKind == JsonValueKind.String &&
                int.TryParse(value.GetString(), out n))
                return n;
        }

        return 0;
    }

    private static bool GetBool(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!TryGetPropertyIgnoreCase(element, name, out var value))
                continue;

            if (value.ValueKind == JsonValueKind.True) return true;
            if (value.ValueKind == JsonValueKind.False) return false;

            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n))
                return n != 0;

            if (value.ValueKind == JsonValueKind.String)
            {
                var s = value.GetString();
                if (bool.TryParse(s, out var b)) return b;
                if (int.TryParse(s, out n)) return n != 0;
            }
        }

        return false;
    }

    private static bool NearlyEqual(double a, double b) => Math.Abs(a - b) < 1e-6;
}
