param([int]$ProcessId, [ValidateSet('state','minimize','close')][string]$Action = 'state')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeWindowTest {
    delegate bool WindowVisitor(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    public static IntPtr Find(int processId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, state) => {
            uint pid; GetWindowThreadProcessId(handle, out pid);
            if (pid != processId || !IsWindowVisible(handle)) return true;
            var title = new StringBuilder(256); GetWindowText(handle, title, title.Capacity);
            if (title.ToString() == "CQU PCL") { found = handle; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool Minimized(IntPtr handle) { return handle != IntPtr.Zero && IsIconic(handle); }
    public static void Minimize(IntPtr handle) { if (handle != IntPtr.Zero) ShowWindow(handle, 6); }
    public static void Close(IntPtr handle) { if (handle != IntPtr.Zero) PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@
$taskHandle = [NativeWindowTest]::Find($ProcessId)
if ($Action -eq 'minimize') { [NativeWindowTest]::Minimize($taskHandle) }
if ($Action -eq 'close') { [NativeWindowTest]::Close($taskHandle) }
$taskProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
$taskChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | Where-Object Name -eq 'node.exe' | ForEach-Object ProcessId)
[PSCustomObject]@{ processId=$ProcessId; alive=($null -ne $taskProcess); window=($taskHandle -ne [IntPtr]::Zero); minimized=[NativeWindowTest]::Minimized($taskHandle); backendPids=$taskChildren } | ConvertTo-Json -Compress
