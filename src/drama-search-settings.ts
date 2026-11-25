import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DramaStoreError } from './drama-store.js';
import { isPublicSourceUrl } from './drama-network.js';

export const searchCatalog = [
  ['wikipedia', '维基百科'], ['baidu', '百度'], ['sogou', '搜狗'], ['360search', '360 搜索'],
  ['google', 'Google'], ['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'],
  ['yahoo', 'Yahoo'], ['google news', 'Google 新闻'], ['bing news', 'Bing 新闻'],
  ['google scholar', 'Google 学术'], ['openlibrary', 'Open Library'],
] as const;

export interface SearchSettings {version: number; sources: string[]; endpoint: string}

const update = z.object({
  expectedVersion: z.number().int().nonnegative(),
  sources: z.array(z.enum(searchCatalog.map(([id]) => id))).max(searchCatalog.length),
  endpoint: z.string().trim().max(1900),
}).strict();

export class DramaSearchSettings {
  constructor(private readonly db: DatabaseSync, readonly bundled: boolean) {
    db.exec('CREATE TABLE IF NOT EXISTS drama_search_settings(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, sources TEXT NOT NULL, endpoint TEXT NOT NULL)');
  }
  read(): SearchSettings {
    const row = this.db.prepare('SELECT version,sources,endpoint FROM drama_search_settings WHERE id=1').get();
    return row ? {version:Number(row.version), sources:JSON.parse(String(row.sources)), endpoint:String(row.endpoint)}
      : {version:0, sources:this.bundled ? ['wikipedia','bing','sogou'] : ['wikipedia'], endpoint:''};
  }
  view() { return {...this.read(), bundled:this.bundled, catalog:searchCatalog.map(([id,name])=>({id,name}))}; }
  save(value: unknown) {
    const parsed = update.safeParse(value);
    if (!parsed.success) throw new DramaStoreError(400,'搜索来源或版本无效');
    const {expectedVersion,sources,endpoint} = parsed.data;
    if (new Set(sources).size !== sources.length) throw new DramaStoreError(400,'搜索来源重复');
    if (endpoint && (!isPublicSourceUrl(endpoint) || endpoint.includes('#') || endpoint.includes('?'))) throw new DramaStoreError(400,'请填写公开 HTTPS 的 SearXNG 搜索地址，不含查询参数');
    if (!endpoint && !this.bundled && sources.some(id=>id!=='wikipedia')) throw new DramaStoreError(400,'请先配置 SearXNG 搜索地址');
    const changed = this.db.prepare(`INSERT INTO drama_search_settings(id,version,sources,endpoint)
      SELECT 1,?,?,? WHERE ?=COALESCE((SELECT version FROM drama_search_settings WHERE id=1),0)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,sources=excluded.sources,endpoint=excluded.endpoint`)
      .run(expectedVersion+1,JSON.stringify(sources),endpoint,expectedVersion);
    if (!changed.changes) throw new DramaStoreError(409,'搜索设置已被其他窗口修改，请重新载入');
    return this.view();
  }
}
