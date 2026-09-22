using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace Nexos.WindowsControl;

/// <summary>
/// Nexos não roda dentro do Electron (o daemon é um processo Node puro, sem
/// `desktopCapturer`), então a captura tem que vir do próprio helper — via
/// `PrintWindow` com `PW_RENDERFULLCONTENT`, que também pega conteúdo
/// renderizado por GPU/DirectComposition (BitBlt simples não pegaria).
/// </summary>
internal static class WindowCapture
{
    internal static (string DataBase64, int Width, int Height) Capture(nint hwnd)
    {
        if (!NativeMethods.GetWindowRect(hwnd, out var rect))
            throw new InvalidOperationException("Não foi possível medir a janela.");
        var width = rect.Width;
        var height = rect.Height;
        if (width <= 0 || height <= 0 || width > 10_000 || height > 10_000)
            throw new InvalidOperationException("A janela tem tamanho inválido pra captura.");

        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        var hdc = graphics.GetHdc();
        try
        {
            if (!NativeMethods.PrintWindow(hwnd, hdc, NativeMethods.PW_RENDERFULLCONTENT))
                throw new InvalidOperationException("PrintWindow falhou pra essa janela.");
        }
        finally
        {
            graphics.ReleaseHdc(hdc);
        }

        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return (Convert.ToBase64String(stream.ToArray()), width, height);
    }
}
