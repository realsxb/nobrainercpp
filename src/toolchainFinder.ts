import * as childProcess from 'child_process';
import * as fs from 'fs';

// --- 类型定义 ---
export interface ToolchainResult {
    toolchain: 'gnu' | 'clang' | 'msvc' | 'combo';
    compilers: {
        c?: string;
        cpp?: string;
    };
    debugger?: string;
}

interface ToolchainDiscoveryResult {
    compilers: { c?: string; cpp?: string; };
    debugger?: string;
}

// --- 全局状态管理 ---
const toolchainState = {
    results: {
        gnu: null as ToolchainDiscoveryResult | null,
        clang: null as ToolchainDiscoveryResult | null,
        msvc: null as ToolchainDiscoveryResult | null
    },
    completed: {
        gnu: false,
        clang: false,
        msvc: false
    },
    selected: null as ToolchainResult | null,
    firstComplete: null as ToolchainResult | null,
    callbacks: {
        onFirstComplete: [] as ((res: ToolchainResult) => void)[],
        onAllComplete: [] as ((res: ToolchainResult) => void)[]
    },
    isSearching: false
};

// --- 核心查找工具函数 ---
async function findExecutable(binName: string): Promise<string | null> {
    return new Promise((resolve) => {
        const platform = process.platform;
        // Windows 用 where, Unix 用 which
        const command = platform === 'win32' ? `where ${binName}` : `which ${binName}`;
        
        childProcess.exec(command, (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }
            // 取第一行结果，去除空白
            const paths = stdout.toString().split(/\r?\n/);
            const firstPath = paths[0].trim();
            if (firstPath && fs.existsSync(firstPath)) {
                resolve(firstPath);
            } else {
                resolve(null);
            }
        });
    });
}

// --- 具体工具链查找器 ---

async function findGnuToolchain() {
    try {
        const [gcc, gxx, gdb] = await Promise.all([
            findExecutable('gcc'),
            findExecutable('g++'),
            findExecutable('gdb')
        ]);

        const result: ToolchainDiscoveryResult = {
            compilers: { c: gcc || undefined, cpp: gxx || undefined },
            debugger: gdb || undefined
        };
        
        // 只要有编译器就算找到
        if (result.compilers.c || result.compilers.cpp) {
            onToolchainFound('gnu', result);
        } else {
            onToolchainFound('gnu', null);
        }
    } catch {
        onToolchainFound('gnu', null);
    }
}

async function findClangToolchain() {
    try {
        const [clang, clangxx, lldb] = await Promise.all([
            findExecutable('clang'),
            findExecutable('clang++'),
            findExecutable('lldb')
        ]);

        const result: ToolchainDiscoveryResult = {
            compilers: { c: clang || undefined, cpp: clangxx || undefined },
            debugger: lldb || undefined
        };

        if (result.compilers.c || result.compilers.cpp) {
            onToolchainFound('clang', result);
        } else {
            onToolchainFound('clang', null);
        }
    } catch {
        onToolchainFound('clang', null);
    }
}

async function findMsvcToolchain() {
    try {
        const cl = await findExecutable('cl');
        if (cl) {
            onToolchainFound('msvc', {
                compilers: { c: cl, cpp: cl },
                debugger: undefined // MSVC debugger 通常不通过 PATH 直接调用
            });
        } else {
            onToolchainFound('msvc', null);
        }
    } catch {
        onToolchainFound('msvc', null);
    }
}

// --- 状态更新与回调触发 ---

function onToolchainFound(name: 'gnu' | 'clang' | 'msvc', result: ToolchainDiscoveryResult | null) {
    toolchainState.results[name] = result;
    toolchainState.completed[name] = true;

    // 1. 尝试触发“最快可用”回调
    if (!toolchainState.firstComplete && result && (result.compilers.c || result.compilers.cpp)) {
        toolchainState.firstComplete = {
            toolchain: name,
            compilers: result.compilers,
            debugger: result.debugger
        };
        triggerCallbacks('onFirstComplete', toolchainState.firstComplete);
    }

    // 2. 检查是否全部完成
    if (toolchainState.completed.gnu && toolchainState.completed.clang && toolchainState.completed.msvc) {
        const best = selectBestToolchain();
        toolchainState.selected = best;
        triggerCallbacks('onAllComplete', best);
    }
}

function triggerCallbacks(type: 'onFirstComplete' | 'onAllComplete', data: ToolchainResult) {
    const cbs = toolchainState.callbacks[type];
    // 清空回调队列，避免重复调用
    if (type === 'onFirstComplete') {
        toolchainState.callbacks[type] = [];
    }
    cbs.forEach(cb => cb(data));
}

// --- 决策算法 ---

function selectBestToolchain(): ToolchainResult {
    // 简单策略：优先完整度，其次顺序 GNU > Clang > MSVC
    const order = ['gnu', 'clang', 'msvc'] as const;
    for (const name of order) {
        const res = toolchainState.results[name];
        if (res && res.compilers.cpp && res.debugger) {
            return { toolchain: name, ...res };
        }
    }
    return createComboToolchain();
}

function createComboToolchain(): ToolchainResult {
    let c, cpp, dbg;
    const order = ['gnu', 'clang', 'msvc'] as const;
    for (const name of order) {
        const res = toolchainState.results[name];
        if (!res) continue;
        if (!c && res.compilers.c) c = res.compilers.c;
        if (!cpp && res.compilers.cpp) cpp = res.compilers.cpp;
        if (!dbg && res.debugger) dbg = res.debugger;
    }
    return {
        toolchain: 'combo',
        compilers: { c, cpp },
        debugger: dbg
    };
}

// --- 公共 API ---

export function getFastestToolchain(): Promise<ToolchainResult> {
    return new Promise((resolve) => {
        // 如果已经有 First Complete 结果，直接返回
        if (toolchainState.firstComplete) {
            resolve(toolchainState.firstComplete);
            return;
        }
        // 如果已经全部搜完，直接返回最终结果
        if (toolchainState.selected) {
            resolve(toolchainState.selected);
            return;
        }

        // 注册回调
        toolchainState.callbacks.onFirstComplete.push(resolve);
        
        // 保底：如果最后都没触发 FirstComplete（比如都没找到），那就等 AllComplete
        toolchainState.callbacks.onAllComplete.push((res) => {
             // 只有当 onFirstComplete 还没被触发过时才执行，防止重复 resolve
             // 但 Promise 状态一旦改变就不会再变，所以这里直接 resolve 也是安全的
             resolve(res);
        });

        if (!toolchainState.isSearching) {
            startToolchainDiscovery();
        }
    });
}

function startToolchainDiscovery() {
    toolchainState.isSearching = true;
    toolchainState.completed = { gnu: false, clang: false, msvc: false };
    findGnuToolchain();
    findClangToolchain();
    findMsvcToolchain();
}