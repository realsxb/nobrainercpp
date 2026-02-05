import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

// 引入 setExtensionPath
import { getFastestToolchain, ToolchainResult, setExtensionPath } from './toolchainFinder'; 

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ensureVscodeDir(workspaceFolder: vscode.WorkspaceFolder): string {
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    return vscodeDir;
}
// --- 辅助函数：获取关键路径 ---
function getEmbeddedPaths(extensionPath: string) {
    const root = path.join(extensionPath, 'lldbv1.0');
    
    // 1. Sysroot: 指向 x86_64-w64-mingw32
    // 编译器会自动去 sysroot/include 找头文件，去 sysroot/lib 找库
    const sysRoot = path.join(root, 'x86_64-w64-mingw32');
    
    // 2. 编译器内置资源目录 (stddef.h 等)
    // 注意：这里的 '21' 是版本号，如果未来升级了 clang，这个数字会变
    // 建议代码里动态读一下，或者你手动维护这个数字
    const resourceDir = path.join(root, 'lib', 'clang', '21', 'include');

    return { sysRoot, resourceDir };
}
// --- 生成 Tasks 配置 (适配嵌入式参数) ---

function generateTasksConfig(toolchain: ToolchainResult, extensionPath: string): string {
    const tasks = [];
    
    // --- 1. 准备内嵌工具链的特殊参数 ---
    let embeddedArgs: string[] = [];

    if (toolchain.toolchain === 'embedded') {
        // 根目录：.../lldbv1.0
        const rootDir = path.join(extensionPath, 'lldbv1.0');
        
        // Sysroot：根据你的目录结构，真正的头文件和库在 x86_64-w64-mingw32 子目录下
        // 编译器会在 sysRoot/include 和 sysRoot/lib 中查找
        const sysRootPath = path.join(rootDir, 'x86_64-w64-mingw32');
        
        // 路径规范化：将 Windows 的反斜杠 \ 替换为 /，防止被编译器误读为转义符
        const sysRootArg = sysRootPath.replace(/\\/g, '/');

        embeddedArgs = [
            "-target", "x86_64-w64-mingw32",
            "--sysroot", sysRootArg,
            "-Wno-unused-command-line-argument",
            "-stdlib=libc++",       // 使用 LLVM libc++
            "-lunwind",             // 使用 LLVM libunwind
            "--rtlib=compiler-rt",  // 使用 compiler-rt 替代 libgcc
            "-fuse-ld=lld"          // 强制使用 LLD 链接器
        ];
    }

    // --- 2. 构建通用参数模板 ---
    // 这是 C 和 C++ 共用的基础参数（输入文件、输出文件、调试信息等）
    const getCommonArgs = () => [
        "-fdiagnostics-color=always",
        "-g", // 生成调试信息
        "${file}",
        "-o",
        "${fileDirname}/${fileBasenameNoExtension}.exe"
    ];

    // --- 3. 生成 C 编译任务 ---
    if (toolchain.compilers.c) {
        // 如果是内嵌模式，把 embeddedArgs 放到最前面；否则只用通用参数
        const args = toolchain.toolchain === 'embedded' 
            ? [...embeddedArgs, ...getCommonArgs()] 
            : getCommonArgs();

        tasks.push({
            type: "shell",
            label: "Build C",
            command: toolchain.compilers.c, // 这里的路径已经是绝对路径了
            args: args,
            options: { cwd: "${fileDirname}" },
            problemMatcher: ["$gcc"],
            group: { kind: "build", isDefault: true },
            detail: toolchain.toolchain === 'embedded' 
                ? "使用内置 Micro-Clang 编译" 
                : `使用编译器: ${toolchain.compilers.c}`
        });
    }

    // --- 4. 生成 C++ 编译任务 ---
    if (toolchain.compilers.cpp) {
        const args = toolchain.toolchain === 'embedded' 
            ? [...embeddedArgs, ...getCommonArgs()] 
            : getCommonArgs();

        tasks.push({
            type: "shell",
            label: "Build C++",
            command: toolchain.compilers.cpp,
            args: args,
            options: { cwd: "${fileDirname}" },
            problemMatcher: ["$gcc"],
            group: "build",
            detail: toolchain.toolchain === 'embedded' 
                ? "使用内置 Micro-Clang++ 编译" 
                : `使用编译器: ${toolchain.compilers.cpp}`
        });
    }

    // --- 5. 返回 JSON 字符串 ---
    return getBrandHeader() + JSON.stringify({ version: "2.0.0", tasks }, null, 4);;
}

// --- 生成 Launch 配置 (适配自定义调试器) ---

function generateLaunchConfig(toolchain: ToolchainResult, hasMsExtension: boolean): string {
    const isEmbedded = toolchain.toolchain === 'embedded';
    const useCppDbg = !isEmbedded && hasMsExtension;
    
    // 如果是用微软插件，用 cppdbg；如果是内嵌，用我们自定义的 type
    const debugType = useCppDbg ? "cppdbg" : "my-simple-lldb";

    const createConfig = (name: string, preLaunchTask: string) => {
        // --- 1. 微软插件 (System) 的配置 ---
        // 保持原样，完全不动它
        if (useCppDbg) {
            const dbgPath = toolchain.debugger || "gdb";
            const isLLDB = dbgPath.toLowerCase().includes("lldb");
            
            return {
                name: name,
                type: "cppdbg",
                request: "launch",
                program: "${fileDirname}/${fileBasenameNoExtension}.exe",
                cwd: "${workspaceFolder}",
                stopAtEntry: false,
                preLaunchTask: preLaunchTask, // 让 VS Code 处理编译
                MIMode: isLLDB ? "lldb" : "gdb",
                miDebuggerPath: dbgPath,
                setupCommands: [
                    { 
                        description: "Enable pretty-printing", 
                        text: "-enable-pretty-printing", 
                        ignoreFailures: true 
                    }
                ]
            };
        } 
        
        // --- 2. 内嵌调试器 (Embedded/Wrapper) 的配置 ---
        // 我们生成一个“占位符”配置。
        // 用户按 F5 时，VS Code 会读取这个配置，然后被我们在 extension.ts 里拦截
        else {
            return {
                name: name,
                type: "my-simple-lldb", // 关键：这会触发我们注册的 Provider
                request: "launch",
                // 这里的 program 和 preLaunchTask 主要用于 UI 显示
                // 实际逻辑我们会接管
                program: "${fileDirname}/${fileBasenameNoExtension}.exe",
                preLaunchTask: preLaunchTask 
            };
        }
    };

    const configs = [
        createConfig("Debug C", "Build C"),
        createConfig("Debug C++", "Build C++")
    ];

    return getBrandHeader() + JSON.stringify({ version: "0.2.0", configurations: configs }, null, 4);
}
// 生成拦截配置
// src/extension.ts 中的辅助函数

async function startDebuggingWithWrapper(targetExe: string, targetCwd: string, extensionPath: string) {
// 直接使用传入的路径，稳准狠，F5调试也不会错
    const wrapperPath = path.join(extensionPath, 'launcher.exe'); 
    
    console.log("正在尝试启动 Wrapper:", wrapperPath); // 方便你调试看路径对不对
    return new Promise<void>((resolve, reject) => {
        const p = cp.spawn(wrapperPath, [targetExe], { cwd: targetCwd });
        
        let started = false;

        p.stdout.on('data', async (chunk) => {
            const str = chunk.toString();
            // 解析 Wrapper 输出的 PID，例如 "@@PID:1234@@"
            const match = str.match(/@@PID:(\d+)@@/);
            
            if (match && !started) {
                started = true;
                const pid = parseInt(match[1]);

                // 构造一个新的 Attach 配置
                const attachConfig: vscode.DebugConfiguration = {
                    name: "Nobrainer Attach",
                    type: "my-simple-lldb", // 这里注意：必须是你 package.json 里定义的那个调试器类型
                    request: "attach",
                    pid: pid,
                    // 【修改 1】关闭默认的入口暂停，防止停在 ntdll 汇编里
                    stopOnEntry: false, 

                    // 2. 【关键修改】不要用 initCommands，改用 preRunCommands
                    // 这些命令会在 Attach 成功后、程序恢复运行前执行
                    postRunCommands: [
                        // 此时 Target 已经创建了，断点能直接打上
                        // "breakpoint set --name main", 
                        
                        // 此时进程已连接，continue 命令有效
                        // 这会让程序从 Suspended 状态恢复，直到撞上 main 断点
                    ]
                };

                // 发起真正的调试会话
                // parentSession 设置为 undefined，表示这是一个新的独立会话
                const success = await vscode.debug.startDebugging(undefined, attachConfig);
                if (success) {
                    resolve();
                } else {
                    reject(new Error("Attach failed"));
                }
            }
        });

        p.on('error', (err) => reject(err));
        
        // 如果 Wrapper 意外退出
        p.on('close', (code) => {
            if (!started) {reject(new Error(`Launcher exited with code ${code}`));}
        });
    });
}
// --- 生成 c_cpp_properties.json 配置 (解决报红问题) ---

function generatePropertiesConfig(toolchain: ToolchainResult, extensionPath: string): string {
    const isEmbedded = toolchain.toolchain === 'embedded';
    
    let compilerPath = toolchain.compilers.cpp || toolchain.compilers.c || "";
    let intelliSenseMode = "windows-gcc-x64";
    let compilerArgs: string[] = [];
    let includePath: string[] = ["${workspaceFolder}/**"];

    if (isEmbedded) {
        intelliSenseMode = "windows-clang-x64";
        const { sysRoot, resourceDir } = getEmbeddedPaths(extensionPath);
        const sysRootArg = sysRoot.replace(/\\/g, '/');
        const resourceDirArg = resourceDir.replace(/\\/g, '/');

        // 1. 告诉 IntelliSense 编译参数
        compilerArgs = [
            "-target", "x86_64-w64-mingw32",
            "--sysroot", sysRootArg,
            "-stdlib=libc++",
            "-lunwind",
            "--rtlib=compiler-rt"
        ];

        // 2. 显式添加头文件搜索路径 (双重保险)
        // 这里的顺序很重要：
        // A. C++ 标准库 (libc++)
        includePath.push(`${sysRootArg}/include/c++/v1`); 
        // B. 编译器内置头文件 (stddef.h) - 解决“搜索列表中没有目录”的关键
        includePath.push(`${resourceDirArg}`);
        // C. MinGW 系统头文件 (stdio.h, windows.h)
        includePath.push(`${sysRootArg}/include`);

    } else if (toolchain.toolchain === 'msvc') {
        intelliSenseMode = "windows-msvc-x64";
    }

    const config = {
        configurations: [
            {
                name: "Win32",
                includePath: includePath, // 使用我们增强后的路径列表
                defines: ["_DEBUG", "UNICODE", "_UNICODE"],
                compilerPath: compilerPath,
                cStandard: "c17",
                cppStandard: "c++17",
                intelliSenseMode: intelliSenseMode,
                compilerArgs: compilerArgs
            }
        ],
        version: 4
    };

    return JSON.stringify(config, null, 4);
}
// src/extension.ts

function getBrandHeader(): string {
    return [
        "/**",
        " * ------------------------------------------------------------------",
        " * Generated by NoBrainerCpp",
        " * Author: RealSXB(Nebulazeyv)",
        " * Github开源地址: https://github.com/realsxb/nobrainercpp",
        " * 问题反馈邮箱nebulazeyv@nebulazeyv.com,23182625@buaa.edu.cn欢迎沟通",
        " * 作者受够了自己配置vscode的c/cpp环境",
        " * 决心写一个插件一键生成配置文件实现一劳永逸",
        " * 本插件优先搜索PATH路径中已安装的工具链,如果缺失会使用内嵌工具链",
        " * 完全0依赖,即插即用,你甚至可以在裸vscode上使用此插件来编译c/cpp!",
        " * 希望能帮到尽可能多的BUAAer!",
        " * ------------------------------------------------------------------",
        " */",
        "" // 空一行
    ].join('\n');
}
function showWelcomeMessage() {
    const logo = `
  _   _       ____            _                  
 | \\ | | ___ | __ ) _ __ __ _(_)_ __   ___ _ __  
 |  \\| |/ _ \\|  _ \\| '__/ _\` | | '_ \\ / _ \\ '__| 
 | |\\  | (_) | |_) | | | (_| | | | | |  __/ |    
 |_| \\_|\\___/|____/|_|  \\__,_|_|_| |_|\\___|_|    
                                          
    
    >>> NoBrainerCpp v1.4.1 by RealSXB(Nebulazeyv) <<<
    >>> 用法->
    >>> 只需点击右上角左箭头「<-」即可开始调试c/cpp无需任何手动配置
    >>> 内嵌调试器使用方法：请按调试工具栏上的 绿色三角 ▶ (继续/F5) 按钮来进行断点间跳跃，
    >>> 内嵌调试器注意：在第一个断点前或最后一个断点后按「步过」会进入汇编文件，继续按 绿色三角 ▶ (继续/F5) 可跳出
    `;
    
    // 创建一个输出通道
    const outputChannel = vscode.window.createOutputChannel("NoBrainerCpp");
    outputChannel.show(true); // true 表示不抢占焦点，但在后台显示
    outputChannel.appendLine(logo);
    outputChannel.appendLine("配置 C/C++ 环境完毕");
}
// --- 核心逻辑 ---

async function setupDebugEnvironment(context: vscode.ExtensionContext, isCpp: boolean) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("请先打开一个文件夹工作区！");
        return;
    }
    showWelcomeMessage();
    vscode.window.setStatusBarMessage("NoBrainerCpp: 正在搜索编译器...", 3000);
    
    // 1. 获取最快可用的工具链
    const toolchain = await getFastestToolchain();

    // 2. 检查结果
    const compiler = isCpp ? toolchain.compilers.cpp : toolchain.compilers.c;
    if (!compiler) {
        vscode.window.showErrorMessage(
            `未找到编译器！请安装 MinGW/Clang，或者检查插件内置工具链是否完整。`
        );
        return;
    }



    // ================== 新增：检测微软扩展 ==================
    const msExtension = vscode.extensions.getExtension('ms-vscode.cpptools');
    const hasMsExtension = !!msExtension;

    // 提示逻辑优化
    const toolchainName = toolchain.toolchain === 'embedded' ? "内置工具链" : toolchain.toolchain;
    
    if (toolchain.toolchain !== 'embedded' && !hasMsExtension) {
        // 情况：有 GCC 但没微软插件
        vscode.window.showWarningMessage(
            `检测到本地编译器 (${toolchainName})，但未检测到微软 C/C++ 扩展。将使用 NBCpp 内置调试器进行调试。`,
            "推荐安装微软扩展"
        ).then(selection => {
            if (selection === "推荐安装微软扩展") {
                vscode.commands.executeCommand('extension.open', 'ms-vscode.cpptools');
            }
        });
    } else {
        vscode.window.showInformationMessage(`NoBrainerCpp: 自动配置完成 (${toolchainName})`);
    }
    // =======================================================
    // 3. 写入配置文件
    const vscodeDir = ensureVscodeDir(workspaceFolders[0]);
    
    const tasksPath = path.join(vscodeDir, 'tasks.json');
    // 传入 context.extensionPath 以便生成绝对路径参数
    fs.writeFileSync(tasksPath, generateTasksConfig(toolchain, context.extensionPath));

    const launchPath = path.join(vscodeDir, 'launch.json');
    fs.writeFileSync(launchPath, generateLaunchConfig(toolchain, hasMsExtension));

    // ================== 新增：写入 c_cpp_properties.json ==================
    const propertiesPath = path.join(vscodeDir, 'c_cpp_properties.json');
    // 只有当文件不存在，或者我们想强制覆盖时才写。
    // 为了保证“无脑”体验，建议强制覆盖（或者你可以读取旧的合并，但那样太复杂）
    // 这里我们直接覆盖，确保配置一定正确。
    fs.writeFileSync(propertiesPath, generatePropertiesConfig(toolchain, context.extensionPath));
    // ====================================================================

    // 解决竞态条件
    // await sleep(200); 
    try { await vscode.tasks.fetchTasks(); } catch (e) {}

    // 4. 启动调试
    const configName = isCpp ? "Debug C++" : "Debug C";
    try {
        await vscode.debug.startDebugging(workspaceFolders[0], configName);
    } catch (e) {
        vscode.window.showErrorMessage("启动调试失败: " + e);
    }
}
// --- 辅助函数：强制杀死指定名称的进程 ---
async function killProcessByName(exeName: string): Promise<void> {
    return new Promise((resolve) => {
        // 使用 Windows 的 taskkill 命令
        // /F = 强制终止
        // /IM = 镜像名称 (Image Name)
        // 2>nul = 忽略错误输出（比如进程本来就没运行的时候，不需要报错）
        cp.exec(`taskkill /F /IM "${exeName}" 2>nul`, (err) => {
            // 无论成功还是失败（比如进程不存在），都视为完成，继续往下走
            resolve();
        });
    });
}
// ============================================================
// 【修复核心】生成支持“启动挂起”的 PowerShell 脚本 (封装 Wait 逻辑)
// ============================================================
function createPowerShellLauncher(extensionPath: string) {
    const scriptContent = `
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
        cmdLine.Append("\\"");
        cmdLine.Append(exePath);
        cmdLine.Append("\\"");

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

    Write-Host "[PS] Target is suspended. Waiting for debugger."
    Write-Host "[PS] You can input below..."
    # 3. 等待 (调用新封装的无参方法)
    # 这样 PowerShell 不需要处理 0xFFFFFFFF 这个数字，就不会报错了
    [Launcher]::WaitToExit($hProcess)

    #隐藏末尾输出，避免误导新手
    # Write-Host "[PS] Process Exited."
}
catch {
    Write-Error "Launch Failed: $($_.Exception.ToString())"
    exit 1
}
finally {
    if ($hProcess -ne [IntPtr]::Zero) { [Launcher]::CloseHandle($hProcess) | Out-Null }
    if ($hThread -ne [IntPtr]::Zero)  { [Launcher]::CloseHandle($hThread) | Out-Null }
}
`;

    // 确保目录存在
    if (!fs.existsSync(extensionPath)) {
        fs.mkdirSync(extensionPath, { recursive: true });
    }
    
    const scriptPath = path.join(extensionPath, 'Start-Debug.ps1');
    fs.writeFileSync(scriptPath, '\uFEFF' + scriptContent, { encoding: 'utf8' });
    
    return scriptPath;
}
// --- 插件入口 ---

export function activate(context: vscode.ExtensionContext) {
    console.log('NoBrainerCpp 已激活');

    // 【关键】初始化工具链查找器的路径
    setExtensionPath(context.extensionPath);

    const autoDebug = vscode.commands.registerCommand('extension.autoDebug', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("请先打开一个代码文件");
            return;
        }

        const ext = path.extname(editor.document.fileName).toLowerCase();
        const isCpp = ['.cpp', '.cc', '.cxx', '.hpp', '.hh'].includes(ext);
        const isC = ['.c', '.h'].includes(ext);

        if (!isC && !isCpp) {
            vscode.window.showErrorMessage("当前文件不是 C 或 C++ 代码");
            return;
        }

        await setupDebugEnvironment(context, isCpp);
    });

    const debugC = vscode.commands.registerCommand('easycpp.debugC', async () => {
        await setupDebugEnvironment(context, false);
    });

    const debugCpp = vscode.commands.registerCommand('easycpp.debugCpp', async () => {
        await setupDebugEnvironment(context, true);
    });

    context.subscriptions.push(autoDebug, debugC, debugCpp);
    // 注册调试配置提供者，专门监听 "my-simple-lldb"
    // 注册调试配置提供者
// 创建输出面板
    const outputChannel = vscode.window.createOutputChannel("Nobrainer Debug");

// 注册调试配置提供者
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('my-simple-lldb', {
        resolveDebugConfiguration: async (folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken) => {
            
            // 1. 防止递归
            if (config.request === 'attach') {
                return config;
            }

            if (!config.program) {return config;}

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("请先打开一个代码文件");
                return undefined;
            }

            // 2. 路径计算
            const currentFile = editor.document.uri.fsPath;
            const targetDir = path.dirname(currentFile);
            const fileNameNoExt = path.basename(currentFile, path.extname(currentFile));
            const targetExe = path.join(targetDir, fileNameNoExt + ".exe");
            const exeName = fileNameNoExt + ".exe";

            // 3. 强杀旧进程
            await killProcessByName(exeName);
            await new Promise(r => setTimeout(r, 200));

            // 4. 手动编译
            if (config.preLaunchTask) {
                const tasks = await vscode.tasks.fetchTasks();
                const buildTask = tasks.find(t => t.name === config.preLaunchTask);
                if (buildTask) {
                    const execution = await vscode.tasks.executeTask(buildTask);
                    const buildSuccess = await new Promise<boolean>(resolve => {
                        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                            if (e.execution === execution) {
                                disposable.dispose();
                                resolve(e.exitCode === 0);
                            }
                        });
                    });
                    if (!buildSuccess) {
                        vscode.window.showErrorMessage("编译失败");
                        return undefined;
                    }
                }
            }

            // 5. 启动 PowerShell (C# 封装版)
            const randomSuffix = Math.random().toString(36).substring(7);
            const pidFilePath = path.join(os.tmpdir(), `nobrainer_pid_${randomSuffix}.txt`);
            
            outputChannel.clear();
            // 【修改 1】不再主动弹出 Output 面板，只在后台写日志
            // outputChannel.show(true); 
            outputChannel.appendLine(`[Init] Target: ${targetExe}`);

            const extensionPath = context.extensionPath;
            const launcherScript = createPowerShellLauncher(extensionPath);

            const oldTerminal = vscode.window.terminals.find(t => t.name === "Nobrainer Run");
            if (oldTerminal){ oldTerminal.dispose();}

            const terminal = vscode.window.createTerminal("Nobrainer Run");
            
            // 【修改 2】强势霸屏！不传参数 = 强制获取焦点
            // 这样你的光标会直接在终端里闪烁，等待输入
            terminal.show(); 
            
            // 运行脚本
            const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${launcherScript}" "${targetExe}" "${pidFilePath}"`;
            terminal.sendText(command);

            // 6. 等待 PID
            try {
                const pid = await new Promise<number>((resolve, reject) => {
                    let attempts = 0;
                    const interval = setInterval(() => {
                        attempts++;
                        if (fs.existsSync(pidFilePath)) {
                            try {
                                const content = fs.readFileSync(pidFilePath, 'utf8').trim();
                                if (/^\d+$/.test(content)) {
                                    clearInterval(interval);
                                    try { fs.unlinkSync(pidFilePath); } catch(e){} 
                                    resolve(parseInt(content));
                                    return;
                                }
                            } catch (err) { }
                        }
                        if (attempts > 75) { 
                            clearInterval(interval);
                            reject(new Error(`Timeout waiting for PID.`));
                        }
                    }, 200);
                });

                outputChannel.appendLine(`[Success] Got PID: ${pid}`);

                // ============================================================
                // 构造 Attach 配置
                // ============================================================
                const attachConfig = {
                    ...config,
                    request: "attach",
                    pid: pid,
                    program: targetExe,
                    cwd: targetDir,
                    preLaunchTask: undefined, 
                    name: "Nobrainer Attach",
                    stopOnEntry: false, 
                    
                    // 【修改 3】禁止调试控制台抢戏
                    // 确保调试开始后，焦点依然留在我们的终端里
                    internalConsoleOptions: "neverOpen",

                    env: {
                        ...config.env,
                        "Path": `${path.join(context.extensionPath, 'lldbv1.0', 'bin')};${process.env.Path}`
                    }
                };

                // 启动调试
                await vscode.debug.startDebugging(folder, attachConfig);
                
                // 【修改 4】双重保险：调试器启动那一瞬间，再次把焦点拉回终端
                // 防止 lldb 启动时的某些 UI 刷新动作把焦点抢走
                setTimeout(() => {
                    terminal.show();
                }, 500);

            } catch (e: any) {
                // 只有出错时才弹出日志给用户看
                outputChannel.show(true);
                outputChannel.appendLine(`[Error] ${e.message}`);
                vscode.window.showErrorMessage(e.message);
            }

            return undefined;
        }
    }));
    // 注册一个调试适配器追踪器

// ============================================================
    // 【终极方案】双向闭锁追踪器 (Double-Latch Tracker)
    // 完美解决 "stopped" 和 "configurationDone" 乱序到达的问题
    // ============================================================
    vscode.debug.registerDebugAdapterTrackerFactory('my-simple-lldb', {
        createDebugAdapterTracker(session: vscode.DebugSession) {
            
            // 状态标志位
            let configDone = false;       // VS Code 是否配置完毕
            let stoppedThreadId: number | undefined = undefined; // 记录暂停的线程ID
            let hasResumed = false;       // 确保只执行一次继续

            // 尝试执行继续操作的函数
            const tryResume = () => {
                // 必须同时满足三个条件：
                // 1. VS Code 配置完了 (configDone)
                // 2. 调试器已经停了 (stoppedThreadId 有值)
                // 3. 我们还没自动继续过 (!hasResumed)
                if (configDone && stoppedThreadId !== undefined && !hasResumed) {
                    hasResumed = true;
                    // 稍微延迟 10ms 确保状态稳定
                    setTimeout(() => {
                        console.log(`[Tracker] Conditions met. Auto-continuing thread ${stoppedThreadId}...`);
                        session.customRequest('continue', { 
                            threadId: stoppedThreadId 
                        });
                    }, 10);
                }
            };

            return {
                // 1. 监听调试器发来的消息 (Adapter -> VS Code)
                onDidSendMessage: (message) => {
                    if (session.configuration.name !== "Nobrainer Attach") {return;}

                    // 捕获 "stopped" 事件
                    if (message.type === 'event' && message.event === 'stopped') {
                        const reason = message.body.reason;
                        // 记录线程ID，不管是 exception 还是 entry，只要不是用户断点(breakpoint/step)都认
                        if (reason !== 'breakpoint' && reason !== 'step') {
                            console.log(`[Tracker] Debugger stopped (reason: ${reason}). Waiting for ConfigDone...`);
                            stoppedThreadId = message.body.threadId;
                            tryResume(); // 尝试触发
                        }
                    }
                },

                // 2. 监听 VS Code 发出的消息 (VS Code -> Adapter)
                onWillReceiveMessage: (message) => {
                    if (session.configuration.name !== "Nobrainer Attach") {return;}

                    // 捕获 "configurationDone" 请求
                    if (message.command === 'configurationDone') {
                        console.log(`[Tracker] VS Code ConfigurationDone. Waiting for Stopped...`);
                        configDone = true;
                        tryResume(); // 尝试触发
                    }
                }
            };
        }
    });

}

export function deactivate() {}