import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
// 引入查找器
import { getFastestToolchain, ToolchainResult } from './toolchainFinder'; 
// --- 辅助函数:sleep ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// --- 辅助函数：生成配置 ---

function ensureVscodeDir(workspaceFolder: vscode.WorkspaceFolder): string {
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    return vscodeDir;
}

function generateTasksConfig(toolchain: ToolchainResult): string {
    const tasks = [];
    
    // C 编译任务
    if (toolchain.compilers.c) {
        tasks.push({
            type: "shell",
            label: "Build C",
            command: toolchain.compilers.c,
            args: [
                "-fdiagnostics-color=always",
                "-g",
                "${file}",
                "-o",
                "${fileDirname}/${fileBasenameNoExtension}.exe"
            ],
            options: { cwd: "${fileDirname}" },
            problemMatcher: ["$gcc"],
            group: { kind: "build", isDefault: true },
            detail: `使用编译器: ${toolchain.compilers.c}`
        });
    }

    // C++ 编译任务
    if (toolchain.compilers.cpp) {
        tasks.push({
            type: "shell",
            label: "Build C++",
            command: toolchain.compilers.cpp,
            args: [
                "-fdiagnostics-color=always",
                "-g",
                "${file}",
                "-o",
                "${fileDirname}/${fileBasenameNoExtension}.exe"
            ],
            options: { cwd: "${fileDirname}" },
            problemMatcher: ["$gcc"],
            group: "build",
            detail: `使用编译器: ${toolchain.compilers.cpp}`
        });
    }

    return JSON.stringify({ version: "2.0.0", tasks }, null, 4);
}

function generateLaunchConfig(debuggerPath: string | undefined): string {
    const dbgPath = debuggerPath || "gdb"; 
    
    const configs = [
        {
            name: "Debug C",
            type: "cppdbg",
            request: "launch",
            program: "${fileDirname}/${fileBasenameNoExtension}.exe",
            args: [],
            stopAtEntry: false,
            cwd: "${fileDirname}",
            environment: [],
            externalConsole: false,
            MIMode: "gdb",
            miDebuggerPath: dbgPath,
            setupCommands: [
                { description: "Enable pretty-printing", text: "-enable-pretty-printing", ignoreFailures: true }
            ],
            preLaunchTask: "Build C"
        },
        {
            name: "Debug C++",
            type: "cppdbg",
            request: "launch",
            program: "${fileDirname}/${fileBasenameNoExtension}.exe",
            args: [],
            stopAtEntry: false,
            cwd: "${fileDirname}",
            environment: [],
            externalConsole: false,
            MIMode: "gdb",
            miDebuggerPath: dbgPath,
            setupCommands: [
                { description: "Enable pretty-printing", text: "-enable-pretty-printing", ignoreFailures: true }
            ],
            preLaunchTask: "Build C++"
        }
    ];

    return JSON.stringify({ version: "0.2.0", configurations: configs }, null, 4);
}

// --- 核心逻辑 ---

async function setupDebugEnvironment(isCpp: boolean) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("请先打开一个文件夹工作区！");
        return;
    }
    
    // 显示状态栏消息
    vscode.window.setStatusBarMessage("NoBrainerCpp: 正在搜索编译器...", 3000);
    
    // 1. 获取最快可用的工具链
    const toolchain = await getFastestToolchain();

    // 2. 检查结果
    const compiler = isCpp ? toolchain.compilers.cpp : toolchain.compilers.c;
    if (!compiler) {
        const lang = isCpp ? "C++" : "C";
        vscode.window.showErrorMessage(
            `未找到 ${lang} 编译器！请安装 MinGW-w64 或 Clang 并确保添加到环境变量 PATH 中。`
        );
        return;
    }

    vscode.window.showInformationMessage(`NoBrainerCpp: 自动配置完成 (编译器: ${path.basename(compiler)})`);

    // 3. 写入配置文件
    const vscodeDir = ensureVscodeDir(workspaceFolders[0]);
    
    const tasksPath = path.join(vscodeDir, 'tasks.json');
    fs.writeFileSync(tasksPath, generateTasksConfig(toolchain));

    const launchPath = path.join(vscodeDir, 'launch.json');
    fs.writeFileSync(launchPath, generateLaunchConfig(toolchain.debugger));
    // ================== 新增代码开始 ==================
    
    // 关键修正：解决竞态条件
    // 问题：文件刚写入，VS Code 的任务系统可能还没来得及解析 tasks.json，导致找不到 "Build C"。
    // 解决：强制让出时间片，并主动请求刷新任务。
    
    // 1. 稍微等待文件系统的 watcher 触发
    await sleep(200); 
    
    // 2. 强制 VS Code 重新读取任务列表 (这一步非常关键)
    // 虽然 fetchTasks 返回的是任务列表，我们不需要返回值，但这会触发 VS Code 内部刷新缓存
    try {
        await vscode.tasks.fetchTasks();
    } catch (e) {
        // 忽略 fetch 错误，有时只是为了触发刷新
    }

    // ================== 新增代码结束 ==================
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

    // 1. 智能按钮入口 (extension.autoDebug)
    const autoDebug = vscode.commands.registerCommand('extension.autoDebug', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("请先打开一个代码文件");
            return;
        }

        const ext = path.extname(editor.document.fileName).toLowerCase();
        // 智能判断逻辑
        const isCpp = ['.cpp', '.cc', '.cxx', '.hpp', '.hh'].includes(ext);
        const isC = ['.c', '.h'].includes(ext);

        if (!isC && !isCpp) {
            vscode.window.showErrorMessage("当前文件不是 C 或 C++ 代码，无法智能启动。");
            return;
        }

        await setupDebugEnvironment(isCpp);
    });

    // 2. 强制 C 入口 (Ctrl+Alt+C)
    const debugC = vscode.commands.registerCommand('easycpp.debugC', async () => {
        await setupDebugEnvironment(false); // 强制 isCpp = false
    });

    // 3. 强制 C++ 入口 (Ctrl+Alt+D)
    const debugCpp = vscode.commands.registerCommand('easycpp.debugCpp', async () => {
        await setupDebugEnvironment(true); // 强制 isCpp = true
    });

    // 注册所有命令
    context.subscriptions.push(autoDebug, debugC, debugCpp);
}

export function deactivate() {}