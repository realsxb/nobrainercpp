import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path'; // 新增引用

// --- 类型定义 ---
// 新增 'embedded' 类型
export interface ToolchainResult {
    toolchain: 'gnu' | 'clang' | 'msvc' | 'combo' | 'embedded';
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
// 新增 extensionPath 用于定位内嵌文件
let globalExtensionPath: string = '';

export function setExtensionPath(path: string) {
    globalExtensionPath = path;
}

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
        const command = platform === 'win32' ? `where ${binName}` : `which ${binName}`;
        
        childProcess.exec(command, (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }
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
// ... (GNU, Clang, MSVC 的查找逻辑保持不变，为了节省篇幅省略，请保留原有的 findGnu, findClang, findMsvc) ...

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
        if (result.compilers.c || result.compilers.cpp) {
            onToolchainFound('gnu', result);
        } else {
            onToolchainFound('gnu', null);
        }
    } catch { onToolchainFound('gnu', null); }
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
    } catch { onToolchainFound('clang', null); }
}

async function findMsvcToolchain() {
    try {
        const cl = await findExecutable('cl');
        if (cl) {
            onToolchainFound('msvc', {
                compilers: { c: cl, cpp: cl },
                debugger: undefined 
            });
        } else {
            onToolchainFound('msvc', null);
        }
    } catch { onToolchainFound('msvc', null); }
}

// --- 状态更新与回调触发 ---

function onToolchainFound(name: 'gnu' | 'clang' | 'msvc', result: ToolchainDiscoveryResult | null) {
    toolchainState.results[name] = result;
    toolchainState.completed[name] = true;

    // 1. 尝试触发“最快可用”
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
    if (type === 'onFirstComplete') {
        toolchainState.callbacks[type] = [];
    }
    cbs.forEach(cb => cb(data));
}

// --- 决策算法 (重点修改部分) ---

// src/toolchainFinder.ts 的 getEmbeddedToolchain 函数

function getEmbeddedToolchain(): ToolchainResult | null {
    if (!globalExtensionPath) {return null;}

    // 结构：lldbv1.0/bin/clang.exe
    const binDir = path.join(globalExtensionPath, 'lldbv1.0', 'bin');
    const clang = path.join(binDir, 'clang.exe');
    const clangxx = path.join(binDir, 'clang++.exe'); // 如果你是用 clang 调用的，这里也可以指向 clang.exe
    const lldb = path.join(binDir, 'lldb-dap.exe'); // 指向 DAP

    if (fs.existsSync(clang)) {
        return {
            toolchain: 'embedded',
            compilers: {
                c: clang,
                cpp: clangxx // 如果没有 clang++.exe，可以用 clang.exe
            },
            debugger: lldb
        };
    }
    return null;
}

function selectBestToolchain(): ToolchainResult {
    // 1. 优先查找系统原本就有的完整工具链 (GNU > Clang > MSVC)
    const order = ['gnu', 'clang', 'msvc'] as const;
    for (const name of order) {
        const res = toolchainState.results[name];
        if (res && res.compilers.cpp && res.debugger) {
            return { toolchain: name, ...res };
        }
    }

    // 2. 尝试拼凑系统工具链
    const combo = createComboToolchain();
    // 如果拼凑出来至少有个编译器，就用拼凑的
    if (combo.compilers.c || combo.compilers.cpp) {
        return combo;
    }

    // 3. 【新逻辑】如果系统里啥都没有，启用内嵌工具链兜底
    const embedded = getEmbeddedToolchain();
    if (embedded) {
        return embedded;
    }

    // 4. 实在没有，只能返回空的 combo
    return combo;
}

function createComboToolchain(): ToolchainResult {
    let c, cpp, dbg;
    const order = ['gnu', 'clang', 'msvc'] as const;
    for (const name of order) {
        const res = toolchainState.results[name];
        if (!res) {continue;}
        if (!c && res.compilers.c) {c = res.compilers.c;}
        if (!cpp && res.compilers.cpp) {cpp = res.compilers.cpp;}
        if (!dbg && res.debugger) {dbg = res.debugger;}
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
        if (toolchainState.selected) {
            resolve(toolchainState.selected);
            return;
        }
        if (toolchainState.firstComplete) {
            resolve(toolchainState.firstComplete);
            return;
        }
        toolchainState.callbacks.onFirstComplete.push(resolve);
        toolchainState.callbacks.onAllComplete.push((res) => resolve(res));

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