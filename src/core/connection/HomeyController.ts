import { getLogger } from '../logging/extension-logger.js';
import type { HostConfig } from './ConnectionManager.js';
import { ConnectionManager } from './ConnectionManager.js';

const log = getLogger('HomeyController');

export class HomeyController {
  private cm: ConnectionManager;
  constructor(private cfg: HostConfig) {
    this.cm = new ConnectionManager(cfg);
  }

  async restart() {
    await this.cm.connect();
    // 유닛명은 환경마다 다를 수 있어, homey-pro@ 로 시작하는 유닛을 찾아 재시작
    const cmd = `sh -lc 'unit=$(systemctl list-units --type=service --all | awk "/homey-pro@/{print \\$1; exit}"); if [ -n "$unit" ]; then sudo systemctl restart "$unit"; else echo "no homey-pro@ unit"; fi'`;
    const { code } = await this.cm.run(cmd);
    log.info(`restart code=${code}`);
  }

  async mount() {
    await this.cm.connect();
    // 여기서는 최소: 도커 상태 출력으로 대체 (후속 단계에서 서비스 파일 수정 로직 추가)
    const cmd = `sh -lc 'docker ps --format "{{.Names}} {{.Status}}"'`;
    await this.cm.run(cmd);
    log.info('mount: (stubbed) — later: edit ExecStart with volumes and daemon-reload');
  }

  async unmount() {
    await this.cm.connect();
    // 안전한 stop/rm + daemon-reload 시퀀스(있는 경우만)
    const script = `
set -e
unit=$(systemctl list-units --type=service --all | awk '/homey-pro@/{print $1; exit}')
[ -n "$unit" ] && echo "unit=$unit" || echo "unit not found"
# 컨테이너 정지/삭제 시도 (이름 패턴은 환경에 맞게 조정)
docker ps -a --format '{{.Names}}' | awk '/homey/ {print}' | xargs -r -n1 sh -c 'docker stop "$0" || true; docker rm "$0" || true'
[ -n "$unit" ] && sudo systemctl daemon-reload && sudo systemctl restart "$unit" || true
`;
    await this.cm.run(`sh -lc '${script.replace(/\n/g, ' ')}'`);
    log.info('unmount done');
  }

  async gitPull(path?: string) {
    await this.cm.connect();
    const p = path || '/etc/homey';
    await this.cm.run(`sh -lc 'cd "${p}" && git pull --ff-only || true'`);
  }

  async gitPush(path?: string) {
    await this.cm.connect();
    const p = path || '/etc/homey';
    await this.cm.run(`sh -lc 'cd "${p}" && git add -A && git commit -m "edge push" || true && git push || true'`);
  }
}
