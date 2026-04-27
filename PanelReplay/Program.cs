using System.Windows.Forms;

namespace PanelReplay;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new PanelMainForm());
    }
}
