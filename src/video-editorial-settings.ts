import { readFileSync } from 'node:fs';

// Persist local wording separately from workflow permissions and tool availability.
const defaults = {
  writingRules: [
    "交代本片主题、目标观众和预计时长。",
    "把需要核实的事实与对应素材或来源关联。",
    "按镜头整理旁白及字幕，标注需要补录的段落。"
  ],
  reviewChecklist: [
    "根据制作说明核对最终画面、旁白和字幕。",
    "逐段检查发音、字幕可读性、音量与画音同步。",
    "核对素材授权并记录待修改的时间点。"
  ],
  scriptFormat: "{rules}",
  audioInstruction: "提交短试听样本，标出发音、音量或停顿需要调整的时间点。",
  renderFormat: "{rules}",
  briefCompletion: "有明确的目标、素材范围和验收标准",
  scriptRole: "编剧",
  scriptCompletion: "按制作说明核对脚本、镜头与依据",
  audioCompletion: "先提供短试听，再完整听检发音、停顿和重音",
  audioExecutor: "macos_host",
  visualExecutor: "macos_host",
  renderExecutor: "macos_host",
  probeExecutor: "macos_host",
  reviewItems: [
    "按制作说明核对脚本、画面与字幕。",
    "完整试听旁白、背景声及画音同步。",
    "核对素材授权，记录需要返工的时间点。"
  ],
  numberedReview: false,
  reviewNote: ""
};

/** A configured path is required to exist; the standard local file is optional. */
function readEditorialSettings() {
  const configured = process.env.STUDIO_VIDEO_EDITORIAL_FILE;
  let raw: string;
  try {
    raw = readFileSync(configured ?? new URL('../../.local/video-editorial.json', import.meta.url), 'utf8');
  } catch (error) {
    if (configured === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return defaults;
    throw error;
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON in local video editorial settings');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Local video editorial settings must be an object');
  }
  const settings = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, key)) throw new Error('Unknown key in local video editorial settings');
    const fallback = defaults[key as keyof typeof defaults];
    if (Array.isArray(fallback) ? !Array.isArray(value) || !value.every(item => typeof item === 'string') : typeof value !== typeof fallback) {
      throw new Error(`Invalid value for video editorial setting ${key}`);
    }
    Object.assign(settings, { [key]: value });
  }
  if (!settings.scriptFormat.includes('{rules}') || !settings.renderFormat.includes('{rules}')) {
    throw new Error('scriptFormat and renderFormat must include {rules}');
  }
  return settings;
}

export const videoEditorialSettings = readEditorialSettings();

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Review guidance is rendered as plain text, including workbench-specific wording. */
export function renderVideoReviewPage(template: string): string {
  const { reviewItems, numberedReview, reviewNote } = videoEditorialSettings;
  const tag = numberedReview ? 'ol' : 'ul';
  const items = reviewItems.map(item => `<li>${escapeText(item)}</li>`).join('');
  const note = reviewNote ? `<p>${escapeText(reviewNote)}</p>` : '';
  return template.replace('<!-- video-review-checklist -->', () => `<${tag}>${items}</${tag}>${note}`);
}
