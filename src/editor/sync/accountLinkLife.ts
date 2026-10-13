/**
 * 账号云端项目里,页面那条文档连接的寿命(`syncManager.ts` 的 `enterAccountProject` 用;在线页面与桌面版同一条路)。
 *
 * 账号连接上的每条消息都要过闸,闸拿建连时那张票据背后的访问令牌去问账号服务;访问令牌到期(120 秒,票据的 `expiresAt` 就是那个时刻)
 * 之后,连接还开着,但每条消息都回「凭证到期」,续令牌也救不回这条连接(`server/account-card-link.mjs` 文件头有实测)。
 * 所以页面要在到期之前换到一个凭新票据建的会话上。本模块只管「什么时候换、换不成怎么办」,怎么换在 `link.ts` 的 `renew()`:
 *
 * - **每张票据都要够用**:取会话时要求背后的访问令牌至少还剩 `MIN_TICKET_LIFE_MS`,不够客户端先续令牌(`client.session` 的 `minRemainingMs`)。
 * - **到期前换**:`tick()`(调用方每几秒调一次,看的是墙上时钟)发现离到期不到 `RENEW_MARGIN_MS` 就换。看墙上时钟而不是定一个长定时器,
 *   是为了电脑睡眠醒来之后第一下就能发现「早就过期了」。
 * - **换不成**:账号服务一时不通,下一次 `tick()` 再试;试到到期那一刻还没换成,这条连接就是坏的 —— 调 `link.expire()` 按断线处理
 *   (页面转离线、改动进离线队列、照普通断线重连),不让页面显示在线而实际写不进。
 *   登录失效、被踢(会话接口回 401 / 403)交给 `onTerminal`,由调用方照现有的做法收场。
 * - **已经过期才发现**(睡眠醒来、时钟不准):文档服务回「凭证到期」时 `authExpired()` 当场换;换不成同样 `expire()`。
 *   换成之后没确认的改动在新会话上补发(`DocSync.handover`),不丢。
 */

/** 离到期不到这么久就换会话 */
export const RENEW_MARGIN_MS = 30_000;
/** 取票据时,背后的访问令牌至少还要剩这么久(比 `RENEW_MARGIN_MS` 大,新会话才不会一建成又到了该换的时候) */
export const MIN_TICKET_LIFE_MS = 60_000;

export interface AccountLinkLifeOptions {
  /** 取一份新的项目会话,要求背后的访问令牌至少还剩 `minRemainingMs`(`CloudAccountClient.session`) */
  session: (o: { minRemainingMs: number }) => Promise<{ connectionTicket: string; expiresAt: number }>;
  /** 页面那条连接(`SyncLink` 里用到的部分) */
  link: () => { readonly connected: boolean; renew(o?: { urgent?: boolean }): Promise<boolean>; expire(reason?: string): void } | null;
  /** 登录失效、被踢、不在名单:不再试 */
  onTerminal: (error: unknown) => void;
  now?: () => number;
  renewMarginMs?: number;
  minTicketLifeMs?: number;
}

export type TickResult = "idle" | "busy" | "renewed" | "retry" | "expired" | "terminal";

const isTerminal = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
};

export function createAccountLinkLife(o: AccountLinkLifeOptions) {
  const now = o.now ?? Date.now;
  const margin = o.renewMarginMs ?? RENEW_MARGIN_MS;
  const minLife = o.minTicketLifeMs ?? MIN_TICKET_LIFE_MS;
  /** 最近一次取到的票据到什么时候;连接建成(或换成)时记成当前连接的到期时刻 */
  let issued: number | null = null;
  let active: number | null = null;
  let busy = false;
  let renews = 0;
  let expires = 0;

  /** 换一次(`urgent`:旧连接已经作废,不等它上面的提交落定)。回:换成了 / 没换成(可再试) / 终局 */
  async function swap(urgent: boolean): Promise<"renewed" | "retry" | "terminal"> {
    const link = o.link();
    if (!link) return "retry";
    try {
      if (await link.renew({ urgent })) { renews += 1; return "renewed"; }
      return "retry";
    } catch (error) {
      if (isTerminal(error)) { o.onTerminal(error); return "terminal"; }
      return "retry";
    }
  }

  return {
    /** `SyncLink` 的 `protocols`:每次建会话(含换会话)现取票据。`first` 给了就用它(进项目时已经取到的那份会话) */
    async ticket(first?: { connectionTicket: string; expiresAt: number } | null): Promise<string> {
      const s = first && first.expiresAt - now() >= minLife ? first : await o.session({ minRemainingMs: minLife });
      issued = s.expiresAt;
      return s.connectionTicket;
    },
    /** 会话建成了(新建或换成):当前连接能用到刚才那张票据到期 */
    opened(): void {
      active = issued;
    },
    /** 调用方每几秒调一次 */
    async tick(): Promise<TickResult> {
      const link = o.link();
      if (busy) return "busy";
      // 没有会话(正在断线重连)时不管:重连那条路本来就凭新票据建会话
      if (!link || !link.connected || active === null) return "idle";
      const left = active - now();
      if (left > margin) return "idle";
      busy = true;
      try {
        const r = await swap(left <= 0);
        if (r !== "retry") return r;
        // 没换成:还没到期就等下一次;已经到期,这条连接是坏的,如实转离线
        if (active !== null && active - now() <= 0 && o.link() === link && link.connected) {
          expires += 1;
          active = null;
          link.expire();
          return "expired";
        }
        return "retry";
      } finally { busy = false; }
    },
    /** 文档服务回了「凭证到期」:这条连接已经写不进去,当场换;换不成转离线 */
    async authExpired(): Promise<TickResult> {
      const link = o.link();
      if (busy) return "busy";
      if (!link || !link.connected) return "idle";
      busy = true;
      try {
        const r = await swap(true);
        if (r !== "retry") return r;
        if (o.link() === link && link.connected) {
          expires += 1;
          active = null;
          link.expire();
          return "expired";
        }
        return "retry";
      } finally { busy = false; }
    },
    /** 诊断 */
    describe: () => ({ expiresAt: active, renews, expires, busy }),
  };
}

export type AccountLinkLife = ReturnType<typeof createAccountLinkLife>;
