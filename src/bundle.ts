/** DSH profile lifecycle wrapper for the standalone Studio Web runtime. */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { resolve } from 'node:path';
import { startServer } from './server.js';

export const name = 'dsh-agent-studio';

/** Startup settings; the application has its own runtime and data directory. */
export const Config = z.object({
  port: z.number().int().min(0).max(65535).default(4317),
  dataDir: z.string().min(1).default('.studio'),
  dshHome: z.string().min(1).optional(),
  scheduler: z.object({
    maxActiveWorkers: z.number().int().min(1).max(24).optional(),
    pollIntervalMs: z.number().int().min(10).max(60000).optional(),
    maxDeliveryAttempts: z.number().int().min(1).max(20).optional(),
    retryDelayMs: z.number().int().min(10).max(60000).optional(),
  }).optional(),
  demoDelayMs: z.number().int().min(0).max(60000).optional(),
  compaction: z.object({
    auto: z.boolean().optional(), thresholdRatio: z.number().gt(0).lt(1).optional(),
    retainRatio: z.number().gt(0).lt(1).optional(), retainTokens: z.number().int().nonnegative().optional(),
    maxTokens: z.number().int().positive().optional(),
    summarizationProvider: z.string().min(1).optional(), summarizationModel: z.string().min(1).optional(),
    compactionRetries: z.number().int().nonnegative().optional(), maxOverflowRetries: z.number().int().nonnegative().optional(),
  }).optional(),
  execution: z.object({
    enabled: z.boolean().default(false), image: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(300000).optional(),
    maxOutputBytes: z.number().int().min(1024).max(1048576).optional(),
    maxFileBytes: z.number().int().min(1024).max(1048576).optional(),
    memoryMb: z.number().int().min(64).max(4096).optional(),
    cpus: z.number().min(0.1).max(8).optional(),
    pidsLimit: z.number().int().min(16).max(512).optional(),
  }).optional(),
});
export type Config = z.infer<typeof Config>;

/**
 * Own a Studio server for the lifetime of this plugin, without mounting duplicate
 * core services into the host profile's Context.
 * @param ctx - DSH profile context owning the server lifecycle.
 * @param config - Validated local listener and persistence settings.
 * @returns Readiness after the loopback listener has started.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async () => {
    const app = await startServer({
      port: config.port,
      dataDir: resolve(config.dataDir),
      ...(config.scheduler ? {scheduler: config.scheduler} : {}),
      ...(config.demoDelayMs === undefined ? {} : {demoDelayMs: config.demoDelayMs}),
      ...(config.execution ? {execution: config.execution} : {}),
      ...(config.compaction ? {compaction: config.compaction} : {}),
      ...(config.dshHome ? { dshHome: resolve(config.dshHome) } : {}),
    });
    ctx.logger(name).info(`Studio Phase 3: ${app.url} (independent DSH runtime; SQLite memory; containers ${config.execution?.enabled ? 'enabled' : 'disabled'})`);
    return () => app.close();
  }, 'studio.web-runtime');
}
