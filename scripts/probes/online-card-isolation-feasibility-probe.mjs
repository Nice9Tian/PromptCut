/**
 * 可行性入口沿用，改为已定 P1/P3 的正反向浏览器验收。
 * 旧出口封堵、WebRTC封堵、Blob吞吐对比不再作为可执行前提；无票据分源/header检查保留。
 * 四类外链、无TT可执行、真实 hosted API闸、SOP与素材路径由同一实际模块夹具核。
 * node scripts/probes/online-card-isolation-feasibility-probe.mjs --base-port 5900 [--out <TMP>]
 */
import './card-policy-probe.mjs';
