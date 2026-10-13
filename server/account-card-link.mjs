/**
 * 卡片源码同步在账号云端项目里怎么连进文档服务(`server/card-sync.mjs` 的规则不变,只换建会话时出示什么)。
 *
 * 账号项目的文档服务只认账号办法的连接票据(`server/docservice/account-hosted.mjs`:子协议 `promptcut.account.<票据>`,
 * 旧的 `auth.ticket` 在这种连接上一律被拒)。票据由页面凭自己的登录向 `/hosted/shared/account/session` 取,
 * 角色仍是 page、权限就是这位成员此刻的权限;编辑器进程自己不持有登录,也不自报任何身份。
 *
 * 只在**建新会话**时出示票据。接续不带:文档服务规定接续项旁边不能有鉴权项(`server/docservice/session.mjs` 的
 * `parseSessionItem`,带了握手回 400),接续时由服务端按会话里记下的身份重新核对登录与成员资格(`resumeGate`)。
 * 权限被收回时服务端直接结束会话,之后只能建新会话,那时票据取不到(退出登录、被踢、项目没了)就连不进去。
 */
export const ACCOUNT_PROTOCOL_PREFIX = 'promptcut.account.';
const TICKET = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param {() => Promise<string> | string} getTicket 现取一张账号办法的连接票据;取不到就抛
 * @returns {() => Promise<string[]>} `createCardSync().bind({ protocols })` 用的子协议
 */
export function accountCardProtocols(getTicket) {
  if (typeof getTicket !== 'function') throw new TypeError('accountCardProtocols: getTicket 要是函数');
  return async () => {
    const ticket = await getTicket();
    if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw new Error('账号连接票据不合法');
    return ['promptcut.v1', `${ACCOUNT_PROTOCOL_PREFIX}${ticket}`];
  };
}
