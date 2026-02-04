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

  const timeoutPromise = timeout > 0
    ? new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout)
      )
    : null;

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  if (timeoutPromise) {
    return Promise.race([resultPromise, timeoutPromise]);
  }
  return resultPromise;
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
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const promise = fn(item).then((result) => {
      results[i] = result;
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      const idx = executing.findIndex((p) =>
        p.then(() => true).catch(() => true)
      );
      if (idx !== -1) {
        await executing[idx];
        executing.splice(idx, 1);
      }
    }
  }

  await Promise.all(executing);
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
