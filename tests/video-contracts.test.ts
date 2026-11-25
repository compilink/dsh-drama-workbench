import test from 'node:test';
import assert from 'node:assert/strict';
import {VIDEO_ROLE_CONTRACTS,VIDEO_TOOL_CONTRACTS,stageContractPrompt,stageReadiness,type ContractStage} from '../src/video-role-contracts.js';
import {VIDEO_STAGES} from '../src/video-pipeline.js';
test('curated role contracts agree with real workflow and never invent adapter availability',()=>{
 for(const stage of Object.keys(VIDEO_STAGES) as ContractStage[]){
  assert.deepEqual([...VIDEO_ROLE_CONTRACTS[stage].inputs],[...VIDEO_STAGES[stage]]);
  assert.equal(stageReadiness(stage,VIDEO_STAGES[stage]).missingInputs.length,0);
  assert.match(stageContractPrompt(stage),/禁止付费服务/);
  for(const tool of VIDEO_ROLE_CONTRACTS[stage].tools)assert.ok(VIDEO_TOOL_CONTRACTS[tool]);
 }
 assert.deepEqual(stageReadiness('render',['audio']).missingInputs,['visuals']);
 assert.deepEqual(stageReadiness('render',['audio','visuals']).pendingAdapters,['local_render']);
 assert.match(stageContractPrompt('audio'),/adapter_pending/);
});
