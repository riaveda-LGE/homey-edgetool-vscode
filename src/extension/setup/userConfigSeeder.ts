// === src/extension/setup/userConfigSeeder.ts ===
import * as vscode from 'vscode';
import { USERCFG_REL, USERCFG_TEMPLATE_REL } from '../../shared/const.js';
import { getLogger } from '../../core/logging/extension-logger.js';
import { measureBlock } from '../../core/logging/perf.js';
import { resolveWorkspaceInfo } from '../../core/config/userdata.js';

const log = getLogger('setup.usercfg');

export async function ensureUserConfigExists(
  context: vscode.ExtensionContext,
  extensionUri: vscode.Uri,
) {
  await measureBlock('usercfg.ensure', async () => {
    const info = await resolveWorkspaceInfo(context);
    const cfgUri = vscode.Uri.joinPath(info.wsDirUri, ...USERCFG_REL.split('/'));
    const cfgDir = vscode.Uri.joinPath(info.wsDirUri, '.config');

    let exists = false;
    try { await vscode.workspace.fs.stat(cfgUri); exists = true; } catch {}

    try { await vscode.workspace.fs.createDirectory(cfgDir); } catch {}

    if (!exists) {
      const tpl = vscode.Uri.joinPath(extensionUri, ...USERCFG_TEMPLATE_REL.split('/'));
      const buf = await vscode.workspace.fs.readFile(tpl);
      await vscode.workspace.fs.writeFile(cfgUri, buf);
      log.info(`seeded user config: ${cfgUri.fsPath}`);
    } else {
      log.debug('user config already exists; skip seeding');
    }
  });
}

export async function migrateUserConfigIfNeeded(
  oldWsUri: vscode.Uri,
  newWsUri: vscode.Uri,
  extensionUri: vscode.Uri,
) {
  await measureBlock('usercfg.migrate', async () => {
    const oldCfg = vscode.Uri.joinPath(oldWsUri, ...USERCFG_REL.split('/'));
    const newCfg = vscode.Uri.joinPath(newWsUri, ...USERCFG_REL.split('/'));

    let newExists = false;
    try { await vscode.workspace.fs.stat(newCfg); newExists = true; } catch {}

    if (!newExists) {
      try {
        const buf = await vscode.workspace.fs.readFile(oldCfg);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(newWsUri, '.config'));
        await vscode.workspace.fs.writeFile(newCfg, buf);
        log.info(`migrated user config: ${newCfg.fsPath}`);
        return;
      } catch {}
      // 이전에 없었으면 템플릿으로 시드
      const tpl = vscode.Uri.joinPath(extensionUri, ...USERCFG_TEMPLATE_REL.split('/'));
      const buf = await vscode.workspace.fs.readFile(tpl);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(newWsUri, '.config'));
      await vscode.workspace.fs.writeFile(newCfg, buf);
      log.info(`seeded new user config: ${newCfg.fsPath}`);
    } else {
      log.debug('new workspace already has user config — migration skipped');
    }
  });
}