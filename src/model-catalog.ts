import {AsyncLocalStorage} from 'node:async_hooks';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime, {LlmAdapter} from '@deepseek-ai/dsh-llm';
import type {AdapterRegistrationHandle, GenerateOptions} from '@deepseek-ai/dsh-llm';
import {mountConfiguredModels} from './model-source.js';
import type {ModelOption} from './types.js';

interface ModelSource { ctx: Context; routes: Set<string>; models: ModelOption[]; users: number }

/** A delivery keeps the configured adapters it started with. Refresh publishes only a completely loaded source. */
export class ModelCatalog extends LlmAdapter {
  private current?: ModelSource;
  private readonly retained = new Set<ModelSource>();
  private readonly scope = new AsyncLocalStorage<ModelSource>();
  private registration?: AdapterRegistrationHandle;
  private loading?: Promise<void>;
  private closed = false;
  constructor(private readonly root: Context, private readonly home: string) { super(); }

  get models(): ModelOption[] { return this.current?.models ?? []; }

  async using<T>(run: () => Promise<T>): Promise<T> {
    // Scheduler wake-ups can inherit a completed delivery's async context. Each new operation starts with the current catalog.
    const source = this.current;
    if (!source || this.closed) throw new Error('DSH model source is unavailable');
    source.users++;
    try { return await this.scope.run(source, run); }
    finally {
      if (!--source.users && source !== this.current && this.retained.delete(source)) {
        this.updateRoutes();
        await source.ctx.fiber.dispose();
      }
    }
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('DSH model source is closed'));
    return this.loading ??= this.reload().finally(() => { this.loading = undefined; });
  }

  private async reload(): Promise<void> {
    const ctx = new Context();
    const next: ModelSource = {ctx, routes:new Set(), models:[], users:0};
    try {
      await ctx.plugin(LlmRuntime);
      await mountConfiguredModels(ctx, this.home);
      for (const provider of ctx.llm.listProviders()) {
        if (provider.id === 'studio-demo') throw new Error('studio-demo is reserved');
        next.routes.add(provider.id);
        for (const model of await ctx.llm.listModels(provider.id)) {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
          next.models.push({provider: provider.id, model: model.id, name: model.name, demo:false,
            efforts: info.reasoning?.efforts.map(e => ({id:e.id, name:e.name})) ?? []});
        }
      }
      if (this.closed) throw new Error('DSH model source is closed');
    } catch (error) { await ctx.fiber.dispose(); throw error; }

    const previous = this.current;
    this.current = next;
    if (previous?.users) this.retained.add(previous);
    try { this.updateRoutes(); }
    catch (error) {
      this.current = previous;
      if (previous) this.retained.delete(previous);
      await ctx.fiber.dispose();
      throw error;
    }
    if (previous && !previous.users) await previous.ctx.fiber.dispose();
  }

  private updateRoutes() {
    if (this.closed) return;
    const routes = [...new Set([this.current, ...this.retained].flatMap(source => source ? [...source.routes] : []))];
    if (this.registration) this.registration.replace(routes);
    else if (routes.length) this.registration = this.root.llm.registerAdapter(routes, this);
  }

  private source(provider: string) {
    const source = this.scope.getStore() ?? this.current;
    if (!source?.routes.has(provider)) throw new Error('Provider is no longer configured');
    return source.ctx.llm;
  }

  override providerRetryPolicy(provider: string) {
    // Registration enumerates even retired routes used only by earlier deliveries.
    const source = [this.current, ...this.retained].find(item => item?.routes.has(provider));
    return source?.ctx.llm.providerRetryPolicy(provider);
  }
  override listModels(provider: string) { return this.source(provider).listModels(provider); }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.source(provider).resolveModelInfo(provider, model, signal);
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const llm = this.source(provider);
    return {model: await llm.resolveModelInfo(provider, model, signal), stream: (options: GenerateOptions) => llm.stream(options)};
  }
  override stream(options: GenerateOptions) { return this.source(options.provider).stream(options); }

  async close() {
    this.closed = true;
    await this.loading?.catch(() => {});
    this.registration?.();
    await Promise.all([this.current, ...this.retained].map(source => source?.ctx.fiber.dispose()));
    this.current = undefined;
    this.retained.clear();
  }
}
