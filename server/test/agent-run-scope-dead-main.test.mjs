import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeadMainPreviousV2 } from '../hosted/deploy/asset-root-registry-publisher.mjs';

// 「原来那一代的主进程已经不在了」时 root 的发布器凭什么认这还是原来那一代。读数是注入的（生产上现读 systemd 与内核），
// 所以不依赖 Linux。其中「cgroup 已被收掉」那一种的读数照抄 2026-10-13 节点自检的实况
// （Ubuntu 22.04、systemd 249，主进程被 SIGKILL 以后）：ActiveState=active SubState=exited MainPID=0 ControlGroup=（空）。
const BOOT = '11111111-1111-1111-1111-111111111111';
const SLICE = '/sys/fs/cgroup/pcclaudeprobec1bd15903n21562e0ba1bc41e346e3c9c1370eab18.slice';
const SERVICE = `${SLICE}/pc-claude-probe-c1bd1590-a.service`;
const old = { instance: { instanceId: 'instance-3', bootId: BOOT, pid: 372874, pidBirth: { bootId: BOOT, startTicks: '99' }, unitInvocationId: '35668b72b80f4231baad14528bd6e9e8',
  cgroup: { v2Path: SERVICE, dev: '30', ino: '4711', bootId: BOOT } }, closureScope: { cgroup: { v2Path: SLICE } } };
const directory = (changes = {}) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0n, mode: 0o40755n, dev: 30n, ino: 4711n, ...changes });
const control = SERVICE.slice('/sys/fs/cgroup'.length);
// 节点上实测到的那一组读数
const observed = { ActiveState: 'active', SubState: 'exited', MainPID: '0', ControlGroup: '', InvocationID: '35668b72b80f4231baad14528bd6e9e8' };

test('主进程没了、服务的 cgroup 已被 systemd 收掉（节点上实测到的状态）：仍认得出是原来那一代', () => {
  assert.deepEqual(validateDeadMainPreviousV2({ unit: observed, serviceCgroup: null, currentBootId: BOOT, old }), { serviceCgroup: 'pruned' });
  // 单元已经停了（inactive）、读数别的不变：同样认——关没关干净另由包着它的 slice 是不是空来证明，不看这里
  assert.deepEqual(validateDeadMainPreviousV2({ unit: { ...observed, ActiveState: 'inactive', SubState: 'dead' }, serviceCgroup: null, currentBootId: BOOT, old }), { serviceCgroup: 'pruned' });
});

test('主进程没了、组里还有别的进程活着（cgroup 还在）：照原来的规矩认，目录的设备号、节点号、属主都要对得上', () => {
  assert.deepEqual(validateDeadMainPreviousV2({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory(), currentBootId: BOOT, old }), { serviceCgroup: 'present' });
});

test('对不上的一律拒：主进程还在、换过一次启动、开机号变了、cgroup 读数自相矛盾或被换过', () => {
  const refused = (input, why) => assert.throws(() => validateDeadMainPreviousV2({ unit: observed, serviceCgroup: null, currentBootId: BOOT, old, ...input }),
    { code: 'publisher-previous-instance-mismatch' }, why);
  refused({ unit: { ...observed, MainPID: '372874' } }, '主进程号不是 0：主进程还在（或者换了一个）');
  refused({ unit: { ...observed, MainPID: '500000' } }, '单元里有另一个主进程');
  refused({ unit: { ...observed, InvocationID: 'ffffffffffffffffffffffffffffffff' } }, '单元被重新起过：不是记录里那一次启动');
  refused({ unit: { ...observed, InvocationID: '' } }, '读不到启动号');
  refused({ currentBootId: '22222222-2222-2222-2222-222222222222' }, '机器重启过');
  refused({ unit: { MainPID: '0', InvocationID: observed.InvocationID } }, '读数里没有 ControlGroup 这一项');
  // systemd 说 cgroup 没了，目录却还在：读数自相矛盾，不认
  refused({ serviceCgroup: directory() }, 'ControlGroup 空而目录还在');
  // systemd 说 cgroup 还在
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: null }, '目录却不在');
  refused({ unit: { ...observed, ControlGroup: '/system.slice/other.service' }, serviceCgroup: directory() }, '不是记录里的那个路径');
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory({ ino: 4712n }) }, '目录被换过（节点号不同）');
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory({ dev: 31n }) }, '设备号不同');
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory({ uid: 65534n }) }, '目录不归 root');
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory({ mode: 0o40775n }) }, '目录组可写');
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory({ isSymbolicLink: () => true }) }, '是个链接');
  refused({ unit: { ...observed, ControlGroup: control }, serviceCgroup: directory({ isDirectory: () => false }) }, '不是目录');
  refused({ old: {} }, '没有记录');
});
