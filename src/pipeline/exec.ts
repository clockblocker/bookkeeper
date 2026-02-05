import { spawn } from 'bun';
import type { ExecResult } from '../types';

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
}

export async function exec(
  cmd: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const { timeout = 300000, cwd } = options;

  const proc = spawn({
    cmd,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = timeout > 0
    ? new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          proc.kill();
          reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);
      })
    : null;

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  try {
    if (timeoutPromise) {
      return await Promise.race([resultPromise, timeoutPromise]);
    }
    return await resultPromise;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function execOrThrow(
  cmd: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const result = await exec(cmd, options);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
  return result;
}

export async function batchExec<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

export async function getCommandVersion(cmd: string): Promise<string> {
  try {
    const result = await exec([cmd, '--version']);
    const match = result.stdout.match(/(\d+\.\d+\.?\d*)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}
