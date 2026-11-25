/** Read-only import of literal model configuration from an existing DSH home. */
import { readModelFile as optionalText } from './model-files.js';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import CredentialProvider, {parseCredentialKey} from '@deepseek-ai/dsh-credentials';
import type {CredentialKey, CredentialRef, CredentialRecord, CredentialInfo, CredentialRecordInfo, CredentialRecordEntry, ResolvedCredential} from '@deepseek-ai/dsh-credentials';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek';
import FileSettings from '@deepseek-ai/dsh-settings-file';
import {parseDocument} from 'yaml';

const JS_MARKER = '__studio_unevaluated_js__';
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a mapping`);
  return value as Record<string, unknown>;
}

/** Parses executable YAML tags as inert markers; selected model config rejects them. */
function yaml(source: string, label: string): unknown {
  const document = parseDocument(source, {uniqueKeys: true, customTags: [{tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({[JS_MARKER]: value})}]});
  if (document.errors.length || document.warnings.length) throw new Error(`${label}: unsupported or invalid YAML; no configuration was changed`);
  return document.toJS({maxAliasCount: 50}) as unknown;
}

function literal(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(literal); return; }
  if (value && typeof value === 'object') {
    if (JS_MARKER in value) throw new Error('Executable expressions in model configuration are unsupported; supply literal model settings');
    Object.values(value).forEach(literal);
  }
}

interface CredentialDocument { refs: Record<string, string>; records: Record<string, CredentialRecord> }

/** A provider with no source-file write or token-refresh capability. */
export class ReadonlyDshCredentials extends CredentialProvider {
  private readonly home: string;
  constructor(ctx: Context, config: {home: string}) { super(ctx); this.home = config.home; }
  private async document(): Promise<CredentialDocument> {
    const source = await optionalText(join(this.home, '.credentials.yaml'));
    if (source === undefined) return {refs: {}, records: {}};
    const raw = record(yaml(source, 'DSH credentials'), 'DSH credentials');
    const refs: Record<string, string> = {};
    const records: Record<string, CredentialRecord> = {};
    const refsRaw = raw.version === undefined ? raw : raw.version === 1 ? record(raw.refs ?? {}, 'DSH credential refs') : undefined;
    if (!refsRaw) throw new Error('Unsupported DSH credentials version; update it through DSH');
    for (const [key, value] of Object.entries(refsRaw)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || !value) throw new Error('Invalid DSH credential reference');
      refs[key] = value;
    }
    if (raw.version === 1) {
      for (const [key, value] of Object.entries(record(raw.records ?? {}, 'DSH credential records'))) {
        parseCredentialKey(key);
        const entry = record(value, 'DSH credential record');
        if (entry.kind === 'grant') records[key] = {kind: 'grant', payload: entry.payload};
        else if (entry.kind === 'api-key') {
          if (entry.key !== undefined && (typeof entry.key !== 'string' || !entry.key)) throw new Error('Invalid DSH API key record');
          let env: Record<string, string> | undefined;
          if (entry.env !== undefined) {
            env = {};
            for (const [name, item] of Object.entries(record(entry.env, 'DSH credential environment'))) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof item !== 'string') throw new Error('Invalid DSH credential environment');
              env[name] = item;
            }
          }
          records[key] = {kind: 'api-key', ...(entry.key ? {key: entry.key as string} : {}), ...(env ? {env} : {})};
        } else throw new Error('Unsupported DSH credential record');
      }
    }
    return {refs, records};
  }
  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (process.env[ref]) return {value: process.env[ref]!, source: 'env'};
    const value = (await this.document()).refs[ref];
    if (value) return {value, source: 'dsh-readonly'};
    const envSource = await optionalText(join(this.home, '.env'));
    const envValue = envSource === undefined ? undefined : parseEnv(envSource)[ref];
    return envValue ? {value: envValue, source: 'dsh-env-readonly'} : undefined;
  }
  override async describe(ref: CredentialRef): Promise<CredentialInfo> { const found = await this.resolve(ref); return {configured: !!found, writable: false, ...(found ? {source: found.source} : {})}; }
  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return (await this.document()).records[key]; }
  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> { const value = await this.readRecord(key); return {configured: !!value, writable: false, ...(value ? {kind: value.kind} : {})}; }
  override async listRecords(): Promise<readonly CredentialRecordEntry[]> { return Object.entries((await this.document()).records).map(([key, value]) => ({key: parseCredentialKey(key), kind: value.kind})); }
  override async set(_ref: CredentialRef, _value: string): Promise<void> { throw new Error('DSH credentials are read-only in Agent Studio'); }
  override async unset(_ref: CredentialRef): Promise<void> { throw new Error('DSH credentials are read-only in Agent Studio'); }
  override async deleteRecord(_key: CredentialKey): Promise<void> { throw new Error('DSH credentials are read-only in Agent Studio'); }
  override async modifyRecord(_key: CredentialKey, _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    throw new Error('Agent Studio cannot refresh or change DSH authorization; refresh the login in DSH and retry');
  }
}

/** Loads only llm-* configuration; unrelated plugin entries are never executed. */
export async function mountConfiguredModels(ctx: Context, home: string): Promise<void> {
  const profile = process.env.STUDIO_DSH_PROFILE ?? 'web';
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('STUDIO_DSH_PROFILE must be a profile name');
  const configs = new Map<string, Record<string, unknown>>();
  const disabled = new Set<string>();
  for (const filename of [join(home, 'profiles', profile, 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    const source = await optionalText(filename);
    if (source === undefined) continue;
    const patches = yaml(source, 'DSH profile patch');
    if (!Array.isArray(patches)) throw new Error('DSH profile patch must contain a list');
    const inspect = (entry: unknown): void => {
      const row = record(entry, 'DSH patch entry');
      if (row.id === 'llm-pi-ai' || row.id === 'llm-deepseek') {
        if (row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new Error('Model plugin disabled fields must be literal booleans');
        if (row.disabled === true) disabled.add(row.id);
        if (row.disabled === false) disabled.delete(row.id);
        if (row.config !== undefined) { literal(row.config); configs.set(row.id, record(row.config, 'DSH model configuration')); }
      }
      if (Array.isArray(row.insert)) row.insert.forEach(inspect);
    };
    patches.forEach(inspect);
  }
  const settingsSource = await optionalText(join(home, 'settings.yaml'));
  const settings = settingsSource === undefined ? {} : record(yaml(settingsSource, 'DSH settings'), 'DSH settings');
  literal(settings['llm-pi-ai']);
  literal(settings['llm-deepseek']);
  // Keep DSH's namespace merging and validation while reading from the same source as the profile.
  class ModelSettings extends FileSettings {
    override get writable() { return false; }
    protected override async load() { return settings; }
    protected override async persist(): Promise<void> { throw new Error('Model settings are read-only'); }
    override async prepareDocument(): Promise<string> { throw new Error('Model settings are read-only'); }
  }
  await ctx.plugin(ModelSettings, {dshHome: home, watch: false});
  await ctx.plugin(ReadonlyDshCredentials, {home});
  const overrides = process.env.STUDIO_ENDPOINT_OVERRIDES;
  if (overrides) {
    const values = record(JSON.parse(overrides), 'STUDIO_ENDPOINT_OVERRIDES');
    const pi = configs.get('llm-pi-ai');
    const providers = pi ? record(pi.providers ?? {}, 'providers') : {};
    for (const [provider, endpoint] of Object.entries(values)) {
      if (typeof endpoint !== 'string' || !['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error('Endpoint override must be an HTTP(S) URL');
      if (!providers[provider]) throw new Error(`Endpoint override names an unconfigured provider: ${provider}`);
      record(providers[provider], 'provider').baseURL = endpoint;
    }
  }
  if (!disabled.has('llm-pi-ai')) await ctx.plugin(PiAi, configs.get('llm-pi-ai') ?? {});
  if (!disabled.has('llm-deepseek') && (configs.has('llm-deepseek') || settings['llm-deepseek'] !== undefined)) {
    await ctx.plugin(DeepSeek, configs.get('llm-deepseek') ?? {});
  }
}
