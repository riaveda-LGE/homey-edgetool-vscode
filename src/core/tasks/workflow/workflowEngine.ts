// === src/core/tasks/workflow/workflowEngine.ts ===

import { getLogger } from '../../logging/extension-logger.js';

export type StepResult = 'ok' | 'retry' | 'fail' | 'skip';

export interface StepCtx {
  runId: string;
  // 임의의 공유 데이터
  bag: Record<string, any>;
  // 취소 신호(필요시 확장)
  aborted?: boolean;
}

export interface Step {
  name: string;
  timeoutMs?: number;
  maxIterations?: number; // retry 루프 상한 (기본 1)
  run(ctx: StepCtx): Promise<StepResult>;
  next?(last: StepResult, ctx: StepCtx): string | undefined;
  onErrorPolicy?: 'stop' | 'continue';
}

export class WorkflowEngine {
  private log = getLogger('Workflow');
  constructor(private steps: Step[]) {}

  async runAll(runId: string, start?: string) {
    const ctx: StepCtx = { runId, bag: {} };
    const index = new Map(this.steps.map((s, i) => [s.name, i]));
    let i = typeof start === 'string' ? (index.get(start) ?? 0) : 0;
    for (; i < this.steps.length; i++) {
      const s = this.steps[i];
      const max = Math.max(1, s.maxIterations ?? 1);
      let iter = 0 as number;
      this.log.info(`[wf:${runId}] step=${s.name}`);
      while (iter++ < max) {
        try {
          const r = await withTimeout(s.run(ctx), s.timeoutMs);
          if (r === 'retry') {
            this.log.warn(`[wf:${runId}] step=${s.name} → retry (${iter}/${max})`);
            if (iter >= max) throw new Error('maxIterations reached');
            await sleep(1000 * Math.min(iter, 3)); // 가벼운 backoff
            continue;
          }
          if (r === 'fail') {
            throw new Error(`step returned fail: ${s.name}`);
          }
          const nxt = s.next?.(r, ctx);
          if (typeof nxt === 'string') {
            const j = index.get(nxt);
            if (typeof j === 'number') i = j - 1; // for-loop 증가 고려
          }
          break;
        } catch (e) {
          this.log.error(
            `[wf:${runId}] step=${s.name} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          if (s.onErrorPolicy !== 'continue') throw e;
          break;
        }
      }
    }
    return ctx.bag;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function withTimeout<T>(p: Promise<T>, t?: number): Promise<T> {
  if (!t || t <= 0) return p;
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${t}ms`)), t)),
  ]);
}
