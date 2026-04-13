using Microsoft.AspNetCore.Builder;
using ElementReview.Hosting;
using ElementReview.Shell;
using System.Windows.Forms;

//Program.cs
namespace ElementReview;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        WebApplication app;

        try
        {
            app = AppServer.Build(args);
            app.StartAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Element Review could not start the local web server.\r\n\r\n" + ex.Message,
                "Element Review",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        try
        {
            Application.Run(new MainForm(app));
        }
        finally
        {
            try { app.StopAsync().GetAwaiter().GetResult(); } catch { }
            try { app.DisposeAsync().AsTask().GetAwaiter().GetResult(); } catch { }
        }
    }
}
