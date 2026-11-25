/** Review criteria used by the optional local video pipeline. */
export const VIDEO_WRITING_RULES = [
  '交代本片主题、目标观众和预计时长。',
  '把需要核实的事实与对应素材或来源关联。',
  '按镜头整理旁白及字幕，标注需要补录的段落。',
] as const;
export const VIDEO_EDITORIAL_CHECKLIST = [
  '根据制作说明核对最终画面、旁白和字幕。',
  '逐段检查发音、字幕可读性、音量与画音同步。',
  '核对素材授权并记录待修改的时间点。',
] as const;
export function videoStageEditorialInstruction(stage: string): string {
  if(stage==='script')return VIDEO_WRITING_RULES.join('\n');
  if(stage==='audio')return '提交短试听样本，标出发音、音量或停顿需要调整的时间点。';
  if(stage==='render')return VIDEO_EDITORIAL_CHECKLIST.join('\n');
  return '';
}
