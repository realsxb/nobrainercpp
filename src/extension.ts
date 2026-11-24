import * as path from 'path';
import * as vscode from 'vscode';

import { createProjectConfigs } from './configuration';
import { needsLegacyBuildRepair, writeProjectFiles } from './projectFiles';
import { registerTerminalDebugger } from './terminalDebugger';
import { getFastestToolchain, setExtensionPath } from './toolchainFinder';

type Language = 'c' | 'cpp';
const debugType = 'my-simple-lldb';
const taskType = 'nobrainercpp';
const automatic: vscode.DebugConfiguration = {
    type: debugType, request: 'launch', name: 'NBCpp: Debug Active File',
    nbcppActiveFile: true, program: '${fileDirname}/${fileBasenameNoExtension}.exe'
};

function languageOf(document: vscode.TextDocument): Language | undefined {
    if (document.languageId === 'c' || document.languageId === 'cpp') {
        return document.languageId;
    }
    const ext = path.extname(document.fileName);
    if (ext === '.C' || /^(?:\.cc|\.cpp|\.cxx|\.hpp|\.hh|\.hxx)$/i.test(ext)) { return 'cpp'; }
    if (/^(?:\.c|\.h)$/i.test(ext)) { return 'c'; }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext) {
    setExtensionPath(context.extensionPath);
    registerTerminalDebugger(context);

    // Supply an exact task for the source selected at launch. This also works on
    // the first click before VS Code's file watcher has loaded a new tasks.json.
    const builds = new Map<string, vscode.Task>();
    const key = (definition: vscode.TaskDefinition) =>
        JSON.stringify([definition.file, definition.language, definition.compiler]);
    context.subscriptions.push(
        vscode.tasks.registerTaskProvider(taskType, {
            provideTasks: () => [...builds.values()],
            resolveTask: task => builds.get(key(task.definition))
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            for (const [id, task] of builds) {
                if (task.definition.file === document.fileName) { builds.delete(id); }
            }
        })
    );

    async function prepare(document: vscode.TextDocument, language: Language, folder: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration> {
        if (document.isDirty && !await document.save()) {
            throw new Error('文件尚未保存，无法开始编译。');
        }
        const toolchain = await getFastestToolchain(language);
        const compiler = toolchain.compilers[language];
        if (!compiler) {
            throw new Error(`没有找到可用的 ${language === 'cpp' ? 'C++' : 'C'} 编译器。请检查系统或扩展内置工具链。`);
        }
        const hasMsExtension = !!vscode.extensions.getExtension('ms-vscode.cpptools');
        const configs = createProjectConfigs(toolchain, context.extensionPath, hasMsExtension);
        const suffix = language === 'cpp' ? 'C++' : 'C';
        const task = configs.tasks.tasks.find(item => item.label === `Build ${suffix}`)!;
        const config = configs.launch.configurations.find(item => item.name === `Debug ${suffix}`)!;
        if (config.type === debugType && process.platform !== 'win32') {
            throw new Error('内置 LLDB 适用于 Windows。当前系统需要 GDB 和微软 C/C++ 扩展。');
        }
        configs.launch.configurations.unshift(automatic);
        await writeProjectFiles(folder.uri.fsPath, configs);

        const file = document.fileName;
        const directory = path.dirname(file);
        const basename = path.basename(file, path.extname(file));
        const variables: Record<string, string> = {
            '${file}': file, '${fileDirname}': directory, '${fileBasenameNoExtension}': basename
        };
        const expand = (s: string) => s.replace(/\$\{(?:file|fileDirname|fileBasenameNoExtension)\}/g, token => variables[token]);
        const definition = { type: taskType, file, language, compiler };
        const build = new vscode.Task(definition, folder, task.label, 'NBCpp',
            new vscode.ProcessExecution(compiler, task.args.map(expand), { cwd: directory }), task.problemMatcher);
        build.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, focus: false };
        builds.set(key(definition), build);
        const debuggerName = config.type === debugType ? '内置 LLDB' : config.type === 'cppvsdbg' ? 'Visual Studio 调试器' : 'GDB';
        vscode.window.setStatusBarMessage(`NBCpp: ${path.basename(compiler)} · ${debuggerName}`, 5000);
        return { ...config, program: expand(config.program), cwd: directory, preLaunchTask: definition };
    }

    async function activeConfiguration(language?: Language, expectedFolder?: vscode.WorkspaceFolder) {
        const document = vscode.window.activeTextEditor?.document;
        const detected = document && languageOf(document);
        if (!document || !detected || document.isUntitled) {
            throw new Error('请先打开并保存一个 C 或 C++ 源文件。');
        }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder || (expectedFolder && folder.uri.toString() !== expectedFolder.uri.toString())) {
            throw new Error('请用 VS Code 打开源文件所在的文件夹。');
        }
        const config = await prepare(document, language ?? detected, folder);
        return { folder, config };
    }

    async function smartRun(language?: Language) {
        try {
            const { folder, config } = await activeConfiguration(language);
            // Only replace sessions that NBCpp started for this exact output.
            // Two projects can both have a main.exe running at the same time.
            for (const previous of sessions.values()) {
                if (previous.configuration.program === config.program) {
                    await vscode.debug.stopDebugging(previous);
                }
            }
            return await vscode.debug.startDebugging(folder, config);
        } catch (error) {
            void vscode.window.showErrorMessage(`NBCpp: ${errorText(error)}`);
            return false;
        }
    }

    const sessions = new Map<string, vscode.DebugSession>();
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(session => {
            if (session.configuration.preLaunchTask?.type === taskType) { sessions.set(session.id, session); }
        }),
        vscode.debug.onDidTerminateDebugSession(session => sessions.delete(session.id)),
        vscode.commands.registerCommand('extension.autoDebug', () => smartRun()),
        vscode.commands.registerCommand('easycpp.debugC', () => smartRun('c')),
        vscode.commands.registerCommand('easycpp.debugCpp', () => smartRun('cpp')),
        vscode.debug.registerDebugConfigurationProvider(debugType, {
            provideDebugConfigurations: () => [{ ...automatic }],
            async resolveDebugConfiguration(folder, config) {
                try {
                    const legacy = folder && config.request === 'launch' &&
                        (config.preLaunchTask === 'Build C' || config.preLaunchTask === 'Build C++') &&
                        await needsLegacyBuildRepair(folder.uri.fsPath, config.preLaunchTask);
                    if (legacy) {
                        const { config: repaired } = await activeConfiguration(config.preLaunchTask === 'Build C++' ? 'cpp' : 'c', folder);
                        return { ...config, preLaunchTask: repaired.preLaunchTask, env: { ...repaired.env, ...config.env } };
                    }
                    if (config.nbcppActiveFile || (!config.request && !config.program)) {
                        const { config: selected } = await activeConfiguration(undefined, folder);
                        const resolved: vscode.DebugConfiguration = { ...selected, ...config, type: selected.type, request: selected.request };
                        if (config.env) { resolved.env = { ...selected.env, ...config.env }; }
                        if (config.program === automatic.program) { resolved.program = selected.program; }
                        delete resolved.nbcppActiveFile;
                        return resolved;
                    }
                    return config;
                } catch (error) {
                    void vscode.window.showErrorMessage(`NBCpp: ${errorText(error)}`);
                    return undefined;
                }
            }
        })
    );
}
