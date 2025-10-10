// === src/extension/editors/LogViewEditorProvider.ts ===
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/extension-logger.js';
import { PANEL_VIEW_TYPE } from '../../shared/const.js';

const log = getLogger('LogViewEditor');

export class LogViewEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = `${PANEL_VIEW_TYPE}.logView`;

  constructor(private readonly _extUri: vscode.Uri) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void | Thenable<void> {
    log.info('resolveCustomTextEditor', document.uri.toString());

    // dist/ui/log-viewer 리소스만 허용
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extUri, 'dist', 'ui', 'log-viewer'),
      ],
      ...({ retainContextWhenHidden: true } as any),
    };

    const html = `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy"
 content="default-src 'none';
          style-src 'unsafe-inline' \${webview.cspSource};
          script-src 'nonce-\${nonce}';"/>
<title>Homey Log Viewer</title>
<style>
  body{margin:0;background:#0b0b0b;color:#eaeaea;font:12px/1.4 ui-monospace,Consolas,monospace}
  #log{white-space:pre-wrap;padding:8px}
</style>
</head>
<body>
  <div id="log">loading...</div>
  <script nonce="\${nonce}">const vscode = acquireVsCodeApi();</script>
  <script nonce="\${nonce}" src="\${appJs}"></script>
</body></html>`;

    const nonce = getNonce();
    const appJs = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extUri, 'dist', 'ui', 'log-viewer', 'app.js'),
    );

    webviewPanel.webview.html = html
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{webview\.cspSource\}/g, webviewPanel.webview.cspSource)
      .replace(/\$\{appJs\}/g, String(appJs));
  }
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
