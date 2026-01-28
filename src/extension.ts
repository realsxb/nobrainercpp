// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { commands as vscodeCommands, Disposable, ExtensionContext } from 'vscode';
import * as childProcess from 'child_process'; 
import * as fs from 'fs';
import * as path from 'path';
//检测/提取编译器路径，输入名字，查找全局变量
async function findCompiler(compilerName: string): Promise<string | null> {
    const platforms = {
        'win32': `where ${compilerName}`,
        'linux': `which ${compilerName}`,
        'darwin': `which ${compilerName}`
    };
    const command = platforms[process.platform as keyof typeof platforms];//这后面指的是我确定是有这个key
;
    try {
        const path = childProcess.execSync(command).toString().trim();
        return path || null;
    } catch (err) {
        return null;
    }
}
function ensureVscodeDir(workspaceFolder: vscode.WorkspaceFolder): string {
    // 1. 构建.vscode文件夹的完整路径
    // workspaceFolder 是 VS Code 的对象，表示当前打开的工作区
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    
    // 2. 检查该路径是否存在
    if (!fs.existsSync(vscodeDir)) {
        // 3. 如果不存在，则创建文件夹
        fs.mkdirSync(vscodeDir);
    }
    
    // 4. 返回.vscode文件夹的路径
    return vscodeDir;
}
function generateTasksConfig(gccPath: string, gppPath: string): string {
    return JSON.stringify({
        version: "2.0.0",
        tasks: [
            {
                type: "cppbuild",  // 使用专用类型
                label: "Build C",
                command: gccPath,
                args: [
                    "-fdiagnostics-color=always", // 添加彩色诊断
                    "-g",
                    "${file}",
                    "-o",
                    "${fileDirname}/${fileBasenameNoExtension}.exe"
                ],
                options: {
                    cwd: "${fileDirname}"  // 显式设置工作目录
                },
                problemMatcher: ["$gcc"],
                group: {
                    kind: "build",
                    isDefault: true  // 保持C为默认任务
                },
                detail: `编译器: ${gccPath}`  // 添加编译器路径信息
            },
            {
                type: "cppbuild",
                label: "Build C++",
                command: gppPath,
                args: [
                    "-fdiagnostics-color=always",
                    "-g",
                    "${file}",
                    "-o",
                    "${fileDirname}/${fileBasenameNoExtension}.exe"
                ],
                options: {
                    cwd: "${fileDirname}"
                },
                problemMatcher: ["$gcc"],
                group: "build",
                detail: `编译器: ${gppPath}`
            }
        ]
    }, null, 4);
}
function generateLaunchConfig(gdbPath: string | null): string {
    return JSON.stringify({
        version: "0.2.0",
        configurations: [
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
                miDebuggerPath: gdbPath || "gdb",
                setupCommands: [
                    {
                        description: "为 gdb 启用整齐打印",
                        text: "-enable-pretty-printing",
                        ignoreFailures: true
                    },
                    {
                        description: "将反汇编风格设置为 Intel",
                        text: "-gdb-set disassembly-flavor intel",
                        ignoreFailures: true
                    }
                ],
                preLaunchTask: "Build C",
                logging: {
                    moduleLoad: false,
                    engineLogging: false,
                    trace: false
                }
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
                miDebuggerPath: gdbPath || "gdb",
                setupCommands: [
                    {
                        description: "为 gdb 启用整齐打印",
                        text: "-enable-pretty-printing",
                        ignoreFailures: true
                    },
                    {
                        description: "将反汇编风格设置为 Intel",
                        text: "-gdb-set disassembly-flavor intel",
                        ignoreFailures: true
                    }
                ],
                preLaunchTask: "Build C++",
                logging: {
                    moduleLoad: false,
                    engineLogging: false,
                    trace: false
                }
            }
        ]
    }, null, 4);
}
async function setupDebugEnvironment(isCpp: boolean) {
    // 1. 获取当前工作区
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No workspace folder opened!");
        return;
    }
    const workspaceFolder = workspaceFolders[0];
        // 2. 优先尝试Microsoft扩展的工具链
    const mingwBinPath = getCPPToolsMingwPath();
    vscode.window.showInformationMessage(`qw ${mingwBinPath}`);
    const vscodeTools = {
        gcc: mingwBinPath ? findToolInDir(mingwBinPath, 'gcc') : null,
        gpp: mingwBinPath ? findToolInDir(mingwBinPath, 'g++') : null,
        gdb: mingwBinPath ? findToolInDir(mingwBinPath, 'gdb') : null
    };
    
    // 显示找到的工具
    if (mingwBinPath) {
        vscode.window.showInformationMessage(
            `Found VSCode tools: 
            gcc: ${vscodeTools.gcc ? '✔️' : '❌'}, 
            g++: ${vscodeTools.gpp ? '✔️' : '❌'}, 
            gdb: ${vscodeTools.gdb ? '✔️' : '❌'}`
        );
    }
    // 2. 检测编译器
    const compilerName = isCpp ? "g++" : "gcc";
    const compilerPath = await findCompiler(compilerName);
    
    if (!compilerPath) {
        vscode.window.showErrorMessage(`${compilerName} not found in PATH!
            你需要配置环境变量
            请参考教程https://blog.csdn.net/qq_44918090/article/details/132190274
            如果找不到下载地址可以尝试
            https://github.com/niXman/mingw-builds-binaries/releases
            官方发布页
            安装类似x86_64-15.2.0-release-win32-seh-msvcrt-rt_v13-rev0.7z包
            `);
        return;
    }
    // 3. 确保.vscode目录存在
    const vscodeDir = ensureVscodeDir(workspaceFolder);
    
    // 4. 生成并写入配置文件
    try {
        // 写入tasks.json（只需要写一次）
        const tasksPath = path.join(vscodeDir, 'tasks.json');
        if (!fs.existsSync(tasksPath)) {
            const gccPath = await findCompiler("gcc");
            const gppPath = await findCompiler("g++");
            if (!gccPath || !gppPath) {
                throw new Error("GCC/G++ not found");
            }
            fs.writeFileSync(tasksPath, generateTasksConfig(gccPath, gppPath));
        }
        // 写入launch.json（只需要写一次）
        const launchPath = path.join(vscodeDir, 'launch.json');
        if (!fs.existsSync(launchPath)) {
            fs.writeFileSync(launchPath, generateLaunchConfig(null));
        }
        // 5. 获取当前文件
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showErrorMessage("No active editor!");
            return;
        }
        // 6. 执行调试
        const debugConfigName = isCpp ? "Debug C++" : "Debug C";
        await vscode.debug.startDebugging(workspaceFolder, debugConfigName);
    } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Error: ${message}`);
    }
}
//----------------------------------------------增强容错性---------------------------------------\\
// 全局存储已覆盖的命令
// 新增：获取Microsoft扩展工具链路径
function getCPPToolsMingwPath(): string | null {
    try {
        // 1. 获取C/C++扩展
        const cppExt = vscode.extensions.getExtension('ms-vscode.cpptools');
        if (!cppExt) return null;
        // 2. 构建工具链路径 (Windows)
        return path.join(cppExt.extensionPath, 'mingw64', 'bin');
        
    } catch (err) {
        return null;
    }
}
// 新增：从目录中查找工具
function findToolInDir(dirPath: string, toolName: string): string | null {
    if (!dirPath || !fs.existsSync(dirPath)) return null;
    const toolPath = path.join(dirPath, `${toolName}.exe`);
    return fs.existsSync(toolPath) ? toolPath : null;
}
//---------------------------------------------增强容错性---------------------------------------\\
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    const debugC = vscode.commands.registerCommand('easycpp.debugC', () => {
        // 调用 gcc 调试逻辑
         setupDebugEnvironment(false).catch(console.error);
    });
    const debugCpp = vscode.commands.registerCommand('easycpp.debugCpp', () => {
        // 调用 g++ 调试逻辑
         setupDebugEnvironment(true).catch(console.error);
    });
    context.subscriptions.push(debugC, debugCpp);
    // 注册智能调试命令
// 修改 extension.autoDebug 命令部分
const disposable = vscode.commands.registerCommand('extension.autoDebug', async () => {
    const editor = vscode.window.activeTextEditor;
    vscode.window.showInformationMessage('The NoBrainerCpp extension is activated! 🎉');

    if (!editor) {
        vscode.window.showErrorMessage("No active editor!鼠标无聚焦");
        return;
    }

    // 智能检测文件类型
    const fileExt = path.extname(editor.document.fileName).toLowerCase();
    const isCpp = ['.cpp', '.cc', '.cxx', '.hpp'].includes(fileExt);
    const isC = ['.c', '.h'].includes(fileExt);
    
    if (!isC && !isCpp) {
        vscode.window.showErrorMessage("Unsupported file type!");
        return;
    }

    // ==== 新增：每次调试前强制重置配置 ====
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder opened!");
        return;
    }

    // 删除现有配置文件
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    try {
        ['tasks.json', 'launch.json'].forEach(file => {
            const configPath = path.join(vscodeDir, file);
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }
        });
    } catch (err) {
        console.warn("无法删除配置文件:", err);
         vscode.window.showErrorMessage("停止执行，无法删除原配置文件!");
    }
    // ==== 新增部分结束 ====

    // 设置调试环境（这将重新创建配置文件）
    await setupDebugEnvironment(isCpp);
});

//------------------------------------内---------分割线消除按钮专用区---------------------------------------\\
//放弃

}
//------------------------------------外---------分割线消除按钮专用区---------------------------------------\\


//-------------------------------------外---------分割线消除按钮专用区---------------------------------------\\


//空白下面为初始化函数末尾括号






// This method is called when your extension is deactivated
export function deactivate() {
    
}
