import type { LogEntry } from '@ipc/messages';
import * as fs from 'fs';
import * as path from 'path';

import { getLogger } from '../logging/extension-logger.js';

type FileSeg = { name: string; from: number; lines: number };

/**
 * 파일 병합 세션 동안 “인덱싱된 파일정보”를 유지/저장하는 스토어.
 * - 작업폴더/raw/merged_list/index.json 에 저장
 * - 형식:
 *   {
 *     "totalLines": number,
 *     "files": [{ "name": "xxx.log", "from": 0, "lines": 123 }, ...]
 *   }
 */
export class IndexedLogStore {
  private log = getLogger('IndexedLogStore');
  private segments: FileSeg[] = [];
  private total = 0;
  private cur?: FileSeg;

  constructor(private outDir: string) {}

  /** merged_list 폴더를 제거해 초기화 */
  async reset() {
    this.log.debug('[debug] IndexedLogStore reset: start');
    try {
      await fs.promises.rm(this.outDir, { recursive: true, force: true });
    } catch (e) {
      this.log.warn(`reset failed: ${String(e)}`);
    }
    this.log.debug('[debug] IndexedLogStore reset: end');
  }

  /** 세션 시작. (선행 라인 플랜이 있다면 from/lines를 미리 채워 저장) */
  async begin(plan?: { name: string; lines: number }[]) {
    this.log.debug('[debug] IndexedLogStore begin: start');
    await fs.promises.mkdir(this.outDir, { recursive: true });
    this.segments = [];
    this.total = 0;
    this.cur = undefined;

    if (plan && plan.length) {
      let from = 0;
      for (const p of plan) {
        const seg: FileSeg = { name: p.name, from, lines: p.lines };
        this.segments.push(seg);
        from += p.lines;
      }
      await this.writeIndex(); // 초기 플랜을 먼저 기록
    }
    this.log.debug('[debug] IndexedLogStore begin: end');
  }

  /** 병합 스트림에서 받은 배치를 반영 */
  onBatch(logs: LogEntry[]) {
    this.log.debug('[debug] IndexedLogStore onBatch: start');
    for (const e of logs) {
      // 파일 세그먼트 이름 결정: file → basename(path) → source
      let name: string | undefined =
        (e as any).file && String((e as any).file).trim()
          ? String((e as any).file)
          : undefined;
      if (!name) {
        const p = (e as any).path ? String((e as any).path) : '';
        name = p ? path.basename(p) : undefined;
      }
      name = name || e.source || 'unknown';
      this.total++;

      // 파일 전환 감지(플랜이 없는 경우에만 새로운 구간 생성)
      if (!this.cur || this.cur.name !== name) {
        if (!this.segments.length || this.segments[this.segments.length - 1].name !== name) {
          this.cur = { name, from: this.total - 1, lines: 0 };
          this.segments.push(this.cur);
        } else {
          this.cur = this.segments[this.segments.length - 1];
        }
      }
      this.cur.lines++;
    }
    this.log.debug('[debug] IndexedLogStore onBatch: end');
  }

  /** 세션 종료 시 index.json 저장(총 라인수 포함) */
  async finalize() {
    this.log.debug('[debug] IndexedLogStore finalize: start');
    await this.writeIndex();
    this.log.debug('[debug] IndexedLogStore finalize: end');
  }

  getTotal() {
    this.log.debug('[debug] IndexedLogStore getTotal: start');
    const result = this.total;
    this.log.debug('[debug] IndexedLogStore getTotal: end');
    return result;
  }

  private async writeIndex() {
    this.log.debug('[debug] IndexedLogStore writeIndex: start');
    const sum = this.total || this.segments.reduce((a, b) => a + b.lines, 0);
    const payload = { totalLines: sum, files: this.segments };
    const p = path.join(this.outDir, 'index.json');
    await fs.promises.writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
    this.log.debug('[debug] IndexedLogStore writeIndex: end');
  }
}
