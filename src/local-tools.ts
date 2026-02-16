import { tool } from 'langchain';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { Workspace } from './workspace.js';

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Resolve a relative path against the workspace and verify it stays inside.
 * Throws if the resolved path escapes the workspace root.
 */
function safePath(ws: Workspace, filePath: string): string {
  const resolved = path.resolve(ws.path, filePath);
  if (!resolved.startsWith(ws.path + path.sep) && resolved !== ws.path) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside workspace`);
  }
  return resolved;
}

// ── Default exclusions ───────────────────────────────────────────────────────

const EXCLUDED_DIRS = ['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.cache'];

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * Read a file from the workspace. Supports optional line range.
 * Truncates to 200 lines by default to keep context manageable.
 */
export function createLocalReadFileTool(ws: Workspace) {
  return tool(
    async ({ path: filePath, start_line, end_line }: { path: string; start_line?: number; end_line?: number }) => {
      try {
        const absPath = safePath(ws, filePath);
        if (!fs.existsSync(absPath)) {
          return `Error: file not found: ${filePath}`;
        }
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          return `Error: "${filePath}" is a directory, not a file. Use list_files to browse directories.`;
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        const lines = content.split('\n');

        const start = (start_line ?? 1) - 1; // Convert to 0-indexed
        const end = end_line ?? Math.min(lines.length, start + 200);
        const slice = lines.slice(start, end);

        const numbered = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
        const truncated = end < lines.length ? `\n\n[Truncated: showing lines ${start + 1}-${end} of ${lines.length}]` : '';
        return numbered + truncated;
      } catch (err: any) {
        return `Error reading file: ${err.message}`;
      }
    },
    {
      name: 'read_file',
      description: 'Read a file from the repository. Returns numbered lines. Default limit is 200 lines. For files >100 lines, prefer using grep first to find relevant line numbers, then read only those sections with start_line/end_line.',
      schema: z.object({
        path: z.string().describe('Relative path to the file (e.g. "src/index.ts")'),
        start_line: z.number().optional().describe('First line to read (1-indexed, default: 1)'),
        end_line: z.number().optional().describe('Last line to read (inclusive, default: start + 200)'),
      }),
    },
  );
}

/**
 * List files in the workspace. Uses a simple recursive walk with exclusions.
 * Supports glob-like pattern filtering.
 */
export function createLocalListFilesTool(ws: Workspace) {
  return tool(
    async ({ pattern, path: subPath }: { pattern?: string; path?: string }) => {
      try {
        const baseDir = subPath ? safePath(ws, subPath) : ws.path;
        if (!fs.existsSync(baseDir)) {
          return `Error: directory not found: ${subPath ?? '.'}`;
        }

        const results: string[] = [];
        const maxResults = 500;

        function walk(dir: string, depth: number) {
          if (results.length >= maxResults || depth > 10) return;

          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (results.length >= maxResults) break;
            if (EXCLUDED_DIRS.includes(entry.name)) continue;

            const rel = path.relative(ws.path, path.join(dir, entry.name));
            if (entry.isDirectory()) {
              results.push(rel + '/');
              walk(path.join(dir, entry.name), depth + 1);
            } else {
              if (pattern && !matchGlob(rel, pattern)) continue;
              results.push(rel);
            }
          }
        }

        walk(baseDir, 0);
        if (results.length === 0) return 'No files found.';
        const truncMsg = results.length >= maxResults ? `\n\n[Truncated at ${maxResults} entries]` : '';
        return results.join('\n') + truncMsg;
      } catch (err: any) {
        return `Error listing files: ${err.message}`;
      }
    },
    {
      name: 'list_files',
      description: 'List files in the repository. Optionally filter by path and/or glob pattern. Excludes .git/, node_modules/, and other build directories.',
      schema: z.object({
        pattern: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "**/*.test.ts")'),
        path: z.string().optional().describe('Subdirectory to list (e.g. "src/"). Defaults to repo root.'),
      }),
    },
  );
}

// Simple glob matching: supports *.ext and **/<pattern> prefix patterns.
function matchGlob(filePath: string, pattern: string): boolean {
  // Simple *.ext matching
  if (pattern.startsWith('*.')) {
    return filePath.endsWith(pattern.slice(1));
  }
  // **/pattern — match anywhere in path
  if (pattern.startsWith('**/')) {
    const sub = pattern.slice(3);
    return filePath.includes(sub) || matchGlob(path.basename(filePath), sub);
  }
  // Direct substring match as fallback
  return filePath.includes(pattern);
}

/**
 * Grep for a regex pattern across workspace files.
 * Uses `grep -rn` for speed, limited to 100 matches.
 */
export function createLocalGrepTool(ws: Workspace) {
  return tool(
    async ({ pattern, path: subPath, include }: { pattern: string; path?: string; include?: string }) => {
      try {
        const searchDir = subPath ? safePath(ws, subPath) : ws.path;
        const excludes = EXCLUDED_DIRS.map(d => `--exclude-dir=${d}`).join(' ');
        const includeFlag = include ? `--include="${include}"` : '';
        const cmd = `grep -rn -m 100 ${excludes} ${includeFlag} -E "${pattern.replace(/"/g, '\\"')}" "${searchDir}"`;
        const result = execSync(cmd, { cwd: ws.path, stdio: 'pipe', timeout: 15_000, encoding: 'utf-8' });

        if (!result.trim()) return 'No matches found.';

        // Make paths relative to workspace
        const wsPrefix = fs.realpathSync(ws.path);
        const lines = result.trim().split('\n').map(line => {
          if (line.startsWith(wsPrefix)) {
            return line.slice(wsPrefix.length + 1);
          }
          if (line.startsWith(ws.path)) {
            return line.slice(ws.path.length + 1);
          }
          return line;
        });
        return lines.join('\n');
      } catch (err: any) {
        // grep returns exit code 1 when no matches
        if (err.status === 1) return 'No matches found.';
        return `Error searching: ${err.message}`;
      }
    },
    {
      name: 'grep',
      description: 'Search for a regex pattern across repository files. Returns matching lines with file paths and line numbers. Limited to 100 matches.',
      schema: z.object({
        pattern: z.string().describe('Regular expression pattern to search for'),
        path: z.string().optional().describe('Subdirectory to search in (e.g. "src/")'),
        include: z.string().optional().describe('File pattern to include (e.g. "*.ts")'),
      }),
    },
  );
}

/**
 * Surgical find-and-replace edit. The old_text must match exactly once in the file.
 */
export function createLocalEditFileTool(ws: Workspace) {
  return tool(
    async ({ path: filePath, old_text, new_text }: { path: string; old_text: string; new_text: string }) => {
      try {
        const absPath = safePath(ws, filePath);
        if (!fs.existsSync(absPath)) {
          return `Error: file not found: ${filePath}`;
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        const occurrences = content.split(old_text).length - 1;

        if (occurrences === 0) {
          return `Error: old_text not found in ${filePath}. Make sure the text matches exactly (including whitespace and indentation).`;
        }
        if (occurrences > 1) {
          return `Error: old_text found ${occurrences} times in ${filePath}. It must match exactly once. Add more surrounding context to make it unique.`;
        }

        const newContent = content.replace(old_text, new_text);
        fs.writeFileSync(absPath, newContent, 'utf-8');
        return `Successfully edited ${filePath}`;
      } catch (err: any) {
        return `Error editing file: ${err.message}`;
      }
    },
    {
      name: 'edit_file',
      description: 'Make a surgical edit to a file by replacing old_text with new_text. The old_text must match exactly once in the file. Use read_file first to see the current content.',
      schema: z.object({
        path: z.string().describe('Relative path to the file'),
        old_text: z.string().describe('Exact text to find (must match once). Include surrounding context for uniqueness.'),
        new_text: z.string().describe('Replacement text'),
      }),
    },
  );
}

/**
 * Create or overwrite a file. Creates parent directories as needed.
 */
export function createLocalWriteFileTool(ws: Workspace) {
  return tool(
    async ({ path: filePath, content }: { path: string; content: string }) => {
      try {
        const absPath = safePath(ws, filePath);
        const dir = path.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
        return `Successfully wrote ${filePath}`;
      } catch (err: any) {
        return `Error writing file: ${err.message}`;
      }
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Creates parent directories automatically. Prefer edit_file for surgical changes to existing files.',
      schema: z.object({
        path: z.string().describe('Relative path to the file'),
        content: z.string().describe('Full file content to write'),
      }),
    },
  );
}

/**
 * Run a shell command in the workspace directory.
 * 30-second timeout, cwd set to workspace root.
 */
export function createLocalBashTool(ws: Workspace) {
  return tool(
    async ({ command }: { command: string }) => {
      try {
        const result = execSync(command, {
          cwd: ws.path,
          stdio: 'pipe',
          timeout: 30_000,
          encoding: 'utf-8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return result || '(no output)';
      } catch (err: any) {
        const stdout = err.stdout?.toString() || '';
        const stderr = err.stderr?.toString() || '';
        const output = [stdout, stderr].filter(Boolean).join('\n');
        if (err.killed) {
          return `Error: command timed out after 30 seconds.\n${output}`;
        }
        return `Error (exit code ${err.status ?? 'unknown'}):\n${output}`;
      }
    },
    {
      name: 'bash',
      description: 'Run a shell command in the repository directory. Use for git operations (branch, commit, push), running tests, or other CLI tasks. 30-second timeout.',
      schema: z.object({
        command: z.string().describe('Shell command to execute'),
      }),
    },
  );
}

// ── Dry-run variants ─────────────────────────────────────────────────────────

export function createDryRunEditFileTool() {
  return tool(
    async ({ path: filePath, old_text, new_text }: { path: string; old_text: string; new_text: string }) => {
      console.log(`DRY RUN -- would edit ${filePath}: replace ${old_text.length} chars with ${new_text.length} chars`);
      return `DRY RUN: would edit ${filePath}`;
    },
    {
      name: 'edit_file',
      description: 'Make a surgical edit to a file (dry-run mode — no actual changes).',
      schema: z.object({
        path: z.string().describe('Relative path to the file'),
        old_text: z.string().describe('Exact text to find'),
        new_text: z.string().describe('Replacement text'),
      }),
    },
  );
}

export function createDryRunWriteFileTool() {
  return tool(
    async ({ path: filePath, content }: { path: string; content: string }) => {
      console.log(`DRY RUN -- would write ${filePath} (${content.length} chars)`);
      return `DRY RUN: would write ${filePath}`;
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file (dry-run mode — no actual changes).',
      schema: z.object({
        path: z.string().describe('Relative path to the file'),
        content: z.string().describe('Full file content to write'),
      }),
    },
  );
}

export function createDryRunBashTool() {
  return tool(
    async ({ command }: { command: string }) => {
      console.log(`DRY RUN -- would execute: ${command}`);
      return `DRY RUN: would execute: ${command}`;
    },
    {
      name: 'bash',
      description: 'Run a shell command (dry-run mode — no actual execution).',
      schema: z.object({
        command: z.string().describe('Shell command to execute'),
      }),
    },
  );
}
