/**
 * 共享项目客户端(`server/auth/client.mjs`、`route.mjs`、`hosted-default.mjs`)在页面里的类型外壳。
 *
 * 三个 .mjs 都是浏览器与 Node 通用、不引 Node 模块的(契约 `docs/plan/auth-contract.md` 第 11 节、
 * `docs/plan/shared-project-contract.md` 第 3 节),页面直接引;它们没有 .d.ts,形状在这里就地声明。
 */
// @ts-expect-error 无类型声明的 .mjs
import * as clientMod from "../../../server/auth/client.mjs";
// @ts-expect-error 无类型声明的 .mjs
import * as routeMod from "../../../server/auth/route.mjs";
// @ts-expect-error 无类型声明的 .mjs
import * as hostedMod from "../../../server/auth/hosted-default.mjs";

export type SharedMode = "free" | "restricted";
export type Where = "lan" | "hosted";

export interface Kdf {
  alg: string;
  iter: number;
}

export interface Candidate {
  where: Where;
  /** 文档服务的 http 地址,以 `/` 结尾(契约第 11 节裁定) */
  base: string;
  projectId: string;
  name: string;
  mode: SharedMode;
  hostDeviceName?: string;
  via?: "discover" | "manual";
}

export interface FindResult {
  candidates: Candidate[];
  errors: { where: Where; reason: string; status?: number; message?: string }[];
}

export type Route =
  | { action: "enter"; candidate: Candidate }
  | { action: "choose"; candidates: Candidate[] }
  | { action: "not-found"; errors: FindResult["errors"] };

export interface LanHost {
  projectId: string;
  name: string;
  mode: SharedMode;
  hostDeviceName?: string;
  docservice: string;
  asset?: string;
}

interface ClientApi {
  KDF_DEFAULT: Kdf;
  deriveKey(password: string, salt: string, kdf?: Kdf): Promise<string>;
  makeCredential(password: string, kdf?: Kdf): Promise<{ salt: string; key: string }>;
  adminProof(o: { key: string; projectId: string; username: string; op: string; nonce: string }): Promise<string>;
  buildAuthProtocols(o: {
    base: string;
    projectId: string;
    username: string;
    deviceId: string;
    deviceName: string;
    as?: "member" | "creator";
    password?: string;
    key?: string;
    role?: "page" | "agent" | "render";
    onKey?: (key: string) => void;
  }): Promise<string[]>;
  lookupProject(o: { base: string; name: string }): Promise<{ projectId: string; name: string; mode: SharedMode }>;
}

interface RouteApi {
  wsBaseOf(url: string): string;
  candidateBaseOf(url: string): string;
  findSharedProject(o: {
    name: string;
    hostedUrl?: string | null | false;
    uiHostedUrl?: string | null;
    lan?: { discover?: (o: { name: string; timeoutMs: number }) => Promise<{ hosts: LanHost[]; errors?: { reason: string }[] }>; manual?: string[]; timeoutMs?: number };
  }): Promise<FindResult>;
  pickRoute(r: FindResult): Route;
  createSharedProject(o: {
    where: Where;
    name: string;
    mode: SharedMode;
    creator: { username: string; password: string };
    password?: string;
    list?: { username: string; password: string }[];
    uiHostedUrl?: string | null;
    hostedUrl?: string;
  }): Promise<{ where: Where; base: string; projectId: string; name: string; mode: SharedMode }>;
}

interface HostedApi {
  DEFAULT_HOSTED_URL: string;
  resolveHostedUrl(o?: { ui?: string | null }): string;
}

export const client = clientMod as ClientApi;
export const route = routeMod as RouteApi;
export const hosted = hostedMod as HostedApi;

/** 共享端点回的错误(`client.mjs` 的 callJson):带 HTTP 状态与原因词 */
export function errorStatus(e: unknown): { status: number | null; reason: string | null } {
  const err = e as { status?: unknown; reason?: unknown };
  return {
    status: typeof err?.status === "number" ? err.status : null,
    reason: typeof err?.reason === "string" ? err.reason : null,
  };
}
