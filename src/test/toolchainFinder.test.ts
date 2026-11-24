import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverToolchains, getFastestToolchain, setExtensionPath, ToolchainResult } from '../toolchainFinder';

const empty: ToolchainResult = { toolchain: 'msvc', compilers: {} };
const gnu: ToolchainResult = { toolchain: 'gnu', compilers: { c: 'gcc', cpp: 'g++' }, debugger: 'gdb' };
const clang: ToolchainResult = { toolchain: 'clang', compilers: { c: 'clang', cpp: 'clang++' }, debugger: 'lldb' };
const embedded: ToolchainResult = { ...clang, toolchain: 'embedded', debugger: 'lldb-dap' };

suite('Toolchain discovery', () => {
    test('can start with Clang while GNU is probing, then prefers the complete GNU family', async () => {
        let finishGnu!: (value: ToolchainResult) => void;
        const delayedGnu = new Promise<ToolchainResult>(resolve => { finishGnu = resolve; });
        const search = discoverToolchains(
            async family => ({ gnu: delayedGnu, clang, msvc: empty })[family],
            async () => assert.fail('a complete system toolchain needs no fallback')
        );
        assert.strictEqual(await search.first('cpp'), clang);
        assert.strictEqual(search.cached('cpp'), undefined);
        finishGnu(gnu);
        await search.complete;
        assert.strictEqual(search.cached('cpp'), gnu);
    });

    test('retains debugger-only results and combines the available tools in priority order', async () => {
        const search = discoverToolchains(
            async family => ({
                gnu: { toolchain: 'gnu', compilers: {}, debugger: 'gdb' },
                clang: { toolchain: 'clang', compilers: clang.compilers },
                msvc: empty
            } as const)[family], async () => undefined
        );
        const actual = await search.first('cpp');
        assert.deepStrictEqual(actual, { toolchain: 'combo', compilers: clang.compilers, debugger: 'gdb' });
    });

    test('a C-only compiler cannot win a C++ request; the bundle can fill that language', async () => {
        const cOnly: ToolchainResult = { ...gnu, compilers: { c: 'gcc' } };
        const search = discoverToolchains(async family => family === 'gnu' ? cOnly : empty, async () => embedded);
        const [c, cpp] = await Promise.all([search.first('c'), search.first('cpp')]);
        assert.strictEqual(c, cOnly);
        assert.strictEqual(cpp, embedded);
    });

    test('retries a missing compiler and a removed cached executable, honouring PATH order', async () => {
        const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nbcpp-discovery-'));
        const oldPath = process.env.PATH;
        const first = path.join(temp, 'first bin');
        const second = path.join(temp, 'second bin');
        try {
            await fs.mkdir(first);
            await fs.mkdir(second);
            const filename = process.platform === 'win32' ? 'g++.exe' : 'g++';
            const preferred = path.join(first, filename);
            const backup = path.join(second, filename);
            setExtensionPath(temp);
            process.env.PATH = [first, second].join(path.delimiter);
            assert.strictEqual((await getFastestToolchain('cpp')).compilers.cpp, undefined);

            await fs.writeFile(preferred, '', { mode: 0o755 });
            await fs.writeFile(backup, '', { mode: 0o755 });
            assert.strictEqual((await getFastestToolchain('cpp')).compilers.cpp, preferred);
            await fs.unlink(preferred);
            assert.strictEqual((await getFastestToolchain('cpp')).compilers.cpp, backup);
        } finally {
            if (oldPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = oldPath;
            }
            setExtensionPath(path.resolve(__dirname, '../..'));
            await fs.rm(temp, { recursive: true, force: true });
        }
    });
});
