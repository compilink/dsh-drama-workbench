import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPublicNetworkOperation } from '../src/drama-network.js';
import { DramaSearchSettings } from '../src/drama-search-settings.js';

test('saved search sources survive reopening, reject stale changes and require a usable gateway',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const store=new DramaSearchSettings(db,false);
    assert.deepEqual(store.read().sources,['wikipedia']);
    for(const endpoint of ['','http://intranet.local/','https://127.0.0.1/', 'https://public.example.org/?key=hidden']) {
      assert.throws(()=>store.save({expectedVersion:0,sources:['bing'],endpoint}));
    }
    const endpoint='https://search.example.org/search';
    const saved=store.save({expectedVersion:0,sources:['google','baidu'],endpoint});
    assert.equal(saved.version,1);
    assert.deepEqual(new DramaSearchSettings(db,false).read(),{version:1,sources:['google','baidu'],endpoint});
    assert.throws(()=>store.save({expectedVersion:0,sources:[],endpoint}),/其他窗口/);
    assert.throws(()=>store.save({expectedVersion:1,sources:['unlisted'],endpoint}));
  } finally {db.close();}
});

test('only selected engines receive queries and only their public results are returned',async()=>{
  const calls:string[]=[];
  const network=createPublicNetworkOperation({resolve:async()=>{throw Error('no external call expected')}, get:async()=>{throw Error('unexpected')}},async params=>{
    calls.push(params.get('engines')!);
    assert.equal(params.get('q'),'古代家具');
    return JSON.stringify({results:[
      {engine:'baidu',title:'家具',url:'https://museum.org/article?id=32',content:'<em>家具</em>沿革'},
      {engine:'google',title:'wrong',url:'https://example.org/wrong'},
      {engine:'baidu',title:'internal',url:'https://127.0.0.1/local'}],unresponsive_engines:[['bing','timeout']]});
  });
  const result=await network('search','古代家具',undefined,{sources:['baidu','bing'],endpoint:''});
  assert.deepEqual(calls,['baidu,bing']);
  assert.equal(result.sources?.length,1);
  assert.equal(result.sources?.[0].provider,'baidu');
  assert.equal(result.sources?.[0].excerpt,'家具 沿革');
  assert.match(result.warnings!.join(' '),/bing/);
  await assert.rejects(network('search','古代家具',undefined,{sources:[],endpoint:''}),/尚未启用/);
});

test('configured HTTPS gateway pins destination and reports provider outage instead of substituting unselected sources',async()=>{
  const network=createPublicNetworkOperation({resolve:async host=>{assert.equal(host,'search.example.org');return [{address:'8.8.8.8',family:4}];},get:async url=>{
    assert.equal(url.pathname,'/search');assert.equal(url.searchParams.get('engines'),'sogou');
    return {status:200,contentType:'application/json',body:Buffer.from(JSON.stringify({results:[],unresponsive_engines:[['sogou','timeout']]}))};
  }});
  await assert.rejects(network('search','茶馆',undefined,{sources:['sogou'],endpoint:'https://search.example.org'}),/sogou 未响应/);
});

test('an exact result URL recorded by the host can be read with its original query; arbitrary query URLs remain blocked',async()=>{
  const network=createPublicNetworkOperation({resolve:async()=>[{address:'8.8.8.8',family:4}],get:async url=>{
    assert.equal(url.searchParams.get('id'),'456');
    return {status:200,contentType:'text/plain',body:Buffer.from('article')};
  }});
  await assert.rejects(network('fetch','https://public.example.org/item?id=456'),/查询参数/);
  const response=await network('fetch','https://public.example.org/item?id=456',undefined,undefined,true);
  assert.equal(response.source?.excerpt,'article');
});
