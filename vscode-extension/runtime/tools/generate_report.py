#!/usr/bin/env python3
"""TRA report generator (zero dependencies). Mirrors tools/generate-report.mjs.
Usage: python tools/generate_report.py <project-dir>"""
import html as html_lib
import json, os, sys
import textwrap
from pathlib import Path

root = Path(__file__).resolve().parents[1]

def has_tra_project(d: Path) -> bool:
    return (d / "01-project-description/project.json").exists()

def resolve_project_path():
    arg = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("EMBEDRISK_PROJECT_DIR")
    if arg:
        p = Path(arg) if os.path.isabs(arg) else (root / arg)
        if not has_tra_project(p):
            raise FileNotFoundError(f"TRA project not found at: {p}")
        return arg, p

    for search_root in (root / "projects", root / ".." / ".." / "webapp" / "projects"):
        if not search_root.exists():
            continue
        for entry in search_root.iterdir():
            if entry.is_dir() and has_tra_project(entry):
                return str(entry), entry

    raise FileNotFoundError("No TRA project found. Pass a project path as argv[1] or EMBEDRISK_PROJECT_DIR.")

proj, base = resolve_project_path()
read = lambda p: json.loads((base / p).read_text(encoding="utf8"))
scheme = json.loads((root / ".assets/knowledge-base/risk-scheme.json").read_text(encoding="utf8"))

project = read("01-project-description/project.json")
ass = read(project["steps"]["02-assumptions"])
sys_def = read(project["steps"]["03-system-assets"])
threats = read(project["steps"]["06-threats"])["threats"]
cms = read(project["steps"]["08-countermeasures"])["countermeasures"]
try:
    dfd = read(project["steps"]["04-dfd"])
except Exception:
    dfd = {"nodes": [], "flows": []}

def dfd_svg(dfd, layer=1):
    def svg_label(value, x, center_y, width=18):
        lines = textwrap.wrap(str(value or ""), width=width, break_long_words=True, break_on_hyphens=False) or [""]
        first_y = center_y - ((len(lines) - 1) * 11 / 2)
        spans = "".join(
            f"<tspan x='{x}' dy='{'0' if index == 0 else '11'}'>{html_lib.escape(line)}</tspan>"
            for index, line in enumerate(lines)
        )
        return f"<text x='{x}' y='{first_y}' text-anchor='middle' font-size='11'>{spans}</text>"

    ROW = {"external-entity": 0, "process": 1, "multiprocess": 1, "store": 2}
    nodes = [n for n in dfd["nodes"] if n.get("layer") == layer and n["type"] != "trust-boundary"]
    col = {0: 0, 1: 0, 2: 0}
    pos = {}
    out = []
    for n in nodes:
        r = ROW.get(n["type"], 1); x = 30 + col[r] * 180; y = 50 + r * 110; col[r] += 1
        pos[n["id"]] = (x, y)
        shape = (f"<ellipse cx='{x+60}' cy='{y+25}' rx='60' ry='25' fill='#fff' stroke='#333'/>" if n["type"] in ("process", "multiprocess")
                 else f"<rect x='{x}' y='{y}' width='120' height='50' fill='none' stroke='#333' stroke-width='1' style='border-top:0'/>" if n["type"] == "store"
                 else f"<rect x='{x}' y='{y}' width='120' height='50' fill='#fff' stroke='#333'/>")
        out.append(shape + svg_label(n.get("label", ""), x + 60, y + 28))
    for f in dfd["flows"]:
        if f["from"] in pos and f["to"] in pos:
            x1, y1 = pos[f["from"]]; x2, y2 = pos[f["to"]]
            out.append(f"<line x1='{x1+60}' y1='{y1+25}' x2='{x2+60}' y2='{y2+25}' stroke='#666' marker-end='url(#a)'/><text x='{(x1+x2)/2+60}' y='{(y1+y2)/2+20}' font-size='9' fill='#666'>{f.get('label','')}</text>")
    return (f"<svg width='720' height='400' xmlns='http://www.w3.org/2000/svg'><defs><marker id='a' markerWidth='8' markerHeight='8' refX='7' refY='3' orient='auto'><path d='M0,0L7,3L0,6' fill='#666'/></marker></defs>{''.join(out)}</svg>")

def band(r):
    return next((b for b in scheme["matrix"]["bands"] if b["min"] <= r <= b["max"]), scheme["matrix"]["bands"][0])

def residual(t):
    links = [a for c in cms for a in c["addresses"] if a["threat"] == t["id"]]
    if not links:
        return t["likelihood"], t["impact"]
    # Single most-protective control (lowest residual product). Never combine the best likelihood
    # from one control with the best impact from another (Mauw & Oostdijk 2005; ISO/IEC 27005).
    best, best_score = (t["likelihood"], t["impact"]), None
    for a in links:
        rl = a.get("residualLikelihood", t["likelihood"]); ri = a.get("residualImpact", t["impact"])
        s = (rl or 0) * (ri or 0)
        if best_score is None or s < best_score:
            best_score, best = s, (rl, ri)
    return best

ids = {c["id"] for c in sys_def["components"]}
tids = {t["id"] for t in threats}
tById = {t["id"]: t for t in threats}
issues = []
if not ass.get("attacker"):
    issues.append("No attacker assumptions (required for likelihood).")
for t in threats:
    if not t.get("likelihood") or not t.get("impact"):
        issues.append(f"{t['id']}: missing risk rating.")
    if not t.get("stride"):
        issues.append(f"{t['id']}: no STRIDE category assigned.")
    if not t.get("components"):
        issues.append(f"{t['id']}: orphaned threat (no component).")
    for c in t.get("components", []):
        if c not in ids:
            issues.append(f"{t['id']}: references unknown component {c}.")
    if t.get("status") == "mitigated":
        impl = any(a["threat"] == t["id"] and c.get("status") in ("implemented", "verified") for c in cms for a in c["addresses"])
        if not impl:
            issues.append(f"{t['id']}: status 'mitigated' but no implemented/verified countermeasure addresses it.")
for c in cms:
    for a in c["addresses"]:
        if a["threat"] not in tids:
            issues.append(f"{c['id']}: addresses unknown threat {a['threat']}.")
            continue
        th = tById[a["threat"]]
        if a.get("residualImpact") is not None and a["residualImpact"] > th["impact"]:
            issues.append(f"{c['id']}: residual impact for {a['threat']} ({a['residualImpact']}) exceeds initial ({th['impact']}).")
        if a.get("residualLikelihood") is not None and a["residualLikelihood"] > th["likelihood"]:
            issues.append(f"{c['id']}: residual likelihood for {a['threat']} ({a['residualLikelihood']}) exceeds initial ({th['likelihood']}).")
        if c.get("type") == "preventive" and a.get("residualImpact") is not None and a["residualImpact"] < th["impact"]:
            issues.append(f"{c['id']}: a preventive control should reduce likelihood, not impact ({a['threat']}).")

# Lightweight JSON-Schema validation (zero dependency): required keys, types, enums, ranges.
_T = {"string": str, "integer": int, "number": (int, float), "object": dict, "array": list, "boolean": bool}
def _check(inst, sch, path, out):
    t = sch.get("type")
    if isinstance(t, str) and t in _T and not isinstance(inst, _T[t]):
        out.append(f"{path or 'root'}: expected {t}"); return out
    if "enum" in sch and inst not in sch["enum"]:
        out.append(f"{path}: '{inst}' not allowed")
    if isinstance(inst, dict):
        for k in sch.get("required", []):
            if k not in inst: out.append(f"{path}/{k} required")
        for k, sub in sch.get("properties", {}).items():
            if k in inst: _check(inst[k], sub, f"{path}/{k}", out)
    if isinstance(inst, list) and "items" in sch:
        for i, it in enumerate(inst): _check(it, sch["items"], f"{path}[{i}]", out)
    if isinstance(inst, (int, float)) and not isinstance(inst, bool):
        if "minimum" in sch and inst < sch["minimum"]: out.append(f"{path}: below minimum")
        if "maximum" in sch and inst > sch["maximum"]: out.append(f"{path}: above maximum")
    return out
_sd = root / ".assets/schema"
for inst, sname in [(project, "tra-project"), (ass, "assumptions"), (sys_def, "system"), (dfd, "dfd"), ({"threats": threats}, "threats"), ({"countermeasures": cms}, "countermeasures")]:
    try:
        for e in _check(inst, json.loads((_sd / f"{sname}.schema.json").read_text(encoding="utf8")), "", [])[:8]:
            issues.append(f"schema [{sname}] {e}")
    except Exception as ex:
        issues.append(f"schema [{sname}] {ex}")

rows = ""
for t in threats:
    r = t["likelihood"] * t["impact"]; rl, ri = residual(t); rr = rl * ri
    classification = [
        f"<b>Classification:</b> {html_lib.escape(str(t.get('classification') or '—'), quote=True)}",
        f"<b>Responsibility:</b> {html_lib.escape(str(t.get('responsibility') or '—'), quote=True)}",
    ]
    if t.get("deploymentConstraints"):
        classification.append(f"<b>Deployment constraints:</b> {html_lib.escape(str(t['deploymentConstraints']), quote=True)}")
    rows += f"<tr><td>{html_lib.escape(str(t['id']), quote=True)}</td><td>{html_lib.escape(str(t['title']), quote=True)}</td><td>{html_lib.escape(''.join(t['stride']), quote=True)}</td><td>{'<br>'.join(classification)}</td><td>{t['likelihood']}x{t['impact']}=<b style='color:{band(r)['color']}'>{r} {band(r)['name']}</b></td><td>{rl}x{ri}=<b style='color:{band(rr)['color']}'>{rr} {band(rr)['name']}</b></td><td>{html_lib.escape(str(t['status']), quote=True)}</td></tr>"

assets = "".join(f"<li>{a['name']} (C{a['objectives']['confidentiality']}/I{a['objectives']['integrity']}/A{a['objectives']['availability']}/S{a['objectives']['safety']})</li>" for a in sys_def["assets"])
atk = "".join(f"<li><b>{a['name']}</b> cap {a['capability']}, {a['access']}: {a['text']}</li>" for a in ass["attacker"])
cmrows = "".join(f"<li><b>{c['id']}</b> {c['title']} → {', '.join(a['threat'] for a in c['addresses'])} ({c.get('status','')})</li>" for c in cms)

def _esc(s):
    return html_lib.escape(str(s), quote=True)

def _tree_ul(node):
    kids = node.get("children") or []
    structural = node.get("kind") in ("goal", "step", "substep", "category")
    meta = f" <em>[{node.get('gate', 'AND')}]</em>" if (structural and kids) else ""
    if node.get("kind") == "countermeasure":
        meta += f" <span style='color:#2e7d32'>(defence{(' ' + node['countermeasureRef']) if node.get('countermeasureRef') else ''})</span>"
    if node.get("kind") == "vulnerability":
        meta += " <span style='color:#c62828'>(vulnerability)</span>"
    inner = "<ul>" + "".join(f"<li>{_tree_ul(c)}</li>" for c in kids) + "</ul>" if kids else ""
    return _esc(node.get("label", "")) + meta + inner

try:
    trees = read("07-attack-trees/attack-trees.json").get("trees", [])
except Exception:
    trees = []
trees_html = ""
def _tree_threat_refs(tr):
    # De-duplicated union of threatRefs[] and legacy threatRef (same rule as the webapp and attacktree-model.js threatRefsOf).
    refs = tr.get("threatRefs")
    refs = list(refs) if isinstance(refs, list) else []
    if tr.get("threatRef"):
        refs.append(tr.get("threatRef"))
    return list(dict.fromkeys(r for r in refs if isinstance(r, str) and r))

for tr in trees:
    trefs = _tree_threat_refs(tr)
    for tref in trefs:
        if tref not in tids:
            issues.append(f"Attack tree '{tr.get('id')}' references unknown threat '{tref}'.")
    heading = _esc(tr.get("title", tr.get("id", "")))
    if trefs:
        heading += f" &mdash; {_esc(', '.join(trefs))}"
    trees_html += f"<h3>{heading}</h3>{('<ul><li>' + _tree_ul(tr['root']) + '</li></ul>') if tr.get('root') else ''}"
trees_section = f"<h2>Attack trees</h2>{trees_html}" if trees_html else ""

warn = f"<ul class=warn>{''.join(f'<li>{i}</li>' for i in issues)}</ul>" if issues else "<p>No issues found.</p>"
html = (f"<!doctype html><meta charset=utf8><title>TRA {project['title']}</title>"
        "<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}h1{font-size:1.4rem}.warn{color:#c62828}</style>"
        f"<h1>{project['title']}</h1><p>Device: {project['device']['name']} | SL-C {project['slTarget']} | mode {project['scope']['mode']} | status {project['status']}</p>"
        f"<p><b>Scope:</b> {project['scope'].get('boundary','')}</p>"
        f"<h2>Data flow diagram (layer 1)</h2>{dfd_svg(dfd)}"
        f"<h2>Attacker profiles</h2><ul>{atk}</ul><h2>Assets</h2><ul>{assets}</ul>"
        f"<h2>Threats &amp; risk</h2><table><tr><th>ID</th><th>Threat</th><th>STRIDE</th><th>Classification</th><th>Initial</th><th>Residual</th><th>Status</th></tr>{rows}</table>"
        f"<h2>Countermeasures</h2><ul>{cmrows}</ul>"
        f"{trees_section}"
        f"<h2>Plausibility check</h2>{warn}")
(base / "report").mkdir(exist_ok=True)
(base / "report/index.html").write_text(html, encoding="utf8")
print(f"Report written to {proj}/report/index.html; {len(issues)} plausibility issue(s).")
