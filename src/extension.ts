import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

function generateLaunchConfig(toolchain: ToolchainResult): string {
    const isEmbedded = toolchain.toolchain === 'embedded';
    
    // 如果是 embedded，使用你注册的 "my-simple-lldb"
    // 如果是 system，使用标准的 "cppdbg"
    const debugType = isEmbedded ? "my-simple-lldb" : "cppdbg";
    
    // 构造配置对象
    const createConfig = (name: string, preLaunchTask: string) => {
        const config: any = {
            name: name,
            type: debugType,
            request: "launch",
            program: "${fileDirname}/${fileBasenameNoExtension}.exe",
            cwd: "${workspaceFolder}",
            stopAtEntry: false, // 标准配置通常是 false，根据你的 my-simple-lldb 也可以设为 true
            preLaunchTask: preLaunchTask
        };

        if (isEmbedded) {
            // --- 内嵌调试器配置 ---
            // my-simple-lldb 特有属性
            config.logFile = "${workspaceFolder}/dap-log.txt";
            // 注意：my-simple-lldb 不需要 miDebuggerPath，因为它直接调用 lldb-dap
            // 也不需要 MIMode
        } else {
            // --- 系统调试器配置 (GDB/LLDB) ---
            config.args = [];
            config.environment = [];
            config.externalConsole = false;
            config.MIMode = "gdb"; // 默认为 gdb, 如果是 clang 系统工具链可能是 lldb，这里简化处理
            config.miDebuggerPath = toolchain.debugger || "gdb";
            config.setupCommands = [
                { description: "Enable pretty-printing", text: "-enable-pretty-printing", ignoreFailures: true }
            ];
        }
        return config;
    };

    const configs = [
        createConfig("Debug C", "Build C"),
        createConfig("Debug C++", "Build C++")
    ];

    return getBrandHeader() + JSON.stringify({ version: "0.2.0", configurations: configs }, null, 4);
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

    return getBrandHeader() + JSON.stringify(config, null, 4);
}
// src/extension.ts

function getBrandHeader(): string {
    return [
        "/**",
        " * ------------------------------------------------------------------",
        " * Generated by NoBrainerCpp",
        " * Author: RealSXB(Nebulazeyv)",
        " * Github: https://github.com/realsxb/nobrainercpp",
        " * Slogan: Make C++ Simple Again!",
        " * 作者受够了自己配置vscode的c/cpp环境",
        " * 决心写一个插件一键生成配置文件实现一劳永逸",
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
                                          
    
    >>> NoBrainerCpp v1.0.0 by RealSXB(Nebulazeyv) <<<
    >>> 用法->
    >>> 只需点击右上角左箭头即可开始调试c/cpp无需任何手动配置
    >>> 完全0依赖,即插即用,你甚至可以在裸vscode上使用此插件来编译c/cpp
    >>> 说明->
    >>> 本插件优先搜索PATH路径中已安装的工具链,如果缺失会使用内嵌工具链
    >>> 每次启动右下角都会有所配置的工具链的相关提示
    >>> 反馈->
    >>> Github开源代码地址: https://github.com/realsxb/nobrainercpp <<<
    >>> 问题反馈邮箱shaozeyv@foxmail.com,23182625@buaa.edu.cn <<<
    `;
    
    // 创建一个输出通道
    const outputChannel = vscode.window.createOutputChannel("NoBrainerCpp");
    outputChannel.show(true); // true 表示不抢占焦点，但在后台显示
    outputChannel.appendLine(logo);
    outputChannel.appendLine("正在配置 C/C++ 环境...");
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

    const toolchainName = toolchain.toolchain === 'embedded' ? "内置工具链" : toolchain.toolchain;
    vscode.window.showInformationMessage(`NoBrainerCpp: 自动配置完成 (${toolchainName})`);

    // 3. 写入配置文件
    const vscodeDir = ensureVscodeDir(workspaceFolders[0]);
    
    const tasksPath = path.join(vscodeDir, 'tasks.json');
    // 传入 context.extensionPath 以便生成绝对路径参数
    fs.writeFileSync(tasksPath, generateTasksConfig(toolchain, context.extensionPath));

    const launchPath = path.join(vscodeDir, 'launch.json');
    fs.writeFileSync(launchPath, generateLaunchConfig(toolchain));

    // ================== 新增：写入 c_cpp_properties.json ==================
    const propertiesPath = path.join(vscodeDir, 'c_cpp_properties.json');
    // 只有当文件不存在，或者我们想强制覆盖时才写。
    // 为了保证“无脑”体验，建议强制覆盖（或者你可以读取旧的合并，但那样太复杂）
    // 这里我们直接覆盖，确保配置一定正确。
    fs.writeFileSync(propertiesPath, generatePropertiesConfig(toolchain, context.extensionPath));
    // ====================================================================

    // 解决竞态条件
    await sleep(200); 
    try { await vscode.tasks.fetchTasks(); } catch (e) {}

    // 4. 启动调试
    const configName = isCpp ? "Debug C++" : "Debug C";
    try {
        await vscode.debug.startDebugging(workspaceFolders[0], configName);
    } catch (e) {
        vscode.window.showErrorMessage("启动调试失败: " + e);
    }
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
}

export function deactivate() {}