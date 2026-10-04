// OpenTime's address-bar reader for Windows.
//
// Built by scripts/build-address-helper.mjs with the C# compiler that ships
// with Windows, and run by src/main/capture/addressBar.ts. For every line on
// stdin it finds the foreground window, asks UI Automation for the first edit
// box in it (the address bar comes first in every major browser), and prints
// one line: the window title, a tab, and the box's text. It reads nothing
// else, writes nothing, and opens no network connection.
//
// A compiled helper rather than a PowerShell script: it starts in a fraction
// of the time and uses a fraction of the memory.

using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

static class AddressHelper
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    static readonly Condition EditBox =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);

    static string Flat(string s)
    {
        return (s ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
    }

    static void Main()
    {
        var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        while (Console.In.ReadLine() != null)
        {
            string title = "";
            string value = "";
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                var text = new StringBuilder(1024);
                GetWindowText(hwnd, text, 1024);
                title = text.ToString();
                var root = AutomationElement.FromHandle(hwnd);
                var box = root.FindFirst(TreeScope.Descendants, EditBox);
                object pattern;
                if (box != null && box.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    value = ((ValuePattern)pattern).Current.Value;
                }
            }
            catch (Exception)
            {
                // A window that refuses UI Automation simply has no address.
            }
            stdout.WriteLine(Flat(title) + "\t" + Flat(value));
        }
    }
}
