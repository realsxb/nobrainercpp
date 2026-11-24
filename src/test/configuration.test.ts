import * as assert from 'assert/strict';
import * as path from 'path';
import { createProjectConfigs } from '../configuration';

suite('Generated project configurations', () => {
    const bin = path.join('tool chains', 'bin');
    const gcc = path.join(bin, 'gcc.exe');
    const cl = path.join(bin, 'cl.exe');
    const gdb = path.join(bin, 'gdb.exe');

    test('mixed system tools use the selected language’s compiler and compatible adapter', () => {
        const project = createProjectConfigs({ toolchain: 'combo', compilers: { c: gcc, cpp: cl }, debugger: gdb }, '', true);
        const [c, cpp] = project.tasks.tasks;
        assert.equal(c.type, 'process');
        assert.equal(c.command, gcc);
        assert.deepEqual(c.args.slice(c.args.indexOf('-x'), c.args.indexOf('-x') + 2), ['-x', 'c']);
        assert.deepEqual(c.args.slice(-2), ['-o', '${fileBasenameNoExtension}.exe']);
        assert.equal(cpp.command, cl);
        assert.ok(cpp.args.includes('/TP') && cpp.args.includes('/DEBUG'));
        const [cDebug, cppDebug] = project.launch.configurations;
        assert.equal(cDebug.preLaunchTask, c.label);
        assert.equal(cDebug.miDebuggerPath, gdb);
        assert.equal(cDebug.type, 'cppdbg');
        assert.equal(cppDebug.preLaunchTask, cpp.label);
        assert.equal(cppDebug.type, 'cppvsdbg');
    });

    test('plain LLDB is never passed to the MI adapter, and C-only tools only produce C tasks', () => {
        const clang = path.join(bin, 'clang.exe');
        const project = createProjectConfigs({ toolchain: 'clang', compilers: { c: clang }, debugger: path.join(bin, 'lldb.exe') }, '', true);
        assert.deepEqual(project.tasks.tasks.map(task => task.label), ['Build C']);
        assert.deepEqual(project.launch.configurations.map(config => config.name), ['Debug C']);
        const [config] = project.launch.configurations;
        assert.equal(config.type, 'my-simple-lldb');
        assert.equal(config.env.PATH, bin + path.delimiter + '${env:PATH}');
        assert.equal(project.properties.configurations[0].intelliSenseMode, 'windows-clang-x64');
    });
});
