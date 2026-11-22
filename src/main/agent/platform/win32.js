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

/**
 * The Core Audio endpoint declarations.
 *
 * Same placement argument as USER32_CSHARP above: get_volume and set_volume
 * paste this into a script, so it cannot live only in executor.js - a
 * platform module cannot reach into executor without the two importing
 * each other.
 */

const CORE_AUDIO_CSHARP = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int _0(); int _1(); int _2(); int _3();
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int _5();
  int GetMasterVolumeLevelScalar(out float level);
  // Slots 10-13 are the four channel methods. They are placeholders because
  // nothing here changes a single channel - but they must be counted, or
  // SetMute and GetMute land on GetChannelVolumeLevel and answer
  // E_INVALIDARG ("Value does not fall within the expected range").
  // Verified against the machine rather than the header: the header order
  // puts GetMasterVolumeLevelScalar at 11, where it fails, and at 9, where
  // every one of GetVolume, SetVolume, GetMute and SetMute works.
  int _8(); int _9(); int _10(); int _11();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int _0(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class Audio {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int GetVolume() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetVolume(int level) { var g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, level)) / 100f, ref g); }
  public static void SetMute(bool mute) { var g = Guid.Empty; Vol().SetMute(mute, ref g); }
}
`;

module.exports = { USER32_CSHARP, CORE_AUDIO_CSHARP };
