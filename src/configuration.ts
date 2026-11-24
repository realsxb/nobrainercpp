import * as path from 'path';
import type { DebugConfiguration } from 'vscode';
import type { ToolchainResult } from './toolchainFinder';

const outputName = '${fileBasenameNoExtension}.exe';
const target = '${fileDirname}/' + outputName;
const mingwTarget = 'x86_64-w64-mingw32';

function isMsvc(compiler: string) {
    return /^cl(?:\.exe)?$/i.test(path.basename(compiler));
}

function buildArgs(msvc: boolean, language: 'c' | 'cpp', targetArgs: string[]) {
    if (msvc) {
        const languageArgs = language === 'cpp' ? ['/EHsc', '/std:c++17', '/TP'] : ['/std:c17', '/TC'];
        return ['/nologo', '/Z7', '/Od', '/FC', ...languageArgs, '${file}', `/Fe${outputName}`, '/link', '/DEBUG', '/INCREMENTAL:NO'];
    }
    const linkArgs = targetArgs.length ? ['-Wno-unused-command-line-argument', '-lunwind', '--rtlib=compiler-rt', '-fuse-ld=lld'] : [];
    // The task already runs in the source directory. A relative output also works with older Windows GNU linkers in Unicode directories.
    return [...targetArgs, ...linkArgs, '-g', '-x', language === 'cpp' ? 'c++' : 'c', '${file}', '-o', outputName];
}

export function createProjectConfigs(toolchain: ToolchainResult, extensionPath: string, hasMsExtension: boolean) {
    const embedded = toolchain.toolchain === 'embedded';
    const root = path.join(extensionPath, 'lldbv1.0').replace(/\\/g, '/');
    const sysroot = `${root}/${mingwTarget}`;
    const targetArgs = embedded ? ['-target', mingwTarget, '--sysroot', sysroot, '-stdlib=libc++'] : [];
    const tasks = [];
    const configurations: DebugConfiguration[] = [];

    for (const language of ['c', 'cpp'] as const) {
        const compiler = toolchain.compilers[language];
        if (!compiler) {
            continue;
        }
        const suffix = language === 'c' ? 'C' : 'C++';
        const label = `Build ${suffix}`;
        const msvc = isMsvc(compiler);
        tasks.push({
            label, type: 'process', command: compiler, args: buildArgs(msvc, language, targetArgs),
            options: { cwd: '${fileDirname}' },
            problemMatcher: [msvc ? '$msCompile' : '$gcc'],
            group: { kind: 'build', isDefault: tasks.length === 0 },
            presentation: { reveal: 'silent', focus: false },
        });

        const common = { name: `Debug ${suffix}`, request: 'launch', program: target, cwd: '${fileDirname}', preLaunchTask: label };
        const debuggerPath = toolchain.debugger;
        const compilerBin = path.dirname(compiler);
        const searchPath = compilerBin + path.delimiter + '${env:PATH}';
        if (msvc && hasMsExtension) {
            configurations.push({ ...common, type: 'cppvsdbg', console: 'integratedTerminal' });
        } else if (!embedded && !msvc && hasMsExtension && debuggerPath && /^gdb(?:\.exe)?$/i.test(path.basename(debuggerPath))) {
            configurations.push({
                ...common, type: 'cppdbg', MIMode: 'gdb', miDebuggerPath: debuggerPath,
                externalConsole: false, environment: [{ name: 'PATH', value: searchPath }],
                setupCommands: [{ description: 'Enable pretty-printing', text: '-enable-pretty-printing', ignoreFailures: true }],
            });
        } else {
            configurations.push({ ...common, type: 'my-simple-lldb', env: { PATH: searchPath }, internalConsoleOptions: 'neverOpen' });
        }
    }

    const compilerPath = toolchain.compilers.cpp || toolchain.compilers.c || '';
    const compilerName = path.basename(compilerPath).toLowerCase();
    const family = isMsvc(compilerPath) ? 'msvc' : compilerName.includes('clang') ? 'clang' : 'gcc';
    const includePath = ['${workspaceFolder}/**'];
    if (embedded) {
        includePath.push(`${sysroot}/include/c++/v1`, `${root}/lib/clang/21/include`, `${sysroot}/include`);
    }
    return {
        tasks: { version: '2.0.0', tasks },
        launch: { version: '0.2.0', configurations },
        properties: {
            version: 4,
            configurations: [{
                name: 'Win32', compilerPath, compilerArgs: targetArgs, includePath,
                defines: ['_DEBUG', 'UNICODE', '_UNICODE'], intelliSenseMode: `windows-${family}-x64`,
                cStandard: 'c17', cppStandard: 'c++17',
            }],
        },
    };
}
