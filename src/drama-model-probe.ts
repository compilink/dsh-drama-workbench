import {randomUUID} from 'node:crypto';
import {CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, freezeMessage, MessageId, ReasoningEffortId, type LlmRuntime} from '@deepseek-ai/dsh-llm';
import type {ModelSelection} from './types.js';

export function modelProbeTimeout(value = process.env.STUDIO_MODEL_PROBE_TIMEOUT_MS): number {
  const ms = value === undefined ? 180_000 : Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 600_000) throw new Error('STUDIO_MODEL_PROBE_TIMEOUT_MS 必须为 1000–600000 的整数');
  return ms;
}

// Provider messages may include URLs, credentials, or request bodies. Only return fixed diagnostic text.
export function modelFailureMessage(error: unknown): string {
  const codes = new Set<string>();
  const statuses = new Set<number>();
  const messages: string[] = [];
  for (let depth = 0; error && typeof error === 'object' && depth < 4; depth++) {
    const item = error as {code?: unknown; status?: unknown; message?: unknown; cause?: unknown};
    if (typeof item.code === 'string') codes.add(item.code);
    if (typeof item.status === 'number') statuses.add(item.status);
    if (typeof item.message === 'string') messages.push(item.message);
    error = item.cause;
  }
  const has = (...values: string[]) => values.some(code => codes.has(code));
  const detail = messages.join(' ');
  if (has(CONTEXT_WINDOW_EXCEEDED_CODE) || isContextWindowExceededError(detail)) return '请求内容超过所选模型的上下文容量';
  if (has('AUTH','MISSING_CREDENTIAL','INVALID_CREDENTIAL') || statuses.has(401) || statuses.has(403)) return '模型服务拒绝授权，请检查该提供方的登录状态或 API 凭据。';
  if (has('MODEL_NOT_FOUND','UNKNOWN_MODEL','NO_MODEL') || /model.{0,120}(?:not found|does not exist|not installed)|unknown model/i.test(detail)) return '模型服务找不到所选模型，请确认模型已安装并刷新目录。';
  if (statuses.has(404) || /\b404\b/.test(detail)) return '模型服务返回 404，请核对接口地址与模型名称。';
  if (has('TIMEOUT','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT')) return '模型服务响应超时，请检查模型加载进度后重试。';
  if (has('TRANSPORT','ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','EHOSTUNREACH')) return '无法连接到模型服务，请检查服务地址、端口和运行状态。';
  if (has('RATE_LIMIT','QUOTA') || statuses.has(429)) return '模型服务限流或额度不足，请检查配额后重试。';
  if (has('EMPTY_RESPONSE','STREAM_CLOSED')) return '模型服务未返回可验证的文本。';
  return '模型服务未完成请求，请检查该提供方的运行日志。';
}

/** Checks the model transport directly, without allocating an Agent, workspace, or session. */
export async function probeConfiguredModel(llm: Pick<LlmRuntime,'stream'>, selection: ModelSelection, signal: AbortSignal, timeoutMs = modelProbeTimeout()) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const done = new AbortController();
  const request = AbortSignal.any([signal, timeout, done.signal]);
  const unavailable = (message: string) => ({status: 'unavailable' as const, message});
  const aborted = () => unavailable(timeout.aborted
    ? `连接测试等待 ${timeoutMs / 1000} 秒后超时。请查看模型加载进度，或调整工作台的连接测试时限。`
    : '连接测试已取消。');
  const message = freezeMessage({id: MessageId(randomUUID()), role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: 'Connectivity test. Reply with OK only.'}]});
  try {
    request.throwIfAborted();
    for await (const chunk of llm.stream({provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort ? {reasoningEffort: ReasoningEffortId(selection.reasoningEffort)} : {}),
      messages: [message], maxTokens: 32, signal: request})) {
      if (request.aborted) return aborted();
      const content = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? chunk.text
        : chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning') ? chunk.block.text : '';
      if (content.trim()) {
        done.abort();
        return {status: 'verified' as const, message: '已收到所选模型的真实响应。'};
      }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') return unavailable(modelFailureMessage(chunk.reason.failure));
        if (chunk.reason.kind === 'aborted') return unavailable('模型服务中止了连接测试。');
        break;
      }
    }
    return request.aborted ? aborted() : unavailable('模型服务未返回可验证的文本。');
  } catch (error) {
    return request.aborted ? aborted() : unavailable(modelFailureMessage(error));
  } finally {
    done.abort();
  }
}
