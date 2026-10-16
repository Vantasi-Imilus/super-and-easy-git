#!/usr/bin/env node
// 超级易用 Git 下载器（Super and Easy Git）的命令行入口。
// Headless CLI over the engine, useful for debugging without the GUI.
//
//   node bin/gitdl.js detect
//   node bin/gitdl.js single <url> [--dir D] [--depth N] [--filter blob:none] [--jobs N]
//   node bin/gitdl.js batch <urls.txt|-> [--concurrency N] [--depth N] [--filter F] [--jobs N] [--dir D]
//   node bin/gitdl.js http <url> [--dir D] [--concurrency N] [--sha256 HEX]
//   node bin/gitdl.js bigfile-push <file> --repo <url> [--shards N] [--chunk-size MB]
//   node bin/gitdl.js bigfile-pull <repoUrl> --file NAME --out PATH [--concurrency N]
import path from 'node:path';
import fsp from 'node:fs/promises';
import { isAbortError } from '../src/engine/proc.js';
import { detectGit } from '../src/engine/git-detect.js';
import { downloadRepo } from '../src/engine/single-repo.js';
// batch / http / bigfile engines are imported lazily so that a mode whose
// engine is not present yet cannot break the others.

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i += 1;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function num(value, fallback) {
  return value === undefined ? fallback : Number(value);
}

const useTty = process.stdout.isTTY;
let lastLine = 0;
function statusLine(text) {
  if (useTty) {
    process.stdout.write(`\r\x1b[K${text}`);
    lastLine = 1;
  }
}
function clearStatus() {
  if (useTty && lastLine) {
    process.stdout.write('\r\x1b[K');
    lastLine = 0;
  }
}
function println(text = '') {
  clearStatus();
  console.log(text);
}

function progressText(snapshot) {
  const parts = [];
  if (snapshot.percent != null) parts.push(`${(snapshot.percent * 100).toFixed(1)}%`);
  if (snapshot.total > 0) parts.push(`对象 ${snapshot.count}/${snapshot.total}`);
  if (snapshot.speed) parts.push(`${(snapshot.speed / 1024 / 1024).toFixed(2)} MiB/s${snapshot.speedPartial ? '+' : ''}`);
  else if (snapshot.objectsPerSec) parts.push(`${snapshot.objectsPerSec.toFixed(0)} 对象/秒`);
  parts.push(`${snapshot.workers} 连接`);
  return parts.join(' · ');
}

function printEvent(event) {
  if (event.type === 'phase') statusLine(`[阶段] ${event.text}`);
  else if (event.type === 'log') println(`[${event.level ?? 'info'}] ${event.text}`);
  else if (event.type === 'fallback') println(`[回退] ${event.text}`);
  else if (event.type === 'progress') statusLine(progressText(event.snapshot));
}

const controller = new AbortController();
process.on('SIGINT', () => {
  console.error('\n收到中断信号，正在停止…');
  controller.abort();
});

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  switch (command) {
    case 'detect': {
      const det = await detectGit(flags.git ?? 'git');
      println(JSON.stringify(det, null, 2));
      return det.ok ? 0 : 1;
    }
    case 'single': {
      const url = positional[1];
      if (!url) throw new Error('用法: gitdl single <url> [--dir D] [--depth N] [--filter F] [--jobs N]');
      const depth = num(flags.depth, 0);
      const filter = flags.filter && flags.filter !== 'none' ? String(flags.filter) : null;
      const result = await downloadRepo({
        url,
        dir: flags.dir ? path.resolve(String(flags.dir)) : undefined,
        baseDir: path.resolve(String(flags.into ?? '.')),
        depth,
        filter,
        jobs: num(flags.jobs, 4),
        branches: flags['default-branch-only'] ? 'default' : 'all',
        includeTags: flags['no-tags'] ? false : true,
        recursiveSubmodules: Boolean(flags.submodules),
        proxy: flags.proxy ? String(flags.proxy) : null,
        checkoutRef: flags.ref ? String(flags.ref) : null,
        signal: controller.signal,
      }, printEvent);
      println(`完成：${result.dir}`);
      println(`  HEAD=${result.head}${result.branch ? ` 分支=${result.branch}` : ''} 浅克隆=${result.shallow ? '是' : '否'} 耗时=${(result.elapsedMs / 1000).toFixed(1)}s`);
      return 0;
    }
    case 'batch': {
      const { downloadBatch } = await import('../src/engine/batch.js');
      const source = positional[1];
      if (!source) throw new Error('用法: gitdl batch <urls.txt|-> [--concurrency N]');
      const text = source === '-'
        ? await readStdin()
        : await fsp.readFile(source, 'utf8');
      const urls = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const filter = flags.filter && flags.filter !== 'none' ? String(flags.filter) : null;
      const modeFlags = {
        depth: num(flags.depth, 0),
        filter,
        jobs: num(flags.jobs, 4),
        includeTags: flags['no-tags'] ? false : true,
        recursiveSubmodules: Boolean(flags.submodules),
        proxy: flags.proxy ? String(flags.proxy) : null,
      };
      const result = await downloadBatch({
        urls,
        baseDir: path.resolve(String(flags.dir ?? '.')),
        concurrency: num(flags.concurrency, 3),
        repoOptions: modeFlags,
        signal: controller.signal,
      }, (event) => {
        if (event.type === 'task') {
          println(`[${event.task.state}] ${event.task.url}${event.task.error ? ` — ${event.task.error}` : ''}`);
        } else if (event.type === 'aggregate') {
          statusLine(`总进度 ${(event.aggregate.percent * 100).toFixed(1)}% · 完成 ${event.aggregate.done}/${event.aggregate.total} · 失败 ${event.aggregate.failed} · ${event.aggregate.active} 个下载中`);
        }
      });
      clearStatus();
      println(`批量完成：成功 ${result.succeeded}，失败 ${result.failed}，共 ${result.total}`);
      return result.failed > 0 ? 1 : 0;
    }
    case 'http': {
      const { httpDownload } = await import('../src/engine/http/downloader.js');
      const url = positional[1];
      if (!url) throw new Error('用法: gitdl http <url> [--dir D] [--concurrency N] [--sha256 HEX]');
      const result = await httpDownload({
        url,
        dir: flags.dir ? path.resolve(String(flags.dir)) : process.cwd(),
        concurrency: num(flags.concurrency, 4),
        expectedSha256: flags.sha256 ? String(flags.sha256) : null,
        proxy: flags.proxy ? String(flags.proxy) : null,
        signal: controller.signal,
      }, (event) => {
        if (event.type === 'progress') {
          statusLine(`${event.snapshot.percent != null ? `${(event.snapshot.percent * 100).toFixed(1)}% · ` : ''}${(event.snapshot.bytes / 1024 / 1024).toFixed(1)} MiB · ${(event.snapshot.bytesPerSec / 1024 / 1024).toFixed(2)} MiB/s · ${event.snapshot.connections} 连接`);
        } else if (event.type === 'log') println(`[${event.level ?? 'info'}] ${event.text}`);
      });
      println(`完成：${result.file}（${result.bytes} 字节）`);
      return 0;
    }
    case 'bigfile-push': {
      const { publishBigFile } = await import('../src/engine/bigfile/split.js');
      const file = positional[1];
      const repo = flags.repo;
      if (!file || !repo) throw new Error('用法: gitdl bigfile-push <file> --repo <url> [--shards N] [--chunk-size MiB] [--workdir D]');
      const result = await publishBigFile({
        file: path.resolve(file),
        repoUrl: String(repo),
        shards: num(flags.shards, 8),
        chunkSize: num(flags['chunk-size'], 32) * 1024 * 1024,
        workdir: flags.workdir ? path.resolve(String(flags.workdir)) : null,
        signal: controller.signal,
      }, (event) => {
        if (event.type === 'log') println(`[${event.level ?? 'info'}] ${event.text}`);
        else if (event.type === 'progress') statusLine(`[发布] ${event.text} ${event.percent != null ? `${(event.percent * 100).toFixed(0)}%` : ''}`);
      });
      println(`发布完成：${result.chunks} 个分片，manifest 位于 ${result.branch} 分支`);
      return 0;
    }
    case 'bigfile-pull': {
      const { pullBigFile } = await import('../src/engine/bigfile/pull.js');
      const repoUrl = positional[1];
      const file = flags.file;
      const out = flags.out;
      if (!repoUrl || !file || !out) throw new Error('用法: gitdl bigfile-pull <repoUrl> --file NAME --out PATH [--concurrency N]');
      const result = await pullBigFile({
        repoUrl,
        file: String(file),
        out: path.resolve(String(out)),
        concurrency: num(flags.concurrency, 8),
        workdir: flags.workdir ? path.resolve(String(flags.workdir)) : null,
        proxy: flags.proxy ? String(flags.proxy) : null,
        signal: controller.signal,
      }, (event) => {
        if (event.type === 'log') println(`[${event.level ?? 'info'}] ${event.text}`);
        else if (event.type === 'progress') statusLine(`[拉取] ${event.text}`);
      });
      println(`完成：${result.file}（${result.bytes} 字节，sha256 ${result.sha256.slice(0, 12)}…）`);
      return 0;
    }
    default:
      println('用法: gitdl <detect|single|batch|http|bigfile-push|bigfile-pull> ...');
      return 1;
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

main()
  .then((code) => {
    clearStatus();
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    clearStatus();
    if (isAbortError(err)) {
      console.error('已取消');
      process.exitCode = 130;
      return;
    }
    console.error(`错误：${err.message}`);
    process.exitCode = 1;
  });
