using System.Windows.Forms;

namespace JudgeVideoReplay;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new JudgeVideoReplayMainForm());
    }
}
