import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import process from 'node:process';

interface LockOwner {
  pid: number;
  token: string;
  startedAt: string;
}

export interface ProcessLock {
  path: string;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
    if (
      !Number.isInteger(owner.pid) ||
      typeof owner.token !== 'string' ||
      typeof owner.startedAt !== 'string'
    ) {
      return null;
    }
    return owner as LockOwner;
  } catch {
    return null;
  }
}

/**
 * 一个 identity.key 只能被一个 bridge 进程使用。
 * 文件锁还覆盖 bridge 自身被重复启动的情况，避免两个 serve 共享同一身份互相顶掉。
 */
export function acquireProcessLock(homeDir: string): ProcessLock {
  const path = join(homeDir, '.room-bridge.lock');
  mkdirSync(dirname(path), { recursive: true });

  for (;;) {
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(owner));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path,
        release(): void {
          if (released) return;
          released = true;
          const current = readOwner(path);
          if (current?.pid !== owner.pid || current.token !== owner.token) return;
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = readOwner(path);
      if (current && processIsAlive(current.pid)) {
        throw new Error(
          `同一身份已有 room-bridge 在运行（PID ${current.pid}，启动于 ${current.startedAt}）；` +
            `请先停止它，或为另一个房间使用独立的 IROH_AGENT_HOME`,
        );
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }
}
