import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
// --- 在文件最顶部添加这一行 ---
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
        " * 问题反馈邮箱shaozeyv@foxmail.com,23182625@buaa.edu.cn欢迎沟通",
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
                                          
    
    >>> NoBrainerCpp v1.2.0 by RealSXB(Nebulazeyv) <<<
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
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('my-simple-lldb', {
        resolveDebugConfiguration: async (folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken) => {
            
            // 1. 如果配置里没有 program，或者只是为了生成 launch.json，直接返回
            if (!config.program) {
                return config;
            }

            // 2. 解析变量 (如 ${fileDirname})
            // 因为 resolveDebugConfiguration 拿到的可能是原始字符串，我们需要手动处理一下路径
            // 或者更简单的方法：直接获取当前编辑器文件
            const editor = vscode.window.activeTextEditor;
            if (!editor) {return undefined;}

            const currentFile = editor.document.uri.fsPath;
            const targetDir = path.dirname(currentFile);
            const fileNameNoExt = path.basename(currentFile, path.extname(currentFile));
            const targetExe = path.join(targetDir, fileNameNoExt + ".exe");
            
            // 3. 执行编译任务 (因为我们接管了启动，preLaunchTask 可能不会自动触发，或者触发了我们也可以再确保一次)
            // 建议：手动触发编译任务
            // 为了简单，这里假设 preLaunchTask 已经在 launch.json 里定义并由 VSCode 在调用此函数前触发了
            // 如果 VSCode 的 preLaunchTask 机制在 resolveDebugConfiguration 之前执行，那就不用管。
            // 实际上：preLaunchTask 会在 resolveDebugConfiguration 返回配置*之后*执行。
            // 但我们要完全替换启动逻辑，所以这里必须返回 undefined 来阻止原生的启动，
            // 这意味着 preLaunchTask 可能失效。
            
            // === 核心黑科技流程 ===
            // ============================================================
            // 【修复开始】: 在编译前，先把旧的进程杀掉，解锁文件
            // ============================================================
            const exeName = fileNameNoExt + ".exe";
            // 提示用户（可选，为了体验可以不弹窗，直接后台杀）
            // console.log(`Cleaning up process: ${exeName}`);
            await killProcessByName(exeName);
            // ============================================================
            // 【修复结束】
            // ============================================================
            // A. 手动执行编译 (找到对应的 Task)
            const tasks = await vscode.tasks.fetchTasks();
            const buildTask = tasks.find(t => t.name === config.preLaunchTask);
            if (buildTask) {
               const execution = await vscode.tasks.executeTask(buildTask);
               // 等待编译完成（需要监听 vscode.tasks.onDidEndTaskProcess）
               await new Promise<void>(resolve => {
                   const disposable = vscode.tasks.onDidEndTaskProcess(e => {
                       if (e.execution === execution) {
                           disposable.dispose();
                           resolve();
                       }
                   });
               });
            }

            // B. 启动 Wrapper 并获取 PID
            try {
                await startDebuggingWithWrapper(targetExe, targetDir, context.extensionPath);
            } catch (e: any) {
                vscode.window.showErrorMessage("启动调试失败: " + e.message);
            }

            // 4. 返回 undefined !!!
            // 这告诉 VS Code："原本的 launch 请求我已经处理完了（或者取消了），你不要再启动任何适配器了。"
            // 因为 startDebuggingWithWrapper 内部会发起一个新的 "attach" 请求。
            return undefined;
        }
    }));
    // 注册一个调试适配器追踪器
    // 专门用来解决 Attach 后需要手动 F5 的问题
    vscode.debug.registerDebugAdapterTrackerFactory('my-simple-lldb', {
        createDebugAdapterTracker(session: vscode.DebugSession) {
            return {
                onDidSendMessage: (message) => {
                    // 我们只关心 "Nobrainer Attach" 这个特定的调试会话
                    if (session.configuration.name !== "Nobrainer Attach") {
                        return;
                    }

                    // 监听调试器发回给 VS Code 的消息 (Event)
                    if (message.type === 'event' && message.event === 'stopped') {
                        const reason = message.body.reason;
                        
                        // 调试器通常因为 'signal', 'exception' (Windows Attach时), 或 'entry' 而暂停
                        // 但如果是因为 'breakpoint' (比如已经撞到了 main)，那就不应该自动继续
                        // 注意：不同 lldb 版本 attach 时的 reason 可能不同，通常是 'signal' 或 'exception'
                        if (reason !== 'breakpoint' && reason !== 'step') {
                            console.log(`[Tracker] Detect initial stop (reason: ${reason}), auto-continuing...`);
                            
                            // 优雅地发送 Continue 命令
                            // 这里的 threadId 很重要，告诉调试器恢复哪个线程
                            const threadId = message.body.threadId;
                            session.customRequest('continue', { threadId: threadId }).then(() => {
                                console.log("[Tracker] Auto-continue executed.");
                            }, (e) => {
                                console.log("[Tracker] Auto-continue ignored/failed:", e);
                            });
                        }
                    }
                }
            };
        }
    });


}

export function deactivate() {}