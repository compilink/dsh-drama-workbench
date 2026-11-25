import { videoEditorialSettings as settings } from './video-editorial-settings.js';

export const VIDEO_WRITING_RULES: readonly string[] = settings.writingRules;
export const VIDEO_EDITORIAL_CHECKLIST: readonly string[] = settings.reviewChecklist;

export function videoStageEditorialInstruction(stage: string): string {
  if (stage === 'script') return settings.scriptFormat.replace('{rules}', () => VIDEO_WRITING_RULES.join('\n'));
  if (stage === 'audio') return settings.audioInstruction;
  if (stage === 'render') return settings.renderFormat.replace('{rules}', () => VIDEO_EDITORIAL_CHECKLIST.join('\n'));
  return '';
}
