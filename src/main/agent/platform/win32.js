'use strict';

/**
 * The user32 declarations, in the same C# block they have always been.
 *
 * It lives here rather than in windows.js because both sides want it:
 * platform/windows.js takes it for focus_window, and executor.js still has
 * the mouse and settings scripts that have not moved across. Putting it in
 * windows.js would have left executor importing a platform symbol that is
 * simply absent on Linux - which reads as success until the string is
 * pasted into a script.
 */
const USER32_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800, MOVE = 0x0001, ABSOLUTE = 0x8000;
}
`;

module.exports = { USER32_CSHARP };
