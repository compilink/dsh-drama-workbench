/** Explicit opt-in real Docker verification with temporary, exclusively owned resources. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DockerExecution,dockerClientEnvironment} from '../dist/src/execution.js';

const image=process.env.STUDIO_TEST_DOCKER_IMAGE;
if(!image)throw new Error('Set STUDIO_TEST_DOCKER_IMAGE to an explicitly trusted local image@sha256 digest. This test creates real containers.');
const dataDir=await mkdtemp(join(tmpdir(),'studio-container-smoke-'));
const provider=new DockerExecution({enabled:true,image,timeoutMs:10_000,maxOutputBytes:16_384},{dataDir});
const context={runId:randomUUID(),taskId:randomUUID(),attemptId:randomUUID(),workerId:randomUUID()};
const docker=args=>execFileSync('docker',args,{encoding:'utf8',env:dockerClientEnvironment(),timeout:15_000}).trim();
const report={verifiedAt:new Date().toISOString(),image,passed:false,checks:{}};
try{
  await provider.initialize();
  await provider.writeFile(context,{path:'src/answer.js',content:"const fs=require('node:fs'); fs.writeFileSync('/workspace/answer.txt',String(6*7)); console.log('executed');"});
  const executed=await provider.execute(context,{command:'node src/answer.js'});assert.equal(executed.exitCode,0);assert.equal(executed.stdout.trim(),'executed');
  assert.equal((await provider.readFile(context,{path:'answer.txt'})).content,'42');
  report.checks.codeAndFileExecution=true;
  const identity=await provider.execute(context,{command:`node -e 'console.log(JSON.stringify({uid:process.getuid(),node:process.version,interfaces:Object.keys(require("node:os").networkInterfaces()),hostDataDir:require("node:fs").existsSync(Buffer.from("${Buffer.from(dataDir).toString('base64')}","base64").toString()),dockerSocket:require("node:fs").existsSync("/var/run/docker.sock"),keys:Object.keys(process.env).filter(k=>/KEY|SECRET|TOKEN|PASSWORD/.test(k))}))'`});
  report.containerIdentity=JSON.parse(identity.stdout);assert.equal(report.containerIdentity.uid,1000);assert.deepEqual(report.containerIdentity.interfaces,['lo']);assert.equal(report.containerIdentity.hostDataDir,false);assert.equal(report.containerIdentity.dockerSocket,false);assert.deepEqual(report.containerIdentity.keys,[]);
  report.checks.hostCredentialsAndNetworkIsolated=true;
  const controller=new AbortController();const running=provider.execute(context,{command:'sleep 60'},controller.signal);
  let container;
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){const ids=docker(['ps','-q','--filter',`label=dev.dsh-agent-studio.owner=${provider.ownerId}`,'--filter','label=dev.dsh-agent-studio.managed=worker']);if(ids){container=JSON.parse(docker(['inspect',ids.split(/\s+/)[0]]))[0];break;}await delay(20);}
  assert.ok(container,'execution container became visible');
  report.hardening={user:container.Config.User,readOnlyRootfs:container.HostConfig.ReadonlyRootfs,privileged:container.HostConfig.Privileged,network:container.HostConfig.NetworkMode,capDrop:container.HostConfig.CapDrop,securityOpt:container.HostConfig.SecurityOpt,pidsLimit:container.HostConfig.PidsLimit,memoryBytes:container.HostConfig.Memory,nanoCpus:container.HostConfig.NanoCpus,mounts:container.Mounts.map(m=>({type:m.Type,destination:m.Destination,rw:m.RW})),binds:container.HostConfig.Binds};
  assert.equal(report.hardening.user,'1000:1000');assert.equal(report.hardening.readOnlyRootfs,true);assert.equal(report.hardening.privileged,false);assert.equal(report.hardening.network,'none');assert.ok(report.hardening.capDrop.includes('ALL'));assert.ok(report.hardening.securityOpt.includes('no-new-privileges'));assert.equal(report.hardening.pidsLimit,64);assert.ok(report.hardening.memoryBytes>0);assert.ok(report.hardening.nanoCpus>0);assert.equal(report.hardening.binds,null);assert.equal(report.hardening.mounts.some(m=>m.type==='bind'),false);assert.equal(report.hardening.mounts.filter(m=>m.type==='volume').length,1);
  controller.abort();assert.equal((await running).aborted,true);report.checks.abortReapsContainer=true;
  const timed=await provider.execute(context,{command:'(sleep 2; echo survived > should-not-exist.txt) & wait',timeoutMs:200});assert.equal(timed.timedOut,true);await delay(2200);await assert.rejects(provider.readFile(context,{path:'should-not-exist.txt'}),/ENOENT/);report.checks.timeoutReapsDescendants=true;
  assert.equal((await provider.execute(context,{command:'ln -s /etc escape'})).exitCode,0);await assert.rejects(provider.readFile(context,{path:'escape/passwd'}),/Symbolic links/);report.checks.symlinkEscapeRejected=true;
  const other={...context,attemptId:randomUUID()};await assert.rejects(provider.readFile(other,{path:'answer.txt'}),/ENOENT/);report.checks.attemptVolumesIsolated=true;
  await provider.close();
  const restored=new DockerExecution({enabled:true,image},{dataDir});try{await restored.initialize();assert.equal((await restored.readFile(context,{path:'answer.txt'})).content,'42');}finally{await restored.close();}
  report.checks.artifactsSurviveProviderRestart=true;
  assert.equal(docker(['ps','-aq','--filter',`label=dev.dsh-agent-studio.owner=${provider.ownerId}`]),'');report.checks.noRemainingContainers=true;report.passed=true;
}catch(error){report.error=String(error);throw error;}
finally{
  await provider.close();
  const volumes=docker(['volume','ls','-q','--filter',`label=dev.dsh-agent-studio.owner=${provider.ownerId}`,'--filter','label=dev.dsh-agent-studio.managed=workspace']);if(volumes)docker(['volume','rm',...volumes.split(/\s+/)]);
  await rm(dataDir,{recursive:true,force:true});
  if(process.env.STUDIO_EVIDENCE_PATH)await writeFile(process.env.STUDIO_EVIDENCE_PATH,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
