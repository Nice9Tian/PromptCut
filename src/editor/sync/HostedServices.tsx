/**
 * 项目设置「多用户协作」里托管方服务的勾选行（契约 `docs/plan/hosted-render-contract.md` 第 3 节；语义 `workflow/project.md`）。
 *
 * 按服务名各渲染一行：项目放云端、且这台托管端有这个服务（`available`）才出现；创建者能改（点勾选后走创建者身份验证，
 * 见 `MembersPanel.tsx` 的 `CreatorFlow`），其他成员只读。放本机的项目没有这一组。
 * 现在只有 `render`；第四段（云端 Agent）在 `hostedServices.ts` 的 `HOSTED_SERVICE_ROWS` 加一项即可。
 *
 * 组件本身不读同步管理：数据与动作都从属性来，单测直接渲染它。
 */
import { HOSTED_SERVICE_TEXT, hostedRowsOf, type HostedServiceName, type HostedView } from "./hostedServices";
import "./sync.css";

export function HostedServiceRows({ where, hosted, creator, busy = false, onToggle }: {
  where: "lan" | "hosted" | null | undefined;
  hosted: HostedView | null;
  /** 我是创建者:能改;否则只读 */
  creator: boolean;
  busy?: boolean;
  onToggle: (service: HostedServiceName, enabled: boolean) => void;
}) {
  const rows = hostedRowsOf(where, hosted);
  if (!rows.length) return null;
  return (
    <div className="pc-collab-hosted" data-pc="collab-hosted-services">
      {rows.map((row) => (
        <div key={row.service} data-pc={`collab-hosted-${row.service}`}>
          <label className="pc-collab-head">
            <input
              type="checkbox"
              data-pc={`collab-hosted-${row.service}-toggle`}
              checked={row.enabled}
              disabled={!creator || busy}
              onChange={(e) => onToggle(row.service, e.target.checked)}
            />
            {row.label}
          </label>
          <div className="pc-sync-hint" data-pc={`collab-hosted-${row.service}-hint`}>
            {HOSTED_SERVICE_TEXT[row.service]?.hint(row.enabled)}
            {creator ? "" : "（只有创建者能改）"}
          </div>
        </div>
      ))}
    </div>
  );
}
