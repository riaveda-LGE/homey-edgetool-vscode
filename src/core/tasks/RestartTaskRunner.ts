// === src/core/tasks/RestartTaskRunner.ts ===
import { resolveHomeyUnit } from '../service/serviceDiscovery.js';
import { ServiceFilePatcher } from '../service/ServiceFilePatcher.js';
import { HostStateGuard } from './guards/HostStateGuard.js';
import { WorkflowEngine } from './workflow/workflowEngine.js';

export class RestartTaskRunner {
  private guard = new HostStateGuard();

  async run() {
    const unit = await resolveHomeyUnit();
    const svc = new ServiceFilePatcher(unit);
    const steps: any[] = [];

    steps.push({ name: 'INIT', run: async () => 'ok' });
    steps.push({
      name: 'RESTART_SERVICE',
      run: async () => {
        await svc.restart();
        // edge-go: 첫 재시작 직후 서브상태 settling을 감안해 여유를 조금 준다
        const ok = await this.guard.waitForUnitActive(unit, 35_000, 1500);
        return ok ? 'ok' : 'retry';
      },
      maxIterations: 3,
    });
    steps.push({ name: 'POST_VERIFY', run: async () => 'ok' });

    const wf = new WorkflowEngine(steps);
    await wf.runAll(`restart-${Date.now()}`);
  }
}
