param(
  [string]$Out = "C:\Users\name\AppData\Local\Temp\opencode\shot.png",
  [string]$TitleLike = ""
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($TitleLike) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Focus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
  $sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Finder {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
  Add-Type -TypeDefinition $sig
  $h = [Finder]::Find($TitleLike)
  if ($h -ne [IntPtr]::Zero) {
    [void][Focus]::ShowWindow($h, 9)
    Start-Sleep -Milliseconds 150
    [void][Focus]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 600
  } else {
    Write-Output "window matching '$TitleLike' not found"
  }
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Out ($($bounds.Width)x$($bounds.Height))"