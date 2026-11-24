import { constants, promises as fs } from 'fs';
import * as path from 'path';

const families = ['gnu', 'clang', 'msvc'] as const;
type Family = typeof families[number];
type Language = 'c' | 'cpp';

export interface ToolchainResult {
    toolchain: Family | 'combo' | 'embedded';
    compilers: Partial<Record<Language, string>>;
    debugger?: string;
}

type FamilyResults = Partial<Record<Family, ToolchainResult>>;

async function isExecutable(file: string): Promise<boolean> {
    try {
        if (!(await fs.stat(file)).isFile()) {
            return false;
        }
        if (process.platform !== 'win32') {
            await fs.access(file, constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}

function pathDirectories(searchPath: string): string[] {
    const paths = new Map<string, string>();
    for (const entry of searchPath.split(path.delimiter)) {
        const directory = entry.replace(/^"|"$/g, '');
        // Do not discover a compiler relative to the extension host's working directory.
        if (path.isAbsolute(directory)) {
            const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
            if (!paths.has(key)) {
                paths.set(key, directory);
            }
        }
    }
    return [...paths.values()];
}

async function findExecutable(directories: string[], name: string): Promise<string | undefined> {
    const filename = process.platform === 'win32' ? name + '.exe' : name;
    for (const directory of directories) {
        const candidate = path.join(directory, filename);
        if (await isExecutable(candidate)) {
            return candidate;
        }
    }
}

async function probeFamily(family: Family, directories: string[], msvcEnvironment: boolean): Promise<ToolchainResult> {
    if (family === 'msvc') {
        // A bare cl.exe on PATH without the VC headers and libraries cannot build a beginner's program.
        const cl = msvcEnvironment ? await findExecutable(directories, 'cl') : undefined;
        return { toolchain: family, compilers: { c: cl, cpp: cl } };
    }
    const names = family === 'gnu' ? ['gcc', 'g++', 'gdb'] : ['clang', 'clang++', 'lldb'];
    const [c, cpp, debuggerPath] = await Promise.all(names.map(name => findExecutable(directories, name)));
    return { toolchain: family, compilers: { c, cpp }, debugger: debuggerPath };
}

async function probeEmbedded(extensionPath: string): Promise<ToolchainResult | undefined> {
    if (!extensionPath || process.platform !== 'win32') {
        return undefined;
    }
    const directories = [path.join(extensionPath, 'lldbv1.0', 'bin')];
    const [c, cpp, debuggerPath] = await Promise.all(
        ['clang', 'clang++', 'lldb-dap'].map(name => findExecutable(directories, name))
    );
    if (debuggerPath && (c || cpp)) {
        return { toolchain: 'embedded', compilers: { c, cpp }, debugger: debuggerPath };
    }
}

function selectSystem(results: FamilyResults, language: Language): ToolchainResult {
    const found = families.map(name => results[name]).filter(tool => tool !== undefined);
    const complete = found.find(tool => tool.compilers.c && tool.compilers.cpp && tool.debugger);
    if (complete) {
        return complete;
    }

    const matched = found.find(tool => tool.compilers[language] && tool.debugger);
    const c = matched?.compilers.c ? matched : found.find(tool => tool.compilers.c);
    const cpp = matched?.compilers.cpp ? matched : found.find(tool => tool.compilers.cpp);
    const debug = matched ?? found.find(tool => tool.debugger);
    const sources = [c, cpp, debug].filter(tool => tool !== undefined);
    if (sources.length && sources.every(tool => tool === sources[0])) {
        return sources[0];
    }
    return {
        toolchain: 'combo',
        compilers: { c: c?.compilers.c, cpp: cpp?.compilers.cpp },
        debugger: debug?.debugger
    };
}

// Each family produces one snapshot. The first usable snapshot may start a session
// while the remaining probes continue to determine the preferred result for the next run.
export function discoverToolchains(
    probe: (family: Family) => Promise<ToolchainResult>,
    embedded: () => Promise<ToolchainResult | undefined>
) {
    const results: FamilyResults = {};
    const snapshots = families.map(async family => {
        results[family] = await probe(family);
        return { ...results };
    });
    let preferred: Record<Language, ToolchainResult> | undefined;
    const complete = Promise.all(snapshots).then(async () => {
        const c = selectSystem(results, 'c');
        const cpp = selectSystem(results, 'cpp');
        const fallback = (!c.compilers.c || !cpp.compilers.cpp) ? await embedded() : undefined;
        preferred = {
            c: !c.compilers.c && fallback?.compilers.c ? fallback : c,
            cpp: !cpp.compilers.cpp && fallback?.compilers.cpp ? fallback : cpp
        };
        return preferred;
    });
    return {
        complete,
        cached: (language: Language) => preferred?.[language],
        first(language: Language): Promise<ToolchainResult> {
            return new Promise((resolve, reject) => {
                for (const snapshot of snapshots) {
                    snapshot.then(found => {
                        const candidate = selectSystem(found, language);
                        if (candidate.compilers[language] && candidate.debugger) {
                            resolve(candidate);
                        }
                    }, reject);
                }
                complete.then(best => resolve(best[language]), reject);
            });
        }
    };
}

let extensionPath = '';
let cachedSearch: { key: string; discovery: ReturnType<typeof discoverToolchains> } | undefined;

export function setExtensionPath(directory: string): void {
    if (extensionPath !== directory) {
        extensionPath = directory;
        cachedSearch = undefined;
    }
}

export async function getFastestToolchain(language: Language = 'cpp'): Promise<ToolchainResult> {
    const searchPath = process.env.PATH ?? '';
    const msvcEnvironment = process.platform === 'win32' && !!process.env.INCLUDE && !!process.env.LIB;
    const key = JSON.stringify([searchPath, msvcEnvironment]);
    const previous = cachedSearch;
    if (previous?.key === key) {
        const selected = previous.discovery.cached(language);
        if (!selected) {
            return previous.discovery.first(language);
        }
        const compiler = selected.compilers[language];
        if (compiler && await isExecutable(compiler) && (!selected.debugger || await isExecutable(selected.debugger))) {
            return selected;
        }
        // A concurrent caller may already have started the new search.
        if (cachedSearch !== previous) {
            return getFastestToolchain(language);
        }
    }
    const directories = pathDirectories(searchPath);
    const root = extensionPath;
    const discovery = discoverToolchains(
        family => probeFamily(family, directories, msvcEnvironment),
        () => probeEmbedded(root)
    );
    cachedSearch = { key, discovery };
    return discovery.first(language);
}
