import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const workspaceFolder = mkdtempSync(join(tmpdir(), 'nbcpp-test-'));
process.once('exit', () => {
	rmSync(workspaceFolder, { recursive: true, force: true, maxRetries: 3 });
});

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
	useInstallation: process.env.VSCODE_TEST_EXECUTABLE
		? { fromPath: process.env.VSCODE_TEST_EXECUTABLE }
		: undefined,
});
