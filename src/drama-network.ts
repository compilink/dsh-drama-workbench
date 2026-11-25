/** Read-only public HTTPS tools invoked by the workbench after runtime authorization. */
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { SearchSettings } from './drama-search-settings.js';

const CONNECT_DEADLINE_MS = 12000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_EXCERPT = 12000;
const MAX_ACTIVE_OPERATIONS = 4;
const MAX_REQUESTS_PER_MINUTE = 30;
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const nonPublic = new BlockList();
// IANA special-purpose ranges; deny entire reserved blocks, including their individual exceptions.
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv6');
}

interface ResolvedAddress { address: string; family: number }
interface ResponseChunk { status: number; location?: string; contentType?: string; body?: Buffer }
interface Transport {
  resolve(host: string): Promise<ResolvedAddress[]>;
  get(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<ResponseChunk>;
}

/** Test whether a normalized numerical IP satisfies the public destination policy. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

function safeUrl(value: string, searchOrigin?: string): URL {
  if (value.length > 2048) throw new Error('公开链接过长');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('公开链接无效'); }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) throw new Error('只允许访问标准端口的公开 HTTPS 链接');
  if (searchOrigin ? url.origin !== searchOrigin : Boolean(url.search)) throw new Error('公开链接的查询参数或跳转目标不允许');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!isIP(host) && (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|example|lan|onion|home\.arpa)$/.test(host))) {
    throw new Error('只允许访问公开主机');
  }
  url.hash = '';
  return url;
}

/** Screen a source link for display. Actual egress additionally validates DNS. */
export function isPublicSourceUrl(value: string): boolean {
  try {
    const host = safeUrl(value, new URL(value).origin).hostname.replace(/^\[|\]$/g, '');
    return !isIP(host) || isPublicAddress(host);
  } catch { return false; }
}

async function pinAddress(url: URL, transport: Transport, signal: AbortSignal): Promise<ResolvedAddress> {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(host);
  let addresses: ResolvedAddress[];
  if (family) addresses = [{address: host, family}];
  else {
    let aborted: () => void;
    const abort = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, {once: true});
    });
    try { addresses = await Promise.race([transport.resolve(host), abort]); }
    finally { signal.removeEventListener('abort', aborted!); }
  }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => item.family !== isIP(item.address) || !isPublicAddress(item.address))) throw new Error('公开主机解析到了禁止的地址');
  return addresses.find(item => item.family === 4) ?? addresses[0]!;
}

function requestPinned(url: URL, pinned: ResolvedAddress, signal: AbortSignal): Promise<ResponseChunk> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, signal, family: pinned.family,
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
      headers: {Accept: 'text/html,text/plain,application/json,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'DSHDramaWorkbench/1.3 (public read-only source lookup)'},
    }, response => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const contentType = response.headers['content-type'];
      if (status < 200 || status >= 300) {
        response.destroy();
        resolve({status, location});
        return;
      }
      const length = Number(response.headers['content-length']);
      const encoding = response.headers['content-encoding'];
      if ((length > MAX_BODY_BYTES) || (encoding && encoding.toLowerCase() !== 'identity') || !isReadable(contentType)) {
        response.destroy();
        reject(new Error('公开来源正文过大或格式不受支持'));
        return;
      }
      void (async () => {
        let total = 0;
        const parts: Buffer[] = [];
        for await (const chunk of response) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > MAX_BODY_BYTES) throw new Error('公开来源正文过大');
          parts.push(bytes);
        }
        return {status, contentType, body: Buffer.concat(parts, total)};
      })().then(resolve, reject);
    });
    req.once('error', reject);
    req.end();
  });
}

function isReadable(contentType: string | undefined): boolean {
  return /^(?:text\/(?:html|plain|markdown)|application\/(?:json|xhtml\+xml))(?:\s*;|$)/i.test(contentType ?? '');
}

function webText(input: string): string {
  const lower = input.replace(/[A-Z]/g, letter => letter.toLowerCase());
  const text: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('<', cursor);
    if (start < 0) { text.push(input.slice(cursor)); break; }
    text.push(input.slice(cursor, start));
    if (input.startsWith('<!--', start)) {
      const end = input.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    const end = input.indexOf('>', start + 1);
    if (end < 0) break;
    const tag = /^\/?([a-z]+)\b/.exec(lower.slice(start + 1, Math.min(end, start + 32)))?.[1];
    cursor = end + 1;
    if (tag && !input.startsWith('</', start) && ['script', 'style', 'noscript', 'svg', 'template'].includes(tag)) {
      const close = lower.indexOf(`</${tag}`, cursor);
      if (close < 0) break;
      const closeEnd = lower.indexOf('>', close);
      if (closeEnd < 0) break;
      cursor = closeEnd + 1;
    }
    text.push(' ');
  }
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return text.join('').replace(/&(#x[\da-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/g, (_entity, value: string) => {
    if (!value.startsWith('#')) return named[value as keyof typeof named];
    const code = value.startsWith('#x') ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
    return code > 31 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : '';
  }).replace(/\s+/g, ' ').trim();
}

const searchResponse = z.object({query: z.object({search: z.array(z.object({title: z.string(), pageid: z.number().int().positive(), snippet: z.string()}))})});

interface Source { title:string; url:string; excerpt:string; retrievedAt:string; provider?:string }
interface NetworkResult { source?:Source; sources?:Source[]; provider?:string; retrievedAt?:string; warnings?:string[] }

const gatewayResponse = z.object({
  results:z.array(z.object({title:z.string(),url:z.string(),content:z.string().nullish(),engine:z.string().optional(),engines:z.array(z.string()).optional()})),
  unresponsive_engines:z.array(z.array(z.string())).optional(),
});

function normalizeGateway(body:string, retrievedAt:string, engines:string[]) {
  const parsed = gatewayResponse.safeParse(JSON.parse(body));
  if (!parsed.success) throw new Error('SearXNG 未返回可读的 JSON 搜索结果');
  const commonReasons:Record<string,string>={'captcha':'验证码','too many requests':'限流','access denied':'访问被拒绝','timeout':'超时','parsing error':'结果解析失败','http protocol error':'协议错误'};
  const failures=(parsed.data.unresponsive_engines ?? []).filter(([id])=>engines.includes(id));
  const warnings=failures.map(([id,reason])=>id+' 未响应'+(commonReasons[reason?.toLowerCase()]?'（'+commonReasons[reason.toLowerCase()]+'）':''));

  if (warnings.length && new Set(failures.map(([id])=>id)).size===engines.length && !parsed.data.results.length)
    throw new Error(warnings.join('、'));
  const sources = parsed.data.results.flatMap(item=>{
    const names = (item.engines ?? [item.engine ?? '']).filter(name=>engines.includes(name));
    if (!names.length || !isPublicSourceUrl(item.url)) return [];
    return [{provider:names.join(', '),title:webText(item.title).slice(0,300)||item.url.slice(0,300),url:item.url,
      excerpt:webText(item.content??'').slice(0,600),retrievedAt}];
  }).slice(0,5);
  return {provider:'SearXNG',retrievedAt,sources,warnings};
}

/** The bundled sidecar accepts a fixed, read-only query API; the model cannot select a host or path. */
async function bundledQuery(params:URLSearchParams, signal:AbortSignal) {
  const response=await fetch('http://public-search:8080/search?'+params,{signal,redirect:'error',headers:{Accept:'application/json'}});
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error('工作台搜索服务未返回 JSON，HTTP '+response.status);
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  try {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      total+=part.value.byteLength;
      if (total>MAX_BODY_BYTES) throw new Error('搜索结果超过读取上限');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Construct the host tool with a replaceable transport for network-policy tests. */
export function createPublicNetworkOperation(transport: Transport, localQuery= bundledQuery) {
  let active = 0;
  const recentRequests: number[] = [];
  function reserveRequest() {
    const now=performance.now();
    while (recentRequests.length && recentRequests[0]! <= now-60000) recentRequests.shift();
    if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) throw new Error('公开网络请求过多，请稍后重试');
    recentRequests.push(now);
  }
  async function read(url: URL, signal: AbortSignal, searchOrigin?: string) {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const address = await pinAddress(url, transport, signal);
      reserveRequest();
      const response = await transport.get(url, address, signal);
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
        if (hop === MAX_REDIRECTS) throw new Error('公开来源重定向过多');
        url = safeUrl(new URL(response.location, url).href, searchOrigin);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`公开来源返回 HTTP ${response.status}`);
      if (!response.body || response.body.length > MAX_BODY_BYTES || !isReadable(response.contentType)) throw new Error('公开来源正文过大或格式不受支持');
      return {url, contentType: response.contentType!, body: response.body.toString('utf8'), checkedAt: new Date().toISOString()};
    }
    throw new Error('公开来源重定向过多');
  }

  async function execute(operation: 'fetch' | 'search', value: string, callerSignal?: AbortSignal, settings?: Pick<SearchSettings,'sources'|'endpoint'>, knownSource=false):Promise<NetworkResult> {
    const deadline = AbortSignal.timeout(CONNECT_DEADLINE_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    if (operation === 'fetch') {
      const allowOrigin=knownSource ? new URL(value).origin : undefined;
      const page = await read(safeUrl(value,allowOrigin), signal);
      const html = /^(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType);
      const title = html ? webText(/<title(?:\s[^>]{0,200})?>([^<]{0,300})/i.exec(page.body)?.[1] ?? '') : '';
      return {source: {title: title || page.url.hostname, url: page.url.href, retrievedAt: page.checkedAt, excerpt: (html ? webText(page.body) : page.body.trim()).slice(0, MAX_EXCERPT)}};
    }
    const query = value.trim();
    if (!/^[\p{L}\p{M}\p{N}\p{Zs}.,()'’\-·、（）]{1,120}$/u.test(query) || !/[\p{L}\p{N}]/u.test(query)) throw new Error('请输入 1–120 字的公开关键词');
    const config=settings ?? {sources:['wikipedia'],endpoint:''};
    if (!config.sources.length) throw new Error('尚未启用搜索来源，请在连接页设置');
    const engines=config.sources.filter(id=>id!=='wikipedia');
    async function wiki() {
      const host = /\p{Script=Han}/u.test(query) ? 'zh.wikipedia.org' : 'en.wikipedia.org';
      const source = new URL(`https://${host}/w/api.php`);
      source.search = new URLSearchParams({action: 'query', list: 'search', srlimit: '5', srnamespace: '0', srsearch: query, format: 'json', formatversion: '2'}).toString();
      const reply = await read(source, signal, source.origin);
      const payload = searchResponse.safeParse(JSON.parse(reply.body));
      if (!payload.success) throw new Error('维基百科搜索未返回可读结果');
      return {
        provider: 'Wikipedia', retrievedAt: reply.checkedAt,
        sources: payload.data.query.search.slice(0, 5).map(item => ({
          provider:'Wikipedia', title: item.title.slice(0, 300), url: `https://${host}/wiki/${encodeURIComponent(item.title.replaceAll(' ', '_'))}`,
          excerpt: webText(item.snippet).slice(0, 400), retrievedAt: reply.checkedAt,
        })),
      };
    }
    async function gateway() {
      const params=new URLSearchParams({q:query,format:'json',engines:engines.join(','),language:/\p{Script=Han}/u.test(query)?'zh-CN':'all'});
      let raw:string;
      if (config.endpoint) {
        const endpoint=safeUrl(config.endpoint);
        if (endpoint.pathname==='/' || endpoint.pathname.endsWith('/')) endpoint.pathname+='search';
        endpoint.search=params.toString();
        raw=(await read(endpoint,signal,endpoint.origin)).body;
      } else {
        reserveRequest();
        raw=await localQuery(params,signal);
      }
      return normalizeGateway(raw,new Date().toISOString(),engines);
    }
    if (!engines.length) return wiki();
    if (!config.sources.includes('wikipedia')) return gateway();
    const results=await Promise.allSettled([wiki(),gateway()]);
    signal.throwIfAborted();
    const merged = results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
    const warnings=results.flatMap((r,i)=>r.status==='rejected'?[(i===0?'Wikipedia':'SearXNG')+'：'+(r.reason instanceof Error?r.reason.message:'搜索失败')]:
      ('warnings' in r.value?r.value.warnings:[]));
    if (!merged.length) throw new Error(warnings.join('；'));
    const interleaved=Array.from({length:5},(_,i)=>merged.flatMap(r=>r.sources[i]?[r.sources[i]]:[])).flat();
    const unique=new Map(interleaved.map(source=>[source.url,source]));
    return {provider:merged.map(x=>x.provider).join(' / '),retrievedAt:new Date().toISOString(),sources:[...unique.values()].slice(0,5),warnings};

  }

  return async (operation: 'fetch' | 'search', value: string, callerSignal?: AbortSignal, settings?: Pick<SearchSettings,'sources'|'endpoint'>, knownSource=false) => {
    if (active >= MAX_ACTIVE_OPERATIONS) throw new Error('公开网络任务过多，请稍后重试');
    active++;
    try { return await execute(operation, value, callerSignal, settings,knownSource); }
    finally { active--; }
  };
}

export const publicNetworkOperation = createPublicNetworkOperation({
  resolve: host => lookup(host, {all: true}),
  get: requestPinned,
});
