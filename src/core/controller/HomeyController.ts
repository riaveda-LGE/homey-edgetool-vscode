import { ErrorCategory, XError } from '../../shared/errors.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { getLogger } from '../logging/extension-logger.js';
import { measure } from '../logging/perf.js';

const log = getLogger('HomeyController');

export class HomeyController {
  constructor() {}

  @measure()
  async restart() {
    log.debug('[debug] HomeyController restart: start');
    await connectionManager.connect(); // 자동 recent 활성화 + 헬스체크
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
    // 유닛명은 환경마다 다를 수 있어, homey-pro@ 로 시작하는 유닛을 찾아 재시작
    const cmd = `sh -lc 'unit=$(systemctl list-units --type=service --all | awk "/homey-pro@/{print \\$1; exit}"); if [ -n "$unit" ]; then sudo systemctl restart "$unit"; else echo "no homey-pro@ unit"; fi'`;
    const { code } = await connectionManager.run(cmd);
    log.info(`restart code=${code}`);
    log.debug('[debug] HomeyController restart: end');
  }

  @measure()
  async mount() {
    log.debug('[debug] HomeyController mount: start');
    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
    // 여기서는 최소: 도커 상태 출력으로 대체 (후속 단계에서 서비스 파일 수정 로직 추가)
    const cmd = `sh -lc 'docker ps --format "{{.Names}} {{.Status}}"'`;
    await connectionManager.run(cmd);
    log.info('mount: (stubbed) — later: edit ExecStart with volumes and daemon-reload');
    log.debug('[debug] HomeyController mount: end');
  }

  @measure()
  async unmount() {
    log.debug('[debug] HomeyController unmount: start');
    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
    // 안전한 stop/rm + daemon-reload 시퀀스(있는 경우만)
    const script = `
set -e
unit=$(systemctl list-units --type=service --all | awk '/homey-pro@/{print $1; exit}')
[ -n "$unit" ] && echo "unit=$unit" || echo "unit not found"
# 컨테이너 정지/삭제 시도 (이름 패턴은 환경에 맞게 조정)
docker ps -a --format '{{.Names}}' | awk '/homey/ {print}' | xargs -r -n1 sh -c 'docker stop "$0" || true; docker rm "$0" || true'
[ -n "$unit" ] && sudo systemctl daemon-reload && sudo systemctl restart "$unit" || true
`;
    await connectionManager.run(`sh -lc '${script.replace(/\n/g, ' ')}'`);
    log.debug('[debug] HomeyController unmount: end');
  }

  @measure()
  async gitPull(path?: string) {
    log.debug('[debug] HomeyController gitPull: start');
    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
    const p = path || '/etc/homey';
    await connectionManager.run(`sh -lc 'cd "${p}" && git pull --ff-only || true'`);
    log.debug('[debug] HomeyController gitPull: end');
  }

  @measure()
  async gitPush(path?: string) {
    log.debug('[debug] HomeyController gitPush: start');
    await connectionManager.connect();
    if (!connectionManager.isConnected()) {
      throw new XError(
        ErrorCategory.Connection,
        '활성 연결이 없습니다. 먼저 "기기 연결"을 수행하세요.',
      );
    }
    const p = path || '/etc/homey';
    await connectionManager.run(
      `sh -lc 'cd "${p}" && git add -A && git commit -m "edge push" || true && git push || true'`,
    );
    log.debug('[debug] HomeyController gitPush: end');
  }
}
