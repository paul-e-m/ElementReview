using System.Drawing;
using System.Windows.Forms;

namespace ElementReview.Shell;

internal static class AppWindowIcon
{
    public static Icon? Extract()
    {
        try
        {
            var exePath = Application.ExecutablePath;
            return string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath)
                ? null
                : Icon.ExtractAssociatedIcon(exePath);
        }
        catch
        {
            return null;
        }
    }
}
