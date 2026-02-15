import type { AgentProcess } from './process-manager.js';

/**
 * Repository interface for agent process persistence.
 */
export interface ProcessRepository {
  save(process: AgentProcess): void | Promise<void>;
  update(process: AgentProcess): void | Promise<void>;
  getById(id: string): AgentProcess | undefined | Promise<AgentProcess | undefined>;
  list(filter?: { status?: string; repoId?: number }): AgentProcess[] | Promise<AgentProcess[]>;
}

/**
 * In-memory process repository -- stores processes in a Map.
 * This is the default when no database is configured.
 */
export class InMemoryProcessRepository implements ProcessRepository {
  private processes: Map<string, AgentProcess> = new Map();

  save(process: AgentProcess): void {
    this.processes.set(process.id, { ...process, logs: [...process.logs] });
  }

  update(process: AgentProcess): void {
    this.processes.set(process.id, { ...process, logs: [...process.logs] });
  }

  getById(id: string): AgentProcess | undefined {
    const proc = this.processes.get(id);
    return proc ? { ...proc, logs: [...proc.logs] } : undefined;
  }

  list(filter?: { status?: string; repoId?: number }): AgentProcess[] {
    const all = Array.from(this.processes.values());
    if (filter?.status) return all.filter(p => p.status === filter.status);
    return all;
  }
}
