// Launches the real app and saves a screenshot (docs/screenshot.png by default)
// using the GITDL_SHOT hook in the main process. Portable across shells, unlike
// setting the env var inline.
//
//   npm run screenshot
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const target = process.argv[2] ?? path.join('docs', 'screenshot.png');

const child = spawn(electronPath, ['.'], {
  cwd: ROOT,
  env: { ...process.env, GITDL_SHOT: target },
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
