import assert from 'node:assert/strict';
import test from 'node:test';
import {createPublicNetworkOperation, isPublicAddress} from '../src/drama-network.js';

const publicV4 = {address: '8.8.8.8', family: 4};
const publicV6 = {address: '2606:4700:4700::1111', family: 6};
const html = (body: string) => ({status: 200, contentType: 'text/html; charset=UTF-8', body: Buffer.from(body)});

test('public network destinations exclude local and special-use IPv4, IPv6, and mapped addresses', () => {
  assert.equal(isPublicAddress(publicV4.address), true);
  assert.equal(isPublicAddress(publicV6.address), true);
  for (const address of [
    '0.0.0.0', '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.2',
    '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1', 'ff02::1',
    '2001:db8::1', '2002:7f00:1::1', '3fff::1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(address), false, address);
});

test('public fetch pins normalized addresses before every hop and fails closed on mixed DNS answers', async () => {
  const resolutions: string[] = [];
  const requests: Array<[string, string]> = [];
  const network = createPublicNetworkOperation({
    resolve: async host => {
      resolutions.push(host);
      return host === 'second.example.com' ? [publicV6, {address: '127.0.0.1', family: 4}] : [publicV6, publicV4];
    },
    get: async (url, pinned) => {
      requests.push([url.href, pinned.address]);
      return {status: 302, location: 'https://second.example.com/article'};
    },
  });
  await assert.rejects(network('fetch', 'https://first.example.com/a#frag'), /禁止的地址/);
  assert.deepEqual(resolutions, ['first.example.com', 'second.example.com']);
  assert.deepEqual(requests, [['https://first.example.com/a', publicV4.address]]);
});

test('public URL validation rejects local aliases, credentials, other schemes, ports, and input query data', async () => {
  const network = createPublicNetworkOperation({
    resolve: async () => { throw new Error('DNS should not be reached'); },
    get: async () => { throw new Error('HTTP should not be reached'); },
  });
  for (const url of [
    'https://127.1/path', 'https://0x7f000001/path', 'https://[::1]/path', 'https://home.arpa/path',
    'https://host.local/path', 'https://localhost./path', 'https://single-label/path',
    'https://user@example.com/path', 'file:///tmp/file', 'http://example.com/path',
    'https://example.com:8443/path', 'https://example.com/path?private=value',
  ]) await assert.rejects(network('fetch', url), /只允许|不允许|禁止的地址/);
});

test('public fetch removes embedded HTML code, bounds response size, and records a source', async () => {
  const network = createPublicNetworkOperation({
    resolve: async () => [publicV4],
    get: async url => url.pathname === '/large' ? {status: 200, contentType: 'text/plain', body: Buffer.alloc(512 * 1024 + 1)} :
      html('<html><head><title>İ &amp; 剧本</title><script>omit</script></head><body>可核对的来源。<!--omit--></body></html>'),
  });
  const result = await network('fetch', 'https://example.com/article');
  assert.ok('source' in result && result.source);
  assert.equal(result.source.title, 'İ & 剧本');
  assert.equal(result.source.url, 'https://example.com/article');
  assert.match(result.source.excerpt, /可核对的来源/);
  assert.doesNotMatch(result.source.excerpt, /omit|<script>/);
  assert.ok(Date.parse(result.source.retrievedAt));
  await assert.rejects(network('fetch', 'https://example.com/large'), /过大/);
});

test('Wikipedia search uses a fixed public provider, normalizes excerpts, and validates user input', async () => {
  const network = createPublicNetworkOperation({
    resolve: async host => { assert.equal(host, 'zh.wikipedia.org'); return [publicV4]; },
    get: async url => {
      assert.equal(url.origin, 'https://zh.wikipedia.org');
      assert.equal(url.pathname, '/w/api.php');
      assert.equal(url.searchParams.get('srsearch'), '香港 电影');
      assert.equal(url.searchParams.get('srlimit'), '5');
      const result = {query: {search: [{title: '香港電影', pageid: 10, snippet: '<span>香港</span> &amp; 電影'}]}};
      return {status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(result))};
    },
  });
  const result = await network('search', '香港 电影');
  assert.equal(result.provider, 'Wikipedia');
  assert.equal(result.sources?.[0].excerpt, '香港 & 電影');
  assert.equal(decodeURI(result.sources![0].url), 'https://zh.wikipedia.org/wiki/香港電影');
  await assert.rejects(network('search', 'line\nbreak'), /公开关键词/);
  const redirected = createPublicNetworkOperation({resolve: async () => [publicV4], get: async () => ({status: 307, location: 'https://example.org/w/api.php'})});
  await assert.rejects(redirected('search', '香港 电影'), /跳转目标不允许/);
});

test('public egress cancellation and rate limits prevent queued fetches from reaching the transport', async () => {
  const controller = new AbortController();
  const pending = createPublicNetworkOperation({
    resolve: async () => new Promise(() => {}),
    get: async () => { throw new Error('HTTP should not be reached'); },
  });
  const result = pending('fetch', 'https://example.com/path', controller.signal);
  controller.abort(new Error('owner revoked'));
  await assert.rejects(result, /owner revoked/);
  let count = 0;
  const network = createPublicNetworkOperation({resolve: async () => [publicV4], get: async () => { count++; return html('readable'); }});
  for (let i = 0; i < 30; i++) await network('fetch', 'https://example.com/path');
  await assert.rejects(network('fetch', 'https://example.com/path'), /请求过多/);
  assert.equal(count, 30);
});
