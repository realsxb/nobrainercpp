import { randomUUID } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

const debugType = 'my-simple-lldb';
const startupTimeout = 60_000;

interface StackFrame {
    name: string;
    source?: { path?: string };
}

// The Windows loader raises its own breakpoint while initializing a freshly
// attached executable. Never continue an application breakpoint or exception.
async function isLoaderBreakpoint(session: vscode.DebugSession, threadId: number): Promise<boolean> {
    const { stackFrames }: { stackFrames: StackFrame[] } =
        await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 12 });
    return stackFrames.length > 0 &&
        stackFrames.every(frame => /[\\/]ntdll\.dll(?:`|$)/i.test(frame.source?.path ?? '')) &&
        stackFrames.some(frame => /\bLdrInitializeThunk\b/i.test(frame.name));
}

// LLDB 21 uses a POSIX FIFO for runInTerminal, which its Windows build
// does not implement. Start the target suspended in a VS Code process task
// and let the same debug session attach before its first instruction runs.
class TerminalLaunch implements vscode.Disposable {
    readonly id = randomUUID();
    private readonly pipeName = `\\\\.\\pipe\\nbcpp-${this.id}`;
    private readonly server = net.createServer();
    private readonly subscriptions: vscode.Disposable[] = [];
    private socket?: net.Socket;
    private execution?: vscode.TaskExecution;
    private timeout?: NodeJS.Timeout;
    private disposed = false;
    private rejectStartup?: (err: Error) => void;

    constructor(private readonly onDispose: () => void) {}

    start(helper: string, folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<number> {
        const task = new vscode.Task(
            { type: 'nbcpp-terminal', session: this.id },
            folder ?? vscode.TaskScope.Global,
            `NBCpp: ${path.basename(config.program)}`, 'NBCpp',
            new vscode.ProcessExecution(helper, [this.pipeName, config.program, ...(config.args ?? [])], {
                cwd: config.cwd ?? path.dirname(config.program), env: config.env
            })
        );
        task.presentationOptions = {
            echo: false, focus: true, reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared, clear: true, showReuseMessage: false
        };
        return new Promise<number>((resolve, reject) => {
            this.rejectStartup = reject;
            const fail = (error: Error) => {
                reject(error);
                this.dispose();
            };
            this.timeout = setTimeout(() => fail(new Error('等待调试终端启动超时。')), startupTimeout);
            this.subscriptions.push(
                vscode.tasks.onDidEndTask(event => {
                    if (event.execution.task.definition.session === this.id && this.rejectStartup) {
                        fail(new Error('调试终端已结束，程序未能启动。'));
                    }
                })
            );
            this.server.on('error', fail);
            this.server.once('connection', socket => {
                this.server.close();
                this.socket = socket;
                socket.setEncoding('ascii');
                socket.on('error', fail);
                socket.once('close', () => this.dispose());
                let message = '';
                const readPID = (chunk: string) => {
                    message += chunk;
                    if (!message.includes('\n') && message.length <= 48) { return; }
                    socket.off('data', readPID);
                    const pid = /^(\d+)\n$/.exec(message);
                    if (!pid) {
                        const error = /^ERR (\d+)\n$/.exec(message);
                        fail(new Error(`无法启动 ${config.program}${error ? ` (Windows ${error[1]})` : ''}。`));
                        return;
                    }
                    this.rejectStartup = undefined;
                    clearTimeout(this.timeout);
                    // Covers a cancelled adapter startup before a tracker is created.
                    this.timeout = setTimeout(() => this.dispose(), startupTimeout);
                    resolve(Number(pid[1]));
                };
                socket.on('data', readPID);
            });
            this.server.listen(this.pipeName, () => {
                if (this.disposed) { return; }
                vscode.tasks.executeTask(task).then(execution => {
                    this.execution = execution;
                    if (this.disposed) { execution.terminate(); }
                }, fail);
            });
        });
    }

    connected(): void {
        clearTimeout(this.timeout);
    }

    resume(): void {
        this.socket?.write('R');
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.onDispose();
        this.rejectStartup?.(new Error('调试终端已关闭。'));
        this.rejectStartup = undefined;
        clearTimeout(this.timeout);
        if (this.server.listening) { this.server.close(); }
        if (this.socket) {
            // Closing the session pipe terminates just this target. VS Code
            // keeps the finished task terminal available for reading its output.
            this.socket.destroy();
        } else {
            this.execution?.terminate();
        }
        for (const subscription of this.subscriptions) { subscription.dispose(); }
    }
}

export function registerTerminalDebugger(context: vscode.ExtensionContext): void {
    const launches = new Map<string, TerminalLaunch>();
    const helper = context.asAbsolutePath(path.join('bin', 'terminal-launcher.exe'));
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(debugType, {
            resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
                if (config.request !== 'launch' || !config.program || config.console === 'internalConsole' ||
                    config.runInTerminal === false || config.launchCommands) {
                    return config;
                }
                return { ...config, request: 'attach', attachCommands: ['nbcpp-attach'],
                    __nbcppTerminal: true, stopOnEntry: config.stopOnEntry ?? config.stopAtEntry ?? false };
            }
        }),
        vscode.debug.registerDebugAdapterDescriptorFactory(debugType, {
            async createDebugAdapterDescriptor(session, adapter) {
                if (!adapter) { throw new Error('未找到内置 LLDB 调试适配器。'); }
                if (!session.configuration.__nbcppTerminal) { return adapter; }
                // VS Code reuses a resolved configuration when the user presses
                // Restart, but creates a fresh adapter after the build each time.
                // Bind the new PID to this adapter only, never to the saved config.
                launches.get(session.id)?.dispose();
                const launch = new TerminalLaunch(() => launches.delete(session.id));
                launches.set(session.id, launch);
                try {
                    const pid = await launch.start(helper, session.workspaceFolder, session.configuration);
                    const args = [...adapter.args, '--pre-init-command', `command alias nbcpp-attach process attach --pid ${pid}`];
                    return new vscode.DebugAdapterExecutable(adapter.command, args, adapter.options);
                } catch (error) {
                    launch.dispose();
                    throw error;
                }
            }
        }),
        vscode.debug.registerDebugAdapterTrackerFactory(debugType, {
            createDebugAdapterTracker(session) {
                const launch = launches.get(session.id);
                if (!launch) { return; }
                launch.connected();
                let checkFirstStop = !session.configuration.stopOnEntry;
                let pendingThread: number | undefined;
                let configured = false;
                let checking = false;
                const continueLoader = async () => {
                    const threadId = pendingThread;
                    if (!configured || checking || threadId === undefined) { return; }
                    checking = true;
                    try {
                        if (await isLoaderBreakpoint(session, threadId) && pendingThread === threadId) {
                            await session.customRequest('continue', { threadId });
                        }
                    } catch {
                        // A concurrent user action can already have resumed or stopped the session.
                    }
                };
                return {
                    onWillReceiveMessage(message) {
                        if (['continue', 'next', 'stepIn', 'stepOut', 'disconnect'].includes(message.command)) {
                            pendingThread = undefined;
                        }
                    },
                    onDidSendMessage(message) {
                        if (message.type === 'event' && message.event === 'stopped') {
                            pendingThread = undefined;
                            if (checkFirstStop && message.body?.reason === 'exception' &&
                                /\b0x80000003\b/i.test(message.body.description ?? '')) {
                                pendingThread = message.body.threadId;
                                void continueLoader();
                            }
                            checkFirstStop = false;
                        }
                        if (message.type !== 'response') { return; }
                        if (!message.success && (message.command === 'attach' || message.command === 'configurationDone')) {
                            launch.dispose();
                        } else if (message.command === 'configurationDone') {
                            configured = true;
                            launch.resume();
                            void continueLoader();
                        }
                    },
                    onError: () => launch.dispose(),
                    onExit: () => launch.dispose()
                };
            }
        }),
        vscode.debug.onDidTerminateDebugSession(session => launches.get(session.id)?.dispose()),
        { dispose: () => { for (const launch of launches.values()) { launch.dispose(); } } }
    );
}
