/** The native bridge checks the actual main WebView label and URL. Cards get no vault API. */
export async function desktopAccountBridge(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('此环境没有桌面账号安全存储，请使用桌面版或在线编辑器。');
  return invoke('account_bridge', { operation, args });
}
