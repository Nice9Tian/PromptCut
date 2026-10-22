/**
 * 从「我的项目」列表点进一个云端项目(开始页 `AccountProjects.tsx`、手机开始页 `src/mobile/MobileStart.tsx`,经 `useAccountProjects` 的 `open`)。
 *
 * 列表那条路走的是 `/session`(`enterAccountProject` → `client.session`),它不认二级密码:项目设了二级密码、而这个账号还没输过当前这一版
 * (刚被创建者通过的申请人——通过时就出现在「我加入的」里;或创建者改过密码之后的老成员)时,服务端回 403 `secondary-password-required`。
 * 这不是失败:回 `'secondary-required'`,页面据此把项目链接填进「凭链接加入」、弹出二级密码框,改走带密码的 `/join`
 * (语义「通过后申请人直接能进(项目设了二级密码的仍要输一次)」)。其余错误照常抛出。
 */
export async function enterOrAskPassword(enter: () => Promise<unknown>): Promise<'entered' | 'secondary-required'> {
  try {
    await enter();
    return 'entered';
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'secondary-password-required') return 'secondary-required';
    throw error;
  }
}
