// === src/extension/setup/parserConfigSeeder.ts ===
import * as vscode from 'vscode';

import { resolveWorkspaceInfo } from '../../core/config/userdata.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measure, measureBlock } from '../../core/logging/perf.js';
import {
  PARSER_CONFIG_REL,
  PARSER_README_REL,
  PARSER_README_TEMPLATE_REL,
  PARSER_TEMPLATE_REL,
} from '../../shared/const.js';

const log = getLogger('setup.parserSeeder');

/** 현재 워크스페이스에 파서 JSON/README가 없으면 생성 */
export async function ensureParserConfigExists(
  context: vscode.ExtensionContext,
  extensionUri: vscode.Uri,
) {
  await measureBlock('parser.ensureConfigExists', async () => {
    const info = await resolveWorkspaceInfo(context);
    const cfgUri = vscode.Uri.joinPath(info.wsDirUri, ...PARSER_CONFIG_REL.split('/'));
    const readmeUri = vscode.Uri.joinPath(info.wsDirUri, ...PARSER_README_REL.split('/'));
    const cfgDir = vscode.Uri.joinPath(info.wsDirUri, '.config');

    let cfgExists = false;
    let readmeExists = false;
    try {
      await vscode.workspace.fs.stat(cfgUri);
      cfgExists = true;
    } catch {}
    try {
      await vscode.workspace.fs.stat(readmeUri);
      readmeExists = true;
    } catch {}

    try {
      await vscode.workspace.fs.createDirectory(cfgDir);
    } catch {}

    if (!cfgExists) {
      const tplUri = vscode.Uri.joinPath(extensionUri, ...PARSER_TEMPLATE_REL.split('/'));
      const buf = await vscode.workspace.fs.readFile(tplUri);
      await vscode.workspace.fs.writeFile(cfgUri, buf);
      log.info(`seeded parser config: ${cfgUri.fsPath}`);
    } else {
      log.debug('parser config already exists; skip seeding');
    }

    if (!readmeExists) {
      const mdUri = vscode.Uri.joinPath(extensionUri, ...PARSER_README_TEMPLATE_REL.split('/'));
      const md = await vscode.workspace.fs.readFile(mdUri);
      await vscode.workspace.fs.writeFile(readmeUri, md);
      log.info(`seeded parser readme: ${readmeUri.fsPath}`);
    } else {
      log.debug('parser readme already exists; skip seeding');
    }
  }); // measureBlock
}

/** 워크스페이스 이동 시 새 ws에 .config 없으면 이전 ws의 .config 폴더를 복사. 없으면 템플릿으로 시드 */
export async function migrateParserConfigIfNeeded(
  oldWsUri: vscode.Uri,
  newWsUri: vscode.Uri,
  extensionUri: vscode.Uri,
) {
  await measureBlock('parser.migrateIfNeeded', async () => {
    const oldDir = vscode.Uri.joinPath(oldWsUri, '.config');
    const newDir = vscode.Uri.joinPath(newWsUri, '.config');
    log.debug?.(
      `[debug] migrateParserConfigIfNeeded: old=${oldDir.fsPath} -> new=${newDir.fsPath}`,
    );

    // 새 ws에 이미 .config가 있으면 복사만 스킵(삭제는 아래에서 진행)
    let newExists = false;
    try {
      await vscode.workspace.fs.stat(newDir);
      newExists = true;
    } catch {}

    // 이전 ws의 .config 존재 여부 확인
    let oldExists = false;
    try {
      await vscode.workspace.fs.stat(oldDir);
      oldExists = true;
    } catch {}

    await vscode.workspace.fs.createDirectory(newDir);

    if (!newExists) {
      if (oldExists) {
        log.info('migrating .config from previous workspace');
        await copyDir(oldDir, newDir);
      } else {
        // 이전에도 없으면 템플릿 시드
        const newCfg = vscode.Uri.joinPath(newDir, ...PARSER_CONFIG_REL.split('/').slice(-1));
        const tplUri = vscode.Uri.joinPath(extensionUri, ...PARSER_TEMPLATE_REL.split('/'));
        const buf = await vscode.workspace.fs.readFile(tplUri);
        await vscode.workspace.fs.writeFile(newCfg, buf);
        log.info(`seeded new parser config at ${newCfg.fsPath}`);
        // README도 함께
        const mdTpl = vscode.Uri.joinPath(extensionUri, ...PARSER_README_TEMPLATE_REL.split('/'));
        const mdBuf = await vscode.workspace.fs.readFile(mdTpl);
        const readmeOut = vscode.Uri.joinPath(newDir, ...PARSER_README_REL.split('/').slice(-1));
        await vscode.workspace.fs.writeFile(readmeOut, mdBuf);
        log.info(`seeded new parser readme at ${readmeOut.fsPath}`);
      }
    } else {
      log.info('new workspace already has .config — migration copy skipped');
    }

    // (요청사항) 이전 워크스페이스의 .config 폴더 제거
    if (oldExists && oldDir.fsPath !== newDir.fsPath) {
      try {
        await vscode.workspace.fs.delete(oldDir, { recursive: true, useTrash: false });
        log.info(`removed previous .config at ${oldDir.fsPath}`);
      } catch (e: any) {
        log.warn(`failed to remove previous .config (${oldDir.fsPath}): ${e?.message ?? e}`);
      }
    }
  }); // measureBlock
}

async function copyDir(src: vscode.Uri, dest: vscode.Uri) {
  await measureBlock('parser.copyDir', async () => {
    const entries = await vscode.workspace.fs.readDirectory(src);
    for (const [name, type] of entries) {
      const s = vscode.Uri.joinPath(src, name);
      const d = vscode.Uri.joinPath(dest, name);
      if (type === vscode.FileType.Directory) {
        await vscode.workspace.fs.createDirectory(d);
        await copyDir(s, d);
      } else if (type === vscode.FileType.File) {
        const buf = await vscode.workspace.fs.readFile(s);
        await vscode.workspace.fs.writeFile(d, buf);
      }
    }
  });
}
