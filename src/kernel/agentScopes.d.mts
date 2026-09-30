/** `agentScopes.mjs` 的类型(页面与服务端共用的范围口径) */
export function cutNameOf(project: unknown): string;
export function diffScopes(before: unknown, after: unknown): string[];
export function splitScopes(text: unknown): string[];
export function scopeOverlaps(a: string, b: string): boolean;
export function overlappingScopes(written: string[] | string, declared: string): string[];
