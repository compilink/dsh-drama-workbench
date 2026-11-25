import { videoEditorialSettings as settings } from './video-editorial-settings.js';

/** Original, selected production roles. No imported prompts, paid tools or credentials. */
export const VIDEO_ROLE_CONTRACTS = {
 brief: {role:'制片协调',inputs:[],output:'brief.json：观众、一个核心判断、证据需求、时长、验收清单',tools:['task_delegate','artifact_manifest'],done:settings.briefCompletion},
 script: {role:settings.scriptRole,inputs:['brief'],output:'script.json：逐句旁白、对应依据、必要条件、预估时长',tools:['artifact_read','text_write'],done:settings.scriptCompletion},
 storyboard: {role:'分镜设计',inputs:['script'],output:'storyboard.json：镜头ID、起止时间、画面动作、字幕、素材来源',tools:['artifact_read','text_write'],done:'每句脚本有镜头承接，素材来源和使用条件明确'},
 audio: {role:'声音制作',inputs:['script'],output:'试听候选与声音选择记录，再交付单条混音音频',tools:['artifact_read','local_audio'],done:settings.audioCompletion},
 visuals: {role:'视觉制作',inputs:['storyboard'],output:'素材清单及文件：镜头对应、尺寸、许可依据',tools:['artifact_read','local_visual'],done:'无私人信息、凭据及无授权素材'},
 render: {role:'剪辑交付',inputs:['audio','visuals'],output:'单视频轨+单混合音轨MP4，以及时间线清单',tools:['artifact_read','local_render','technical_probe'],done:'完整解码通过，并交独立编辑审查和用户审片'},
} as const;
export type ContractStage=keyof typeof VIDEO_ROLE_CONTRACTS;
export const VIDEO_TOOL_CONTRACTS = {
 task_delegate:{executor:'existing_task_engine',state:'available',boundary:'既有层级和任务所有权；不发放宿主执行权限'},
 artifact_manifest:{executor:'host',state:'available',boundary:'仅内容哈希、大小和阶段；不含凭据'},
 artifact_read:{executor:'host_handoff',state:'available',boundary:'明确输入根、内容寻址、完整性校验；容器自动二进制交接仍待接入'},
 text_write:{executor:'worker_artifact',state:'manual_handoff',boundary:'仅任务产物，经宿主白名单导入；不任意写宿主路径'},
 local_audio:{executor:settings.audioExecutor,state:'adapter_pending',boundary:'免费本机工具；显式素材输入；先试听，禁止付费接口或上传'},
 local_visual:{executor:settings.visualExecutor,state:'adapter_pending',boundary:'免费本机素材制作；不自动下载/安装工具'},
 local_render:{executor:settings.renderExecutor,state:'adapter_pending',boundary:'固定参数和受控素材目录；无凭据、网络、社媒发布'},
 technical_probe:{executor:settings.probeExecutor,state:'available',boundary:'现有Swift全解码；失败阻断；不等于编辑或用户批准'},
} as const;
export function stageContractPrompt(stage:ContractStage):string {
 const c=VIDEO_ROLE_CONTRACTS[stage];
 return `精选职责：${c.role}\n交付契约：${c.output}\n完成标准：${c.done}\n工具契约（不是新增执行权限）：${c.tools.map(t=>`${t}=${VIDEO_TOOL_CONTRACTS[t].state}`).join(', ')}\n待接入工具不得伪称调用成功；可提交明确的人工交接产物。禁止付费服务、安装软件、索取凭据、上传或发布。`;
}
export function stageReadiness(stage:ContractStage,accepted:readonly string[]) {
 const c=VIDEO_ROLE_CONTRACTS[stage];
 return {stage,role:c.role,missingInputs:c.inputs.filter(x=>!accepted.includes(x)),pendingAdapters:c.tools.filter(t=>VIDEO_TOOL_CONTRACTS[t].state==='adapter_pending'),output:c.output};
}
