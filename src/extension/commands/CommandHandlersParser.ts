// === src/extension/commands/CommandHandlersParser.ts ===
import * as vscode from 'vscode';

import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure } from '../../core/logging/perf.js';
import {
  PARSER_CONFIG_REL,
  PARSER_README_REL,
  PARSER_README_TEMPLATE_REL,
  PARSER_TEMPLATE_REL,
} from '../../shared/const.js';

const log = getLogger('cmd.parser');

export class CommandHandlersParser {
  constructor(private context?: vscode.ExtensionContext) {}

  /** 확장 패키지 내부 리소스를 읽어 문자열 반환 */
  @measure()
  private async readEmbedded(rel: string): Promise<string> {
    if (!this.context) throw new Error('no extension context');
    const uri = vscode.Uri.joinPath(this.context.extensionUri, ...rel.split('/'));
    const buf = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(buf);
  }
}
