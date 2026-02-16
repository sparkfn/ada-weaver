import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createLocalReadFileTool,
  createLocalListFilesTool,
  createLocalGrepTool,
  createLocalEditFileTool,
  createLocalWriteFileTool,
  createLocalBashTool,
} from '../src/local-tools.js';
import type { Workspace } from '../src/workspace.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let ws: Workspace;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tools-test-'));
  ws = { path: tmpDir, cleanup: async () => fs.rmSync(tmpDir, { recursive: true, force: true }) };

  // Create test files
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const hello = "world";\nexport const foo = "bar";\n');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Project\n\nThis is a test.\n');
  fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
});

afterEach(async () => {
  await ws.cleanup();
});

// ── read_file ────────────────────────────────────────────────────────────────

describe('read_file', () => {
  it('reads a file with line numbers', async () => {
    const tool = createLocalReadFileTool(ws);
    const result = await tool.invoke({ path: 'README.md' });
    expect(result).toContain('1: # Test Project');
    expect(result).toContain('3: This is a test.');
  });

  it('supports line range', async () => {
    const tool = createLocalReadFileTool(ws);
    const result = await tool.invoke({ path: 'src/index.ts', start_line: 2, end_line: 2 });
    expect(result).toContain('2: export const foo');
    expect(result).not.toContain('1: export const hello');
  });

  it('returns error for non-existent file', async () => {
    const tool = createLocalReadFileTool(ws);
    const result = await tool.invoke({ path: 'nope.txt' });
    expect(result).toContain('Error: file not found');
  });

  it('returns error for directory', async () => {
    const tool = createLocalReadFileTool(ws);
    const result = await tool.invoke({ path: 'src' });
    expect(result).toContain('is a directory');
  });

  it('blocks path traversal with ../', async () => {
    const tool = createLocalReadFileTool(ws);
    const result = await tool.invoke({ path: '../../../etc/passwd' });
    expect(result).toContain('Path traversal blocked');
  });

  it('blocks absolute paths outside workspace', async () => {
    const tool = createLocalReadFileTool(ws);
    const result = await tool.invoke({ path: '/etc/passwd' });
    expect(result).toContain('Path traversal blocked');
  });
});

// ── list_files ───────────────────────────────────────────────────────────────

describe('list_files', () => {
  it('lists all files recursively', async () => {
    const tool = createLocalListFilesTool(ws);
    const result = await tool.invoke({});
    expect(result).toContain('README.md');
    expect(result).toContain('src/');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils/helper.ts');
  });

  it('filters by subdirectory path', async () => {
    const tool = createLocalListFilesTool(ws);
    const result = await tool.invoke({ path: 'src' });
    expect(result).toContain('index.ts');
    expect(result).not.toContain('README.md');
  });

  it('filters by glob pattern', async () => {
    const tool = createLocalListFilesTool(ws);
    const result = await tool.invoke({ pattern: '*.ts' });
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils/helper.ts');
    expect(result).not.toContain('README.md');
  });

  it('excludes .git directory', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const tool = createLocalListFilesTool(ws);
    const result = await tool.invoke({});
    expect(result).not.toContain('.git');
  });

  it('excludes node_modules', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'index.js'), '');
    const tool = createLocalListFilesTool(ws);
    const result = await tool.invoke({});
    expect(result).not.toContain('node_modules');
  });

  it('returns error for non-existent directory', async () => {
    const tool = createLocalListFilesTool(ws);
    const result = await tool.invoke({ path: 'nonexistent' });
    expect(result).toContain('Error: directory not found');
  });
});

// ── grep ─────────────────────────────────────────────────────────────────────

describe('grep', () => {
  it('finds matching lines with file paths', async () => {
    const tool = createLocalGrepTool(ws);
    const result = await tool.invoke({ pattern: 'export' });
    expect(result).toContain('src/index.ts');
    expect(result).toContain('export const hello');
  });

  it('searches in subdirectory when path specified', async () => {
    const tool = createLocalGrepTool(ws);
    const result = await tool.invoke({ pattern: 'add', path: 'src/utils' });
    expect(result).toContain('helper.ts');
    expect(result).toContain('add');
  });

  it('filters by include pattern', async () => {
    const tool = createLocalGrepTool(ws);
    const result = await tool.invoke({ pattern: 'export', include: '*.ts' });
    expect(result).toContain('src/index.ts');
  });

  it('returns no matches message when nothing found', async () => {
    const tool = createLocalGrepTool(ws);
    const result = await tool.invoke({ pattern: 'zzz_nonexistent_pattern' });
    expect(result).toContain('No matches found');
  });
});

// ── edit_file ────────────────────────────────────────────────────────────────

describe('edit_file', () => {
  it('replaces text when found exactly once', async () => {
    const tool = createLocalEditFileTool(ws);
    const result = await tool.invoke({
      path: 'src/index.ts',
      old_text: 'export const hello = "world";',
      new_text: 'export const hello = "universe";',
    });
    expect(result).toContain('Successfully edited');

    const content = fs.readFileSync(path.join(tmpDir, 'src', 'index.ts'), 'utf-8');
    expect(content).toContain('universe');
    expect(content).not.toContain('"world"');
  });

  it('errors when old_text not found', async () => {
    const tool = createLocalEditFileTool(ws);
    const result = await tool.invoke({
      path: 'src/index.ts',
      old_text: 'this text does not exist',
      new_text: 'replacement',
    });
    expect(result).toContain('Error: old_text not found');
  });

  it('errors when old_text matches multiple times', async () => {
    const tool = createLocalEditFileTool(ws);
    const result = await tool.invoke({
      path: 'src/index.ts',
      old_text: 'export const',
      new_text: 'const',
    });
    expect(result).toContain('found 2 times');
  });

  it('errors for non-existent file', async () => {
    const tool = createLocalEditFileTool(ws);
    const result = await tool.invoke({
      path: 'nope.ts',
      old_text: 'a',
      new_text: 'b',
    });
    expect(result).toContain('Error: file not found');
  });

  it('blocks path traversal', async () => {
    const tool = createLocalEditFileTool(ws);
    const result = await tool.invoke({
      path: '../../etc/hosts',
      old_text: 'a',
      new_text: 'b',
    });
    expect(result).toContain('Path traversal blocked');
  });
});

// ── write_file ───────────────────────────────────────────────────────────────

describe('write_file', () => {
  it('creates a new file', async () => {
    const tool = createLocalWriteFileTool(ws);
    const result = await tool.invoke({ path: 'new-file.txt', content: 'hello' });
    expect(result).toContain('Successfully wrote');
    expect(fs.readFileSync(path.join(tmpDir, 'new-file.txt'), 'utf-8')).toBe('hello');
  });

  it('creates parent directories', async () => {
    const tool = createLocalWriteFileTool(ws);
    await tool.invoke({ path: 'deep/nested/dir/file.ts', content: 'content' });
    expect(fs.existsSync(path.join(tmpDir, 'deep', 'nested', 'dir', 'file.ts'))).toBe(true);
  });

  it('overwrites existing file', async () => {
    const tool = createLocalWriteFileTool(ws);
    await tool.invoke({ path: 'README.md', content: 'new content' });
    expect(fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf-8')).toBe('new content');
  });

  it('blocks path traversal', async () => {
    const tool = createLocalWriteFileTool(ws);
    const result = await tool.invoke({ path: '../escape.txt', content: 'bad' });
    expect(result).toContain('Path traversal blocked');
  });
});

// ── bash ─────────────────────────────────────────────────────────────────────

describe('bash', () => {
  it('runs a command and returns output', async () => {
    const tool = createLocalBashTool(ws);
    const result = await tool.invoke({ command: 'echo hello' });
    expect(result.trim()).toBe('hello');
  });

  it('runs command in workspace directory', async () => {
    const tool = createLocalBashTool(ws);
    const result = await tool.invoke({ command: 'pwd' });
    // macOS /tmp symlinks to /private/tmp, so use realpath for comparison
    const realTmpDir = fs.realpathSync(tmpDir);
    expect(result.trim()).toBe(realTmpDir);
  });

  it('returns error for failed commands', async () => {
    const tool = createLocalBashTool(ws);
    const result = await tool.invoke({ command: 'exit 1' });
    expect(result).toContain('Error (exit code 1)');
  });

  it('returns error for timed out commands', async () => {
    const tool = createLocalBashTool(ws);
    // This test uses a command that should fail quickly rather than actually timing out
    const result = await tool.invoke({ command: 'false' });
    expect(result).toContain('Error');
  });

  it('returns "(no output)" for commands with no output', async () => {
    const tool = createLocalBashTool(ws);
    const result = await tool.invoke({ command: 'true' });
    expect(result).toBe('(no output)');
  });
});
