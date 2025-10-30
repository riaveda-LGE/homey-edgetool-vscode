import { ErrorCategory, XError } from '../../shared/errors.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';
import { MountTaskRunner } from '../tasks/MountTaskRunner.js';
import { UnmountTaskRunner } from '../tasks/UnmountTaskRunner.js';
import { ToggleTaskRunner } from '../tasks/ToggleTaskRunner.js';
import { RestartTaskRunner } from '../tasks/RestartTaskRunner.js';

const log = getLogger('HomeyController');

export class HomeyController {
  constructor() {}

  private async ensureConnected() {
    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
  }

  @measure()
  async restart() {
    log.debug('[debug] HomeyController restart: start');
    await this.ensureConnected();
    await new RestartTaskRunner().run();
    log.debug('[debug] HomeyController restart: end');
  }

  @measure()
  async mount(modes: Array<'pro'|'core'|'sdk'|'bridge'> = ['pro']) {
    log.debug('[debug] HomeyController mount: start');
    await this.ensureConnected();
    const runner = new MountTaskRunner(modes);
    await runner.run();
    log.debug('[debug] HomeyController mount: end');
  }

  @measure()
  async unmount() {
    log.debug('[debug] HomeyController unmount: start');
    await this.ensureConnected();
    const runner = new UnmountTaskRunner();
    await runner.run();
    log.debug('[debug] HomeyController unmount: end');
  }

  @measure()
  async toggleAppLog(enable: boolean) {
    log.debug('[debug] HomeyController toggleAppLog: start', { enable });
    await this.ensureConnected();
    await new ToggleTaskRunner('HOMEY_APP_LOG', enable).run();
    log.debug('[debug] HomeyController toggleAppLog: end');
  }

  @measure()
  async toggleDevToken(enable: boolean) {
    log.debug('[debug] HomeyController toggleDevToken: start', { enable });
    await this.ensureConnected();
    await new ToggleTaskRunner('HOMEY_DEV_TOKEN', enable).run();
    log.debug('[debug] HomeyController toggleDevToken: end');
  }
}