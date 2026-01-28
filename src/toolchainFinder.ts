import * as vscode from 'vscode';
// 全局状态存储

const toolchainState = {
    // 各工具链查找结果存储
    results: {
        gnu: null as { compilers: Record<string, string>, debugger?: string } | null,
        clang: null as { compilers: Record<string, string>, debugger?: string } | null,
        msvc: null as { compilers: Record<string, string>, debugger?: string } | null
        
    },
    
    
    // 工具链查找完成状态
    completed: {
        gnu: false,*
        clang: false,
        msvc: false
    },
    
    // 最终选择的工具链（用于后续调试）
    selected: null as { 
        toolchain: 'gnu' | 'clang' | 'msvc' | 'combo',
        compilers: Record<string, string>,
        debugger: string
    } | null,
    
    // 首次完整工具链（用于立即调试）
    firstComplete: null as any,
    
    // 回调队列
    callbacks: {
        onFirstComplete: [] as Function[],
        onAllComplete: [] as Function[]
    },
};
// ✅ 解决方案：直接限定为合法键
type ValidToolName = keyof typeof toolchainState.results; // "gnu" | "clang" | "msvc"

function getCompilerSafe(
    name: ValidToolName, 
    lang: string
): string | undefined {
    const tool = toolchainState.results[name]; // ✅ 类型安全
    return tool?.compilers[lang];
}

// 处理外部输入：运行时验证
function getCompilerFromInput(
    inputName: string, 
    lang: string
): string | undefined {
    
    // 1. 创建合法键常量列表
    const validNames = ["gnu", "clang", "msvc"] as const;
    
    // 2. 运行时检查
    if (validNames.includes(inputName as any)) {
        // 3. 类型断言仅在检查后使用
        return getCompilerSafe(
            inputName as ValidToolName, 
            lang
        );
    }
    
    // 4. 处理无效键情况
    console.warn(`Invalid toolchain: ${inputName}`);
    return undefined;
}
//-----------------------------------------------------------------------------以下为查找-----------------
// GNU工具链查找器
async function findGnuToolchain() {
    try {
        const gcc = await findExecutable('gcc');
        const gxx = await findExecutable('g++');
        const debugger = await findDebugger('gdb');
        
        const result = {
            compilers: {
                'c': gcc?.path,
                'cpp': gxx?.path
            },
            debugger: debugger?.path
        };
        
        onToolchainFound('gnu', result);
    } catch (error) {
        onToolchainFound('gnu', null);
    }
}

// Clang工具链查找器
async function findClangToolchain() {
    // 类似findGnuToolchain的逻辑
    // ... 
    onToolchainFound('clang', result);
}

// MSVC工具chain查找器
async function findMsvcToolchain() {
    // 类似findGnuToolchain的逻辑
    // ... 
    onToolchainFound('msvc', result);
}


//---------------------------------------------------------------------以下为核心回调
// 工具链发现回调处理
function onToolchainFound(name: 'gnu' | 'clang' | 'msvc', result: any) {
    // 更新状态
    toolchainState.results[name] = result;
    toolchainState.completed[name] = true;
    
    // 检查是否首次完整
    if (!toolchainState.firstComplete && isToolchainComplete(result)) {
        toolchainState.firstComplete = {
            toolchain: name,
            ...result
        };
        
        // 触发首次完整回调
        toolchainState.callbacks.onFirstComplete.forEach(cb => cb(toolchainState.firstComplete));
    }
    
    // 检查是否所有完成
    if (toolchainState.completed.gnu && toolchainState.completed.clang && toolchainState.completed.msvc) {
        const best = selectBestToolchain();
        toolchainState.selected = best;
        
        // 触发最终完成回调
        toolchainState.callbacks.onAllComplete.forEach(cb => cb(toolchainState.selected));
    }
}

// 工具链完整性检查
function isToolchainComplete(toolchain: any): boolean {
    return toolchain?.compilers?.['c'] && toolchain?.compilers?.['cpp'] && toolchain?.debugger;
}

// 最优工具链选择算法
function selectBestToolchain() {
    // 优先级：GNU > Clang > MSVC
    const  order = ['gnu', 'clang', 'msvc'];
    
    // 尝试获取第一套完整工具链
    for (const name of order) {
        const chain = toolchainState.results[name];
        if (isToolchainComplete(chain)) {
            return {
                toolchain: name,
                ...chain
            };
        }
    }
    
    // 如果无完整工具链，组装第一套完整的组合链
    return createComboToolchain();
}

// 组合工具链创建器（按优先级组装第一套完整工具链）
function createComboToolchain() {
    const parts = {
        cCompiler: null as any,
        cppCompiler: null as any,
        debugger: null as any
    };
    
    // 查找C编译器（优先级：gnu > clang > msvc）
    if (toolchainState.results.gnu?.compilers?.c) {
        parts.cCompiler = toolchainState.results.gnu.compilers.c;
    } else if (toolchainState.results.clang?.compilers?.c) {
        parts.cCompiler = toolchainState.results.clang.compilers.c;
    } else if (toolchainState.results.msvc?.compilers?.c) {
        parts.cCompiler = toolchainState.results.msvc.compilers.c;
    }
    
    // 查找C++编译器（同优先级顺序）
    if (toolchainState.results.gnu?.compilers?.cpp) {
        parts.cppCompiler = toolchainState.results.gnu.compilers.cpp;
    } // ... 其他类似
    
    // 查找调试器（同优先级顺序）
    if (toolchainState.results.gnu?.debugger) {
        parts.debugger = toolchainState.results.gnu.debugger;
    } // ... 其他类似
    
    return {
        toolchain: 'combo',
        compilers: {
            c: parts.cCompiler,
            cpp: parts.cppCompiler
        },
        debugger: parts.debugger
    };
}
//--------------------------------------------------------------------以下为回调注册和启动
// 注册回调函数
function registerFirstCompletionCallback(callback: (toolchain: any) => void) {
    toolchainState.callbacks.onFirstComplete.push(callback);
    
    // 如果首次完成已发送，立即触发
    if (toolchainState.firstComplete) {
        callback(toolchainState.firstComplete);
    }
}

// 注册最终回调
function registerCompletionCallback(callback: (toolchain: any) => void) {
    toolchainState.callbacks.onAllComplete.push(callback);
    
    // 如果全部已完成，立即触发
    if (toolchainState.completed.gnu && toolchainState.completed.clang && toolchainState.completed.msvc) {
        callback(toolchainState.selected);
    }
}

// 启动所有查找
function startToolchainDiscovery() {
    // 重置状态
    toolchainState.results.gnu = null;
    toolchainState.results.clang = null;
    toolchainState.results.msvc = null;
    toolchainState.completed.gnu = false;
    toolchainState.completed.clang = false;
    toolchainState.completed.msvc = false;
    toolchainState.firstComplete = null;
    toolchainState.selected = null;
    toolchainState.callbacks.onFirstComplete = [];
    toolchainState.callbacks.onAllComplete = [];
    
    // 并行启动所有查找
    findGnuToolchain();
    findClangToolchain();
    findMsvcToolchain();
}
