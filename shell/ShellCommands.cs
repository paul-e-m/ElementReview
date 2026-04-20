namespace ElementReview.Shell;

public static class ShellCommands
{
    public static event Action? RestartRequested;

    public static bool RequestRestart()
    {
        var handler = RestartRequested;
        if (handler == null) return false;

        handler();
        return true;
    }
}
