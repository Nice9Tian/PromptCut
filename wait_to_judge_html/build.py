#!/usr/bin/env python3
"""把 source/ 下的 Markdown 待审清单套进 template.html，生成〔裁〕总审页面。

用法：
    python build.py               生成 out/index.html（本机直接打开）和 out/artifact.html（发布成链接用）
    python build.py --inline      index.html 的截图也内嵌，得到能单独发出去的一个文件
    python build.py --source 目录 --out 目录

源文件怎么写见 README.md。只用标准库，Python 3.8 及以上。
"""
import argparse
import base64
import datetime
import html
import json
import mimetypes
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ID = r"[A-Z][0-9]{2,3}"
DEFAULT_STORE_KEY = "pc-cai-verdicts-v1"

# 条目里「- 字段：值」的字段名 → 数据里的键；页面上各段的标题和顺序在 template.html 的 SECTIONS
FIELDS = {
    "状态": "status", "级别": "level", "涉及": "involve", "出处": "refs", "裁定原文": "quote", "是什么": "what",
    "为什么当时这样定": "why", "当时为什么这样定": "why", "现状": "now", "修改前 → 修改后": "diffRaw", "修改前→修改后": "diffRaw",
    "用户看得到的差别": "visible", "选项": "options", "建议": "rec", "截图": "shotNote",
}
FIELD_RE = re.compile(r"^- (" + "|".join(map(re.escape, FIELDS)) + r")[：:]\s?(.*)$")
ITEM_HEAD_RE = re.compile(r"^#{2,4}\s+(" + ID + r")\s+(.+?)\s*$")
# 别的标题、「统计」、分隔线都结束当前条目，后面的前言、附录不会混进上一条
ITEM_END_RE = re.compile(r"^(#{1,4}\s|#{1,4}\s*统计|统计[：:]|\s{0,3}([-*_])(\s*\2){2,}\s*$)")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)

STATUS_RANK = {"待审": 0, "已审": 1, "已失效": 2}
LEVEL_RANK = {"二级": 0, "三级": 1, "": 2}

# 本机打开时要的文档骨架；发布成链接时平台自己加，所以 artifact.html 不带
SKELETON = (
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n"
)

warnings = []


def warn(msg):
    warnings.append(msg)


def read(path):
    """读 UTF-8（带不带 BOM 都行），去掉 <!-- --> 注释。"""
    return COMMENT_RE.sub("", path.read_text(encoding="utf-8-sig")).replace("\r\n", "\n")


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def clean(s):
    return re.sub(r"\n{3,}", "\n\n", s or "").strip()


# ---------- 条目 ----------

def parse_items(text, name):
    """一条从「### 编号 标题」起，到下一个标题或分隔线止；「- 字段：值」开一个字段，其余行接在上一个字段后面。"""
    items, cur, field = [], None, None
    for raw in text.split("\n"):
        head = ITEM_HEAD_RE.match(raw)
        if head or ITEM_END_RE.match(raw):
            if cur:
                items.append(cur)
            cur = {"id": head.group(1), "title": head.group(2), "file": name} if head else None
            field = None
            continue
        if cur is None:
            continue
        f = FIELD_RE.match(raw)
        if f:
            field = FIELDS[f.group(1)]
            cur[field] = f.group(2)
        elif field:
            cur[field] += "\n" + re.sub(r"^ {2,}", "", raw)
    if cur:
        items.append(cur)
    return items


def norm_status(s):
    t = clean(s)
    for k in STATUS_RANK:
        if t.startswith(k):
            return k
    return t or "待审"


def norm_level(s):
    t = clean(s)
    if "二级" in t:
        return "二级"
    if "三级" in t:
        return "三级"
    return "二级" if "一级" in t else ""  # 一级也是你看得出区别的，和二级排在一起


def split_diff(raw):
    t = clean(raw)
    if not t or re.match(r"(语义未改|新增|无)", t):
        return None
    before, sep, after = t.partition(" → ")
    return {"before": before.strip(), "after": after.strip()} if sep else None


def first_sentence(s):
    """清单里标题下面那行小字：第一句，太长截断。"""
    t = clean(s).replace("`", "").replace("**", "").split("\n")[0]
    m = re.match(r"(.{8,70}?[。；])", t)
    r = m.group(1) if m else t
    return r[:70] + "…" if len(r) > 72 else r


def make_item(it):
    g = lambda k: clean(it.get(k))
    status = norm_status(it.get("status"))
    note = re.sub(r"[)）]$", "", re.sub(r"^(待审|已审|已失效)[（(：:\s]*", "", g("status")))
    return {
        "id": it["id"], "area": it["id"][0], "title": clean(it["title"]), "file": it["file"],
        "status": status, "statusNote": note, "level": norm_level(it.get("level")), "involve": g("involve"),
        "refs": g("refs"), "quote": g("quote"), "what": g("what"), "why": g("why"), "now": g("now"),
        "diff": split_diff(it.get("diffRaw")), "diffRaw": g("diffRaw"), "visible": g("visible"), "options": g("options"),
        "rec": g("rec") or (f"{status}：{note}" if status in ("已审", "已失效") else ""),
        "shotNote": g("shotNote"), "oneLine": first_sentence(it.get("what") or it.get("rec") or note),
    }


# ---------- 页头、决定、截图 ----------

def parse_report(text):
    """report.md：「# 大标题」、紧跟的「- 设置：值」，以及「## 导语」「## 分区」「## 范围与做法」各节。"""
    title, settings, sections, cur = "", {}, {}, None
    for raw in text.split("\n"):
        if cur is None and not title and raw.startswith("# "):
            title = raw[2:].strip()
        elif re.match(r"##\s", raw):
            cur = raw[2:].strip()
            sections[cur] = []
        elif cur is None:
            m = re.match(r"- ([^：:]+)[：:]\s*(.*)$", raw)
            if m:
                settings[m.group(1).strip()] = m.group(2).strip()
        else:
            sections[cur].append(raw)
    return title, settings, {k: clean("\n".join(v)) for k, v in sections.items()}


def parse_areas(table):
    """「分区」表：前缀 | 名称 | 收哪些。第一行是表头。"""
    areas = []
    rows = [r.strip() for r in table.split("\n") if r.strip().startswith("|")]
    for n, row in enumerate(rows):
        cells = [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", row)[1:]]
        if cells and not cells[-1]:
            cells.pop()
        if n == 0 or all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
            continue
        if len(cells) < 2 or not re.fullmatch(r"[A-Z]", cells[0]):
            warn(f"report.md「分区」表里这一行看不懂，跳过：{row}")
            continue
        areas.append({"key": cells[0], "name": cells[1], "scope": cells[2] if len(cells) > 2 else ""})
    return areas


def parse_verdicts(text):
    """verdicts.md：「## 日期」下面一行一条「编号 决定」或「编号 决定：补充」，缩进的行接在上一条的补充后面。"""
    entries, date, last = [], None, None
    for raw in text.split("\n"):
        if re.match(r"#{1,4}\s", raw):
            d = re.search(r"\d{4}-\d{2}-\d{2}", raw)
            date, last = (d.group(0) if d else None), None
            continue
        if date is None or not raw.strip() or raw.lstrip().startswith(">"):
            continue
        m = re.match(r"(?:[-*]\s+)?(" + ID + r")[\s：:]+(\S.*)$", raw)
        if m:
            w = re.match(r"([^\s：:]+)\s*[：:]?\s*(.*)$", m.group(2))
            v = {"date": date, "v": w.group(1).rstrip("。，,.；;！!")}
            if w.group(2).strip():
                v["note"] = w.group(2).strip()
            if len(v["v"]) > 6:
                warn(f"verdicts.md 里 {m.group(1)} 的决定「{v['v']}」很长，是不是少了「：」")
            entries.append((m.group(1), v))
            last = v
        elif last is not None and re.match(r" {2,}\S", raw):
            last["note"] = (last.get("note", "") + "\n" + raw.strip()).strip()
        else:
            warn(f"verdicts.md 这一行看不懂，跳过：{raw.strip()}")
    return entries


def parse_shots(text):
    """shots.md：每张图一节，「### 编号 图片文件名」，下面是图说。"""
    shots, cur = {}, None
    for raw in text.split("\n"):
        m = re.match(r"#{2,4}\s+(" + ID + r")\s+(.+?)\s*$", raw)
        if m:
            if m.group(1) in shots:
                warn(f"shots.md 里 {m.group(1)} 登记了不止一张图，用最后一张")
            cur = shots[m.group(1)] = {"file": m.group(2), "lines": []}
        elif re.match(r"#{1,4}\s", raw):
            cur = None
        elif cur is not None:
            cur["lines"].append(raw)
    return {k: {"file": v["file"], "caption": clean("\n".join(v["lines"]))} for k, v in shots.items()}


def data_uri(path):
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


# ---------- 组装 ----------

def build(source, out, inline):
    report = source / "report.md"
    if report.exists():
        title, settings, sections = parse_report(read(report))
    else:
        warn(f"没有 {report}，页头用缺省")
        title, settings, sections = "", {}, {}
    areas = parse_areas(sections.get("分区", ""))

    items, seen = [], set()
    for f in sorted((source / "items").glob("*.md")):
        for it in parse_items(read(f), f.name):
            if it["id"] in seen:
                warn(f"编号 {it['id']} 重复（{f.name} 里又出现一次），后一条不收")
                continue
            seen.add(it["id"])
            items.append(make_item(it))
    if not items:
        sys.exit(f"{source / 'items'} 下没有读到条目（「### 编号 标题」开头），没生成。")
    byid = {i["id"]: i for i in items}

    for letter in sorted({i["area"] for i in items} - {a["key"] for a in areas}):
        warn(f"编号前缀 {letter} 不在 report.md 的「分区」表里，先归到最后的「其他」")
        areas.append({"key": letter, "name": f"其他（{letter}）", "scope": "report.md 的「分区」表里还没有这个前缀"})

    shots_md = source / "shots.md"
    shots = parse_shots(read(shots_md)) if shots_md.exists() else {}
    used = set()
    for iid, s in shots.items():
        path = source / "shots" / s["file"]
        if iid not in byid:
            warn(f"shots.md 登记了 {iid}，但没有这一条")
        elif not path.is_file():
            warn(f"{iid} 的截图 {path} 不存在，先不放图")
        else:
            byid[iid]["shot"] = {"src": f"shots/{s['file']}", "caption": s["caption"], "alt": byid[iid]["title"]}
            used.add(s["file"])
    if (source / "shots").is_dir():
        for p in sorted((source / "shots").iterdir()):
            if p.is_file() and p.name not in used and re.fullmatch(ID, p.stem):
                warn(f"shots/{p.name} 没在 shots.md 登记，页面上不会出现")

    verdicts_md = source / "verdicts.md"
    entries = parse_verdicts(read(verdicts_md)) if verdicts_md.exists() else []
    decided = {}
    for iid, v in sorted(entries, key=lambda e: e[1]["date"]):
        if iid not in byid:
            warn(f"verdicts.md 里的 {iid} 没有对应的条目")
            continue
        if iid in decided:
            warn(f"{iid} 回过不止一次，按 {v['date']} 那次算")
        decided[iid] = v
    for iid, v in decided.items():
        it = byid[iid]
        it["decided"] = v
        it["status"] = "已审"
        it["statusNote"] = f"{v['date']} 你回：{v['v']}" + (f"：{v['note']}" if v.get("note") else "")

    rank = {a["key"]: n for n, a in enumerate(areas)}
    items.sort(key=lambda i: (rank[i["area"]], STATUS_RANK.get(i["status"], 9), LEVEL_RANK[i["level"]],
                              int(re.match(r"[A-Z]([0-9]+)", i["id"]).group(1)), i["id"]))

    data = {
        "generated": settings.get("调研日期", ""),
        "built": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "title": title or "〔裁〕总审",
        "eyebrow": settings.get("眉题", ""),
        "storeKey": settings.get("存储键") or DEFAULT_STORE_KEY,
        "lede": sections.get("导语", ""),
        "scope": sections.get("范围与做法", ""),
        "areas": [a for a in areas if any(i["area"] == a["key"] for i in items)],
        "items": items,
    }
    page_title = settings.get("页面标题") or re.sub(r"[〔〕]", "", data["title"])
    template = (HERE / "template.html").read_text(encoding="utf-8")
    for mark in ("__PAGE_TITLE__", "/*__DATA__*/"):
        if mark not in template:
            sys.exit(f"template.html 里找不到占位 {mark}，没生成。")

    def page(embed):
        d = data
        if embed:
            d = dict(data, items=[dict(i, shot=dict(i["shot"], src=data_uri(source / i["shot"]["src"])))
                                  if "shot" in i else i for i in items])
        payload = json.dumps(d, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
        return template.replace("__PAGE_TITLE__", html.escape(page_title)).replace("/*__DATA__*/", payload)

    out.mkdir(parents=True, exist_ok=True)
    if not inline and used:
        (out / "shots").mkdir(exist_ok=True)
        for name in used:
            shutil.copyfile(source / "shots" / name, out / "shots" / name)
    write(out / "index.html", SKELETON + page(inline) + "\n</html>\n")
    write(out / "artifact.html", page(True))
    return items


def main():
    ap = argparse.ArgumentParser(description="把 Markdown 待审清单生成〔裁〕总审页面")
    ap.add_argument("--source", type=Path, default=HERE / "source", help="源文件目录（缺省：本目录下的 source）")
    ap.add_argument("--out", type=Path, default=HERE / "out", help="输出目录（缺省：本目录下的 out）")
    ap.add_argument("--inline", action="store_true", help="index.html 的截图也内嵌成一个文件")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    items = build(args.source.resolve(), args.out.resolve(), args.inline)

    count = lambda k: " · ".join(f"{v} {n}" for v, n in Counter(i[k] for i in items).items())
    pending = [i for i in items if i["status"] == "待审"]
    print(f"条目 {len(items)}：{count('status')}；{count('level')}")
    print(f"分区：{count('area')}")
    print("待审二级：" + (" ".join(i["id"] for i in pending if i["level"] == "二级") or "无"))
    print("待审缺建议：" + (" ".join(i["id"] for i in pending if not i["rec"]) or "无"))
    print("有截图：" + (" ".join(i["id"] for i in items if "shot" in i) or "无"))
    print(f"已回决定：{sum('decided' in i for i in items)} 条")
    print(f"生成：{args.out.resolve() / 'index.html'}（本机打开）")
    print(f"      {args.out.resolve() / 'artifact.html'}（发布成链接用，截图已内嵌）")
    for w in warnings:
        print("注意：" + w)


if __name__ == "__main__":
    main()
