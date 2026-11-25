import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Local OpenAI-compatible tool-calling fixture. Tests select the next call without interpreting natural language in production. */
export async function startEditorModelFixture(root:string, inspect?:(messages:unknown)=>void) {
  let offered=false,calls=0,reply='',tool='drama_workflow';
  const replyBudgets = new Set<number | undefined>();
  let pending:Record<string,unknown>|undefined;
  const model=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString());
    replyBudgets.add(request.max_tokens ?? request.max_completion_tokens);
    inspect?.(request.messages);
    offered ||= Array.isArray(request.tools)&&request.tools.some((t:{function:{name:string}})=>t.function.name==='drama_workflow');
    const action=pending;pending=undefined;calls++;
    const sse=(delta:unknown,finish_reason:string|null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end((action?sse({role:'assistant',tool_calls:[{index:0,id:'canvas_'+calls,type:'function',function:{name:tool,arguments:JSON.stringify(action)}}]},null)+sse({},'tool_calls'):
      sse({role:'assistant',content:reply},null)+sse({},'stop'))+'data: [DONE]\n\n');
  });
  const close=()=>new Promise<void>(done=>model.close(()=>done()));
  await new Promise<void>((done,reject)=>{model.once('error',reject);model.listen(0,'127.0.0.1',done);});
  try{
    const address=model.address();
    if(!address||typeof address==='string')throw new Error('Missing test provider port');
    const home=join(root,'dsh'),profile=join(home,'profiles','web');
    await mkdir(profile,{recursive:true});
    await writeFile(join(profile,'cordis.patch.yml'),JSON.stringify([{id:'llm-pi-ai',config:{providers:{fixture:{api:'openai-completions',baseURL:'http://127.0.0.1:'+address.port+'/v1',apiKeyEnv:'TEST_EDITOR_WIRE',models:[{id:'fixture',contextWindow:65536,maxTokens:4096}]}}}}]));
    await writeFile(join(home,'.env'),'TEST_EDITOR_WIRE=local-fixture\n');
    return {home,close,replyBudgets,get calls(){return calls;},get offered(){return offered;},
      respond(action:Record<string,unknown>,text:string,toolName='drama_workflow'){pending=action;reply=text;tool=toolName;}};
  }catch(error){await close();throw error;}
}
