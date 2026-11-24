import * as assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';

async function waitFor<T>(description: string, value: () => T | undefined): Promise<T> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const result = value();
		if (result !== undefined) {
			return result;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

suite('Debugging without Microsoft C/C++', function () {
	this.timeout(120_000);

	for (const language of ['c', 'cpp'] as const) {
		test(`${language}: Smart Run, then F5, with breakpoints, stepping and terminal input`, async function () {
			if (process.platform !== 'win32' || process.arch !== 'x64') {
				this.skip();
			}
			assert.equal(vscode.extensions.getExtension('ms-vscode.cpptools'), undefined);
			const folder = vscode.workspace.workspaceFolders?.[0];
			assert.ok(folder, 'The test runner must open an isolated workspace.');
			const source = vscode.Uri.joinPath(folder.uri, `first program.${language}`);
			const resultPath = join(folder.uri.fsPath, 'result.txt');
			const program = language === 'cpp' ? [
				'#include <fstream>',
				'#include <iostream>',
				'int main() {',
				'    int value = 0;',
				'    std::cin >> value;',
				'    value += 2;',
				'    std::ofstream("result.txt") << value;',
				'    return value == 42 ? 0 : 1;',
				'}',
			] : [
				'#include <stdio.h>',
				'',
				'int main(void) {',
				'    int value = 0;',
				'    scanf("%d", &value);',
				'    value += 2;',
				'    FILE *output = fopen("result.txt", "w");',
				'    if (!output) return 1;',
				'    fprintf(output, "%d", value);',
				'    fclose(output);',
				'    return 0;',
				'}',
			];
			await writeFile(source.fsPath, program.join('\n'));
			const document = await vscode.workspace.openTextDocument(source);
			const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(4, 0)));
			vscode.debug.addBreakpoints([breakpoint]);
			const sessions: vscode.DebugSession[] = [];
			const compilers: string[] = [];
			const stops: { reason: string; threadId: number }[] = [];
			const ended = new Set<string>();
			const disposables = [
				vscode.tasks.onDidStartTask(({ execution }) => {
					const definition = execution.task.definition;
					if (definition.type === 'nobrainercpp') {
						compilers.push(definition.compiler);
					}
				}),
				vscode.debug.onDidTerminateDebugSession(session => ended.add(session.id)),
				vscode.debug.registerDebugAdapterTrackerFactory('my-simple-lldb', {
					createDebugAdapterTracker(session) {
						sessions.push(session);
						return {
							onDidSendMessage(message) {
								if (message.type === 'event' && message.event === 'stopped') {
									stops.push(message.body);
								}
							},
						};
					},
				}),
			];

			const originalPath = process.env.PATH;
			if (language === 'cpp') {
				// Exercise the bundled compiler even on development machines with MinGW.
				process.env.PATH = join(process.env.SystemRoot!, 'System32');
			}
			try {
				const commands = ['extension.autoDebug', 'workbench.action.debug.start'];
				if (language === 'c') {
					commands.unshift('workbench.action.debug.start'); // F5 in a new folder, before Smart Run.
				}
				for (const [index, command] of commands.entries()) {
					await vscode.window.showTextDocument(document);
					await writeFile(resultPath, '');
					stops.length = 0;
					const [, stop] = await Promise.all([
						vscode.commands.executeCommand(command),
						waitFor(`${command} source breakpoint`, () => stops.find(s => s.reason === 'breakpoint')),
					]);
					assert.equal(sessions.length, index + 1, 'Each run should start exactly one debug adapter.');
					assert.equal(compilers.length, index + 1, 'Each run should compile the active source exactly once.');
					if (language === 'cpp') {
						assert.match(compilers[index], /lldbv1\.0[\\/]bin[\\/]clang\+\+\.exe$/i);
					}
					const session = sessions[index];
					const stack = await session.customRequest('stackTrace', { threadId: stop.threadId });
					assert.equal(basename(stack.stackFrames[0].source.path), basename(source.fsPath));
					assert.equal(stack.stackFrames[0].line, 5);

					const terminal = await waitFor('integrated program terminal', () =>
						vscode.window.terminals.find(t => t.name.includes('first program.exe')));
					terminal.sendText('40');
					await session.customRequest('next', { threadId: stop.threadId });
					const step = await waitFor('step past stdin', () => stops.find(s => s.reason === 'step'));
					const afterInput = await session.customRequest('stackTrace', { threadId: step.threadId });
					assert.equal(afterInput.stackFrames[0].line, 6);
					await session.customRequest('continue', { threadId: step.threadId });
					await waitFor('program termination', () => ended.has(session.id) || undefined);
					assert.equal(await readFile(resultPath, 'utf8'), '42');
				}
			} finally {
				if (originalPath === undefined) {
					delete process.env.PATH;
				} else {
					process.env.PATH = originalPath;
				}
				vscode.debug.removeBreakpoints([breakpoint]);
				for (const session of sessions) {
					if (!ended.has(session.id)) {
						await vscode.debug.stopDebugging(session);
					}
				}
				disposables.forEach(disposable => disposable.dispose());
			}
		});
	}
	test('Restart replaces a stopped target and Stop releases it for a rebuild', async function () {
		if (process.platform !== 'win32' || process.arch !== 'x64') {
			this.skip();
		}
		const folder = vscode.workspace.workspaceFolders![0];
		const source = vscode.Uri.joinPath(folder.uri, 'restart.c');
		const marker = join(folder.uri.fsPath, 'running.txt');
		await writeFile(source.fsPath, [
			'#include <stdio.h>',
			'#include <process.h>',
			'int main(void) {',
			'    FILE *out = fopen("running.txt", "w");',
			'    fprintf(out, "%d 1", _getpid());',
			'    fclose(out);',
			'    return getchar();',
			'}',
		].join('\n'));
		const document = await vscode.workspace.openTextDocument(source);
		const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(6, 0)));
		vscode.debug.addBreakpoints([breakpoint]);
		const stops: vscode.DebugSession[] = [];
		const tracker = vscode.debug.registerDebugAdapterTrackerFactory('my-simple-lldb', {
			createDebugAdapterTracker(session) {
				return {
					onDidSendMessage(message) {
						if (message.event === 'stopped' && message.body?.reason === 'breakpoint') {
							stops.push(session);
						}
					}
				};
			}
		});
		async function startAtBreakpoint(command: string) {
			const index = stops.length;
			await vscode.window.showTextDocument(document);
			const [, session] = await Promise.all([
				vscode.commands.executeCommand(command),
				waitFor(`${command} breakpoint`, () => stops[index]),
			]);
			const [pid, version] = (await readFile(marker, 'utf8')).split(' ').map(Number);
			assert.ok(pid > 0);
			return { pid, version, session };
		}
		async function waitForExit(pid: number) {
			await waitFor(`PID ${pid} to exit`, () => {
				try { process.kill(pid, 0); } catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return true; }
					throw error;
				}
			});
		}

		try {
			const first = await startAtBreakpoint('extension.autoDebug');
			const restarted = await startAtBreakpoint('workbench.action.debug.restart');
			assert.notEqual(first.pid, restarted.pid);
			await waitForExit(first.pid);
			await vscode.debug.stopDebugging(restarted.session);
			await waitForExit(restarted.pid);

			const editor = await vscode.window.showTextDocument(document);
			await editor.edit(edit => edit.replace(document.lineAt(4).range, '    fprintf(out, "%d 2", _getpid());'));
			const rebuilt = await startAtBreakpoint('extension.autoDebug');
			assert.equal(rebuilt.version, 2);
			await vscode.debug.stopDebugging(rebuilt.session);
			await waitForExit(rebuilt.pid);
		} finally {
			vscode.debug.removeBreakpoints([breakpoint]);
			if (vscode.debug.activeDebugSession) {
				await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
			}
			tracker.dispose();
		}
	});
});
