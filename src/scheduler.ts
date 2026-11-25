/** Persistent, non-preemptive delivery scheduler; one model turn at a time per member. */
import { StudioStore } from './store.js';
import { TaskEngine } from './task-engine.js';
import type { DeliveryView, SchedulerConfig } from './types.js';

export interface DeliveryDriver { isBusy(agentId: string): boolean; deliver(delivery: DeliveryView): Promise<void> }
export function resolveScheduler(input: Partial<SchedulerConfig> = {}): SchedulerConfig {
  const config = {maxActiveWorkers: 4, pollIntervalMs: 50, maxDeliveryAttempts: 3, retryDelayMs: 500, ...input};
  const limits: Record<keyof SchedulerConfig, [number, number]> = {maxActiveWorkers:[1,24],pollIntervalMs:[10,60000],maxDeliveryAttempts:[1,20],retryDelayMs:[10,60000]};
  for (const [key, [min,max]] of Object.entries(limits) as [keyof SchedulerConfig,[number,number]][]) if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid scheduler ${key}: expected ${min}..${max}`);
  return config;
}

/** Pending rows are retained on shutdown. No ordinary dispatch cancels, interrupts or steers a running Agent. */
export class DurableScheduler {
  private readonly active = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private started = false;
  private scheduled = false;
  constructor(private readonly store: StudioStore, private readonly engine: TaskEngine, private readonly driver: DeliveryDriver, readonly config: SchedulerConfig) {}
  start(): void { if (this.started) return; this.started = true; this.timer = setInterval(() => this.kick(), this.config.pollIntervalMs); this.timer.unref(); this.kick(); }
  kick(): void {
    if (!this.started || this.stopping || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.stopping) this.dispatch(); });
  }
  private dispatch(): void {
    const seen = new Set<string>();
    const workers = new Set([...this.active.keys()].filter(id => this.store.agent(id)?.role === 'worker'));
    for (const attempt of this.store.attempts()) if (attempt.status === 'running') workers.add(attempt.workerId);
    for (const delivery of this.store.deliveries()) {
      if (!['pending','running'].includes(delivery.state)) continue;
      if (delivery.taskId && this.store.task(delivery.taskId)?.status === 'paused') continue;
      if (seen.has(delivery.agentId)) continue;
      seen.add(delivery.agentId);
      if (delivery.state !== 'pending' || this.active.has(delivery.agentId) || this.driver.isBusy(delivery.agentId) || delivery.nextAt > Date.now()) continue;
      const worker = this.store.agent(delivery.agentId)?.role === 'worker';
      if (worker && !workers.has(delivery.agentId) && workers.size >= this.config.maxActiveWorkers) continue;
      const claimed = this.engine.beginDelivery(delivery.id);
      if (!claimed) continue;
      if (worker) workers.add(delivery.agentId);
      const promise = Promise.resolve().then(() => this.driver.deliver(claimed)).then(() => {
        if (!this.stopping) this.engine.finishDelivery(claimed.id);
      }).catch((error: unknown) => {
        if (!this.stopping) this.engine.failDelivery(claimed.id, error instanceof Error ? error.message : String(error), this.config.maxDeliveryAttempts, this.config.retryDelayMs);
      }).finally(() => { this.active.delete(claimed.agentId); this.kick(); });
      this.active.set(claimed.agentId, promise);
    }
  }
  /** Freeze admission before the owner cancels/drains its model requests. */
  beginStop(): void { this.stopping = true; if (this.timer) clearInterval(this.timer); }
  async stop(): Promise<void> { this.beginStop(); await Promise.allSettled([...this.active.values()]); }
}
