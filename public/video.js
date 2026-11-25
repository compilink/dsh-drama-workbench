let csrf;
const notice=document.querySelector('#notice');
async function api(path,data){const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Studio-CSRF':csrf},body:JSON.stringify(data)});const result=await r.json();if(!r.ok)throw Error(result.error||r.status);return result;}
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
function button(text,action){const b=el('button',text);b.type='button';b.onclick=async()=>{b.disabled=true;try{notice.textContent='处理中…';await action();notice.textContent='已完成';await refresh();}catch(e){notice.textContent=e.message;}finally{b.disabled=false;}};return b;}
async function refresh(){const rows=await api('/api/video');const root=document.querySelector('#jobs');root.replaceChildren();for(const {job,review} of rows){
 const section=el('article');section.append(el('h2',job.brief),el('p',`状态：${review.status} · 发布器：未接入`));
 const plan=await api(`/api/video/${job.id}/plan`).catch(()=>[{status:"计划接口尚未加载，请重启最新构建服务"}]);const details=el('details');details.append(el('summary','职责、交付与工具就绪情况'),el('pre',JSON.stringify(plan,null,2)));section.append(details);
 const stageList=el('ul');for(const stage of ['brief','script','storyboard','audio','visuals','render']){const s=job.stages[stage],row=el('li',`${stage}: ${s?s.artifact?'产物已接收':`任务 ${s.taskId}`:'未入队'} `);if(!job.importedRender){if(!s)row.append(button('加入任务',()=>api(`/api/video/${job.id}/stage`,{stage})));else if(!s.artifact)row.append(button('导入产物',async()=>{const source=prompt('专用输入目录内产物的绝对路径');if(source)await api(`/api/video/${job.id}/artifact`,{stage,source});}));}stageList.append(row);}section.append(stageList);
 if(job.importedRender)section.append(el('p','来源：已有成片导入。未声称由本系统自动制作。'));
 if(review.hash&&review.status!=='integrity_failed'){
  section.append(el('p',`SHA-256：${review.hash}`));const player=el('video');player.controls=true;player.preload='metadata';player.width=480;player.src=`/api/video/${job.id}/preview?hash=${review.hash}`;section.append(player);
  section.append(button('运行本机完整技术质检',()=>api(`/api/video/${job.id}/probe`,{})));
  if(job.technical)section.append(el('pre',JSON.stringify(job.technical,null,2)));
  if(review.decision)section.append(el('p',`用户决定：${review.decision.approved?'同意此版本':'不发布'}；${review.decision.at}；${review.decision.note}`));
  const label=el('label'),check=el('input');check.type='checkbox';label.append(check,document.createTextNode(' 我是账号所有者，已完整观看并听完上方这一哈希版本。'));section.append(label);
  const note=el('textarea');note.placeholder='审片意见（可选）';note.maxLength=2000;section.append(note);
  for(const approved of [false,true])section.append(button(approved?'明确同意此版本（不会自动发布）':'不发布，退回修改',async()=>{if(!check.checked)throw Error('请先完整审看并勾选确认');if(approved&&!confirm(`确认同意文件 ${review.hash}？此操作仅记录审片决定，不会发布。`))return;await api(`/api/video/${job.id}/decision`,{hash:review.hash,approved,note:note.value,ownerAttestation:'I reviewed this exact video'});}));
 }root.append(section);
}}
(async()=>{try{csrf=(await api('/api/bootstrap')).csrfToken;const state=await api('/api/state');const runs=document.querySelector('#run');for(const r of state.runs){const o=el('option',r.title);o.value=r.id;runs.append(o);}await refresh();}catch(e){notice.textContent=e.message;}})();
document.querySelector('#refresh').onclick=()=>refresh().catch(e=>notice.textContent=e.message);
document.querySelector('#create').onsubmit=async e=>{e.preventDefault();try{await api('/api/video',{runId:document.querySelector('#run').value,brief:document.querySelector('#brief').value,source:document.querySelector('#source').value||undefined});await refresh();}catch(e){notice.textContent=e.message;}};
