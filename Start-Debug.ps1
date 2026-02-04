
param([string]$TargetExe, [string]$PidFile)
$ErrorActionPreference = "Stop"

$Source = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;

public class Launcher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", EntryPoint="CreateProcessW", SetLastError=true, CharSet=CharSet.Unicode)]
    internal static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr hObject);

    // 封装启动逻辑
    public static void StartSuspended(string exePath, out int pid, out IntPtr hProcess, out IntPtr hThread) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        StringBuilder cmdLine = new StringBuilder();
        cmdLine.Append("\"");
        cmdLine.Append(exePath);
        cmdLine.Append("\"");

        // CREATE_SUSPENDED = 0x00000004
        bool success = CreateProcess(
            null, 
            cmdLine, 
            IntPtr.Zero, 
            IntPtr.Zero, 
            true, 
            0x00000004, 
            IntPtr.Zero, 
            null, 
            ref si, 
            out pi);

        if (!success) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        pid = pi.dwProcessId;
        hProcess = pi.hProcess;
        hThread = pi.hThread;
    }

    // 【关键修复】封装等待逻辑，避免 PowerShell 处理 UInt32 类型转换溢出
    public static void WaitToExit(IntPtr hProcess) {
        // 0xFFFFFFFF 在 C# 中是无符号整数最大值，代表 INFINITE
        WaitForSingleObject(hProcess, 0xFFFFFFFF);
    }
}
"@

try {
    Add-Type -TypeDefinition $Source -ErrorAction Stop
} catch {
    # 忽略类型已存在错误
}

Write-Host "[PS] Launching Suspended: $TargetExe"

$pidVal = 0
$hProcess = [IntPtr]::Zero
$hThread = [IntPtr]::Zero

try {
    # 1. 启动
    [Launcher]::StartSuspended($TargetExe, [ref]$pidVal, [ref]$hProcess, [ref]$hThread)

    Write-Host "[PS] Process Created. PID: $pidVal"
    
    # 2. 写入 PID
    [System.IO.File]::WriteAllText($PidFile, $pidVal.ToString())

    Write-Host "[PS] Target is suspended. Waiting for debugger..."
    
    # 3. 等待 (调用新封装的无参方法)
    # 这样 PowerShell 不需要处理 0xFFFFFFFF 这个数字，就不会报错了
    [Launcher]::WaitToExit($hProcess)
    
    Write-Host "[PS] Process Exited."
}
catch {
    Write-Error "Launch Failed: $($_.Exception.ToString())"
    exit 1
}
finally {
    if ($hProcess -ne [IntPtr]::Zero) { [Launcher]::CloseHandle($hProcess) | Out-Null }
    if ($hThread -ne [IntPtr]::Zero)  { [Launcher]::CloseHandle($hThread) | Out-Null }
}
