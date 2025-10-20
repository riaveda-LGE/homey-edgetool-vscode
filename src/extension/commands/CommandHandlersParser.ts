// === src/extension/commands/CommandHandlersParser.ts ===
import * as vscode from 'vscode';

import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import {
  PARSER_TEMPLATE_REL,
  PARSER_CONFIG_REL,
  PARSER_README_REL,
  PARSER_README_TEMPLATE_REL,
} from '../../shared/const.js';

const log = getLogger('cmd.parser');

export class CommandHandlersParser {
  constructor(private context?: vscode.ExtensionContext) {}

  /** 확장 패키지 내부 리소스를 읽어 문자열 반환 */
  private async readEmbedded(rel: string): Promise<string> {
    if (!this.context) throw new Error('no extension context');
    const uri = vscode.Uri.joinPath(this.context.extensionUri, ...rel.split('/'));
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(buf);
  }

  @measure()
  async initParser() {
    log.debug('[debug] CommandHandlersParser initParser: start');
    if (!this.context) return log.error('[error] internal: no extension context');
    try {
      const info = await resolveWorkspaceInfo(this.context);
      const cfgDir = vscode.Uri.joinPath(info.wsDirUri, '.config');
      const cfgFile = vscode.Uri.joinPath(info.wsDirUri, ...PARSER_CONFIG_REL.split('/'));
      const readmeFile = vscode.Uri.joinPath(info.wsDirUri, ...PARSER_README_REL.split('/'));

      // .config 폴더 보장
      try {
        await vscode.workspace.fs.createDirectory(cfgDir);
      } catch {}

      // 무조건 덮어쓰기: 템플릿(JSON) + README(MD)
      const json = await this.readEmbedded(PARSER_TEMPLATE_REL);
      const data = new TextEncoder().encode(json);
      await vscode.workspace.fs.writeFile(cfgFile, data);

      const md = await this.readEmbedded(PARSER_README_TEMPLATE_REL);
      const mdbuf = new TextEncoder().encode(md);
      await vscode.workspace.fs.writeFile(readmeFile, mdbuf);

      // 에디터로 열기 (JSON을 먼저, README는 옆창)
      const doc1 = await vscode.workspace.openTextDocument(cfgFile);
      await vscode.window.showTextDocument(doc1, { preview: false });
      try {
        const doc2 = await vscode.workspace.openTextDocument(readmeFile);
        await vscode.window.showTextDocument(doc2, {
          preview: false,
          viewColumn: vscode.ViewColumn.Beside,
        });
      } catch {}

      log.info(`parser artifacts written: ${cfgFile.fsPath}, ${readmeFile.fsPath}`);
      vscode.window.showInformationMessage(
        'Parser 템플릿/README가 재생성되었습니다 (.config/custom_log_parser.json, custom_log_parser_readme.md).',
      );
    } catch (e: any) {
      log.error('initParser failed', e);
      vscode.window.showErrorMessage('Parser 초기화 실패: ' + (e?.message ?? String(e)));
    } finally {
      log.debug('[debug] CommandHandlersParser initParser: end');
    }
  }
}
