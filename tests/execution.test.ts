/** Container isolation checks are opt-in; configuration and path guards run without Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DockerExecution, dockerClientEnvironment, resolveExecution, validateWorkspacePath } from '../src/execution.js';
import type { ExecutionContext } from '../src/execution.js';

const digest='node@sha256:'+'a'.repeat(64);
const context=():ExecutionContext=>({runId:randomUUID(),taskId:randomUUID(),attemptId:randomUUID(),workerId:randomUUID()});

test('container configuration requires an immutable explicit image and bounded host-owned resources',()=>{
  assert.equal(resolveExecution().enabled,false);
  assert.throws(()=>resolveExecution({enabled:true}),/explicitly configured immutable image/);
  for(const image of ['node:latest','node:24','x --privileged','node@sha256:xyz'])assert.throws(()=>resolveExecution({enabled:true,image}),/immutable/);
  for(const value of [0,-1,1.5,Number.NaN,1_000_000])assert.throws(()=>resolveExecution({timeoutMs:value}),/integer/);
  assert.throws(()=>resolveExecution({cpus:0}),/cpus/);
  const value=resolveExecution({enabled:true,image:digest});assert.equal(value.network,'none');assert.equal(value.memoryMb,256);
});

test('Docker client environment excludes model credentials and file paths reject parent traversal',()=>{
  const env=dockerClientEnvironment({PATH:'/bin',HOME:'/test',DEEPSEEK_API_KEY:'secret',OPENAI_API_KEY:'secret',TOKEN:'secret',DOCKER_CONTEXT:'desktop-linux'});
  assert.deepEqual(env,{PATH:'/bin',HOME:'/test',DOCKER_CONTEXT:'desktop-linux'});
  for(const value of ['/etc/passwd','../secret','a/../../x','a\\..\\x','x\0y',''])assert.throws(()=>validateWorkspacePath(value),/relative/);
  assert.equal(validateWorkspacePath('src/main.js'),'src/main.js');assert.equal(validateWorkspacePath('',true),'.');
});

test('disabled execution rejects commands and file access without contacting Docker',async()=>{
  const provider=new DockerExecution({}, {dataDir:'/tmp/studio-disabled'});await provider.initialize();
  await assert.rejects(provider.execute(context(),{command:'true'}),/disabled/);
  await assert.rejects(provider.readFile(context(),{path:'a.txt'}),/disabled/);
  await provider.removeAttemptWorkspaces([context().attemptId]);
  await provider.close();
});

const image=process.env.STUDIO_TEST_DOCKER_IMAGE;
test('restart cleanup removes only this data directory\'s labeled containers',{skip:!image,timeout:60_000},async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'studio-docker-reap-'));
  const provider=new DockerExecution({enabled:true,image},{dataDir});
  const docker=(args:string[])=>execFileSync('docker',args,{env:dockerClientEnvironment(),encoding:'utf8'}).trim();
  const created:string[]=[];
  try{
    for(const owner of [provider.ownerId,`other-${randomUUID()}`])created.push(docker(['run','-d','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user','1000:1000','--label',`dev.dsh-agent-studio.owner=${owner}`,'--label','dev.dsh-agent-studio.managed=worker','--entrypoint','/bin/sh',image!,'-c','sleep 60']));
    await provider.initialize();
    assert.equal(docker(['ps','-aq','--filter',`id=${created[0]}`]),'');
    assert.ok(docker(['ps','-q','--filter',`id=${created[1]}`]));
    const closing=provider.close();assert.equal(provider.close(),closing);await closing;
  }finally{await provider.close();for(const id of created)if(docker(['ps','-aq','--filter',`id=${id}`]))docker(['rm','-f',id]);await rm(dataDir,{recursive:true,force:true});}
});

test('real local containers isolate files, host secrets and network, preserve artifacts, and reap timed-out process trees',{skip:!image,timeout:120_000},async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'studio-docker-test-'));
  const provider=new DockerExecution({enabled:true,image,timeoutMs:10_000,maxOutputBytes:8192},{dataDir});
  const a=context(),b=context();
  const docker=(args:string[])=>execFileSync('docker',args,{env:dockerClientEnvironment(),encoding:'utf8'}).trim();
  const cleanup=()=>{
    const volumes=docker(['volume','ls','-q','--filter',`label=dev.dsh-agent-studio.owner=${provider.ownerId}`]);
    if(volumes)docker(['volume','rm',...volumes.split(/\s+/)]);
  };
  try {
    await provider.initialize();
    assert.ok((await provider.writeFile(a,{path:'src/answer.js',content:"require('node:fs').writeFileSync('/workspace/result.txt',String(6*7))"})).bytesWritten>0);
    const computed=await provider.execute(a,{command:'node src/answer.js'});assert.equal(computed.exitCode,0);assert.equal(computed.timedOut,false);
    assert.equal((await provider.readFile(a,{path:'result.txt'})).content,'42');
    assert.equal((await provider.listFiles(a)).entries.some(entry=>entry.name==='result.txt'),true);
    await assert.rejects(provider.readFile(b,{path:'result.txt'}),/ENOENT/);
    const isolated=await provider.execute(a,{command:`node -e 'console.log(JSON.stringify({uid:process.getuid(),env:process.env,net:Object.keys(require("node:os").networkInterfaces()),host:require("node:fs").existsSync(Buffer.from("${Buffer.from(dataDir).toString('base64')}","base64").toString()),socket:require("node:fs").existsSync("/var/run/docker.sock")}))'`});
    const info=JSON.parse(isolated.stdout) as {uid:number;env:Record<string,string>;net:string[];host:boolean;socket:boolean};
    assert.equal(info.uid,1000);assert.deepEqual(info.net,['lo']);assert.equal(info.host,false);assert.equal(info.socket,false);assert.equal(info.env.DEEPSEEK_API_KEY,undefined);assert.equal(info.env.OPENAI_API_KEY,undefined);
    const readOnly=await provider.execute(a,{command:'touch /root/escape'});assert.notEqual(readOnly.exitCode,0);
    assert.equal((await provider.execute(a,{command:'ln -s /etc link; mkfifo pipe'})).exitCode,0);
    await assert.rejects(provider.readFile(a,{path:'link/passwd'}),/Symbolic links/);
    await assert.rejects(provider.writeFile(a,{path:'link/new',content:'bad'}),/Symbolic links/);
    await assert.rejects(provider.readFile(a,{path:'pipe'}),/regular file/);
    const timed=await provider.execute(a,{command:'(sleep 3; echo escaped > late.txt) & wait',timeoutMs:200});assert.equal(timed.timedOut,true);
    const aborter=new AbortController();const pending=provider.execute(a,{command:'sleep 60'},aborter.signal);setTimeout(()=>aborter.abort(),300);
    const aborted=await pending;assert.equal(aborted.aborted,true);
    const overflowing=await provider.execute(a,{command:"node -e 'process.stdout.write(\"x\".repeat(100000))'"});assert.equal(overflowing.outputLimitExceeded,true);assert.ok(Buffer.byteLength(overflowing.stdout)+Buffer.byteLength(overflowing.stderr)<=8192);
    assert.equal(docker(['ps','-aq','--filter',`label=dev.dsh-agent-studio.owner=${provider.ownerId}`]),'');
    await provider.close();
    const restored=new DockerExecution({enabled:true,image,timeoutMs:10_000},{dataDir});
    try {
      await restored.initialize();
      assert.equal((await restored.readFile(a,{path:'result.txt'})).content,'42');
      await assert.rejects(restored.readFile(a,{path:'late.txt'}),/ENOENT/);
      const attemptVolumes = (id: string) => docker(['volume','ls','-q','--filter',`label=dev.dsh-agent-studio.attempt=${id}`]);
      assert.ok(attemptVolumes(a.attemptId));
      const relocated = new DockerExecution({enabled:true,image},{dataDir:dataDir+'-moved'});
      try {
        await relocated.initialize();
        await assert.rejects(relocated.removeAttemptWorkspaces([a.attemptId]), /原 Docker/);
        assert.ok(attemptVolumes(a.attemptId));
      } finally { await relocated.close(); }
      await restored.removeAttemptWorkspaces([a.attemptId]);
      await restored.removeAttemptWorkspaces([a.attemptId]);
      assert.equal(attemptVolumes(a.attemptId),'');
      assert.ok(attemptVolumes(b.attemptId));
    } finally { await restored.close(); }
  } finally {await provider.close();cleanup();await rm(dataDir,{recursive:true,force:true});}
});
