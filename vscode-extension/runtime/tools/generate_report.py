#!/usr/bin/env python3
"""TRA report generator (zero dependencies). Mirrors tools/generate-report.mjs.
Usage: python tools/generate_report.py <project-dir>"""
import hashlib
import html as html_lib
import json, os, sys
import textwrap
from pathlib import Path
from urllib.parse import unquote, urlsplit

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

project = read("01-project-description/project.json")

def normalize_scheme(source):
    if source.get("schemaVersion") != 2:
        raise ValueError("unsupported risk-scheme schema")

    def axis(name):
        value = source[name]
        levels = []
        for index, level in enumerate(value["levels"], 1):
            if level.get("value") != index:
                raise ValueError(f"{name} levels must be contiguous")
            item = {key: level[key] for key in ("value", "code", "label")}
            if "description" in level:
                item["description"] = level["description"]
            levels.append(item)
        derivation = {"kind": value["derivation"]["kind"]}
        if "probabilityThresholds" in value["derivation"]:
            derivation["probabilityThresholds"] = dict(sorted(value["derivation"]["probabilityThresholds"].items(), key=lambda pair: int(pair[0])))
        criteria = [{"id": item["id"], "label": item["label"], "levelTexts": item["levelTexts"]} for item in value["criteria"]]
        return {"levels": levels, "derivation": derivation, "criteria": criteria}

    likelihood, impact = axis("likelihood"), axis("impact")
    classification_source = source["classification"]
    levels = []
    for level in classification_source["levels"]:
        item = {key: level[key] for key in ("id", "label", "rank", "color", "treatment")}
        for optional in ("acceptanceBy", "description"):
            if optional in level:
                item[optional] = level[optional]
        levels.append(item)
    classification = {"kind": classification_source["kind"], "levels": levels}
    if classification["kind"] == "lookup":
        classification["matrix"] = classification_source["matrix"]
    elif classification["kind"] == "product-bands":
        classification["bands"] = sorted(classification_source["bands"], key=lambda item: item["min"])
    else:
        raise ValueError("unsupported risk classification")
    normalized = {
        "schemaVersion": 2,
        "id": source["id"],
        "title": source["title"],
        "version": source["version"],
        "likelihood": likelihood,
        "impact": impact,
        "classification": classification,
        "highLevel": source.get("highLevel", "high"),
    }
    if "description" in source:
        normalized["description"] = source["description"]
    if "acceptance" in source:
        normalized["acceptance"] = {"defaultLevel": source["acceptance"]["defaultLevel"]}
    return normalized

def stable_json(value):
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + stable_json(value[key]) for key in sorted(value)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(stable_json(item) for item in value) + "]"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

workspace_root = root if (root / "webapp").is_dir() else root.parents[1]
builtin_dir = root / "webapp" / ".assets" / "knowledge-base" if (root / "webapp").is_dir() else root / ".assets" / "knowledge-base"
asset_root = builtin_dir.parent
scheme_directory = Path(os.environ.get("EMBEDRISK_RISK_SCHEME_DIRECTORY") or workspace_root / "webapp" / ".local" / "risk-schemes")
schemes = {}
for path in sorted(builtin_dir.glob("risk-scheme-5x5-*.json")):
    try:
        candidate = normalize_scheme(json.loads(path.read_text(encoding="utf8")))
        schemes[candidate["id"]] = candidate
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        continue
for path in sorted(scheme_directory.glob("*.json")) if scheme_directory.is_dir() else []:
    try:
        candidate = normalize_scheme(json.loads(path.read_text(encoding="utf8")))
        if not candidate["id"].startswith("builtin:"):
            schemes[candidate["id"]] = candidate
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        continue
scheme_fingerprints = {scheme_id: hashlib.sha256(stable_json(candidate).encode("utf8")).hexdigest() for scheme_id, candidate in schemes.items()}
legacy_ids = {"exposure-exploitability-impact": "builtin:5x5-exposure", "cost-based": "builtin:5x5-cost"}
scheme_id = project.get("riskSchemeId") or legacy_ids.get(project.get("riskScoringMethod"), "builtin:5x5-cost")
scheme = schemes.get(scheme_id)
scheme_warning = None
if scheme is None:
    scheme_warning = f"Risk scheme '{scheme_id}' is unavailable. Raw stored L/I values are shown."
elif project.get("riskSchemeFingerprint") and project["riskSchemeFingerprint"] != scheme_fingerprints[scheme_id]:
    scheme_warning = f"Risk scheme '{scheme_id}' has changed since this project was rated. Raw stored L/I values are shown."
    scheme = None
_DEFAULT_STEPS = {
    "02-assumptions": "02-assumptions/assumptions.json",
    "03-system-assets": "03-system-assets/system.json",
    "04-dfd": "04-dfd/dfd.json",
    "05-requirements": "05-requirements/requirements.json",
    "06-threats": "06-threats/threats.json",
    "08-countermeasures": "08-countermeasures/countermeasures.json",
}
project["steps"] = {**_DEFAULT_STEPS, **(project.get("steps") if isinstance(project.get("steps"), dict) else {})}
ass = read(project["steps"]["02-assumptions"])
sys_def = read(project["steps"]["03-system-assets"])
threats = read(project["steps"]["06-threats"])["threats"]
cms = read(project["steps"]["08-countermeasures"])["countermeasures"]
try:
    reqs = read(project["steps"]["05-requirements"]).get("requirements", [])
except Exception:
    reqs = []
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
            out.append(f"<line x1='{x1+60}' y1='{y1+25}' x2='{x2+60}' y2='{y2+25}' stroke='#666' marker-end='url(#a)'/><text x='{(x1+x2)/2+60}' y='{(y1+y2)/2+20}' font-size='9' fill='#666'>{_esc(f.get('label',''))}</text>")
    return (f"<svg width='720' height='400' xmlns='http://www.w3.org/2000/svg'><defs><marker id='a' markerWidth='8' markerHeight='8' refX='7' refY='3' orient='auto'><path d='M0,0L7,3L0,6' fill='#666'/></marker></defs>{''.join(out)}</svg>")

def classify(likelihood, impact):
    if scheme is None or not isinstance(likelihood, int) or not isinstance(impact, int) or likelihood <= 0 or impact <= 0:
        return None
    classification = scheme["classification"]
    score = likelihood * impact
    if classification["kind"] == "lookup":
        level_id = classification["matrix"].get(str(impact), {}).get(str(likelihood))
    else:
        band = next((item for item in classification["bands"] if item["min"] <= score <= item["max"]), None)
        level_id = band["level"] if band else None
    level = next((item for item in classification["levels"] if item["id"] == level_id), None)
    return {**level, "score": score} if level else None

def within_acceptance(threat, likelihood, impact):
    level = classify(likelihood, impact)
    if not level:
        return False
    if level.get("treatment") == "auto-accept":
        return True
    if level.get("acceptanceBy") == "management":
        return threat.get("status") == "accepted" and bool(str(threat.get("acceptedBy") or "").strip())
    acceptable_level = project.get("acceptableLevel") or (scheme or {}).get("acceptance", {}).get("defaultLevel")
    if acceptable_level:
        threshold = next((item for item in (scheme or {}).get("classification", {}).get("levels", []) if item["id"] == acceptable_level), None)
        return threshold is not None and level["rank"] <= threshold["rank"]
    acceptable_risk = project.get("acceptableRisk", 12)
    if not isinstance(acceptable_risk, (int, float)) or isinstance(acceptable_risk, bool):
        acceptable_risk = 12
    return level["score"] <= acceptable_risk

def _esc(value):
    return html_lib.escape(str(value), quote=True)

def _safe_href(value):
    ref = str(value or "").strip()
    if not ref or ref.startswith("/") or "\\" in ref or any(ord(char) <= 32 or ord(char) == 127 for char in ref):
        return None
    try:
        parsed = urlsplit(ref)
    except ValueError:
        return None
    if parsed.scheme:
        return ref if parsed.scheme.lower() in ("http", "https") and ref.lower().startswith(("http://", "https://")) else None
    if parsed.netloc:
        return None
    path = unquote(parsed.path)
    if path.startswith("/") or "\\" in path or ".." in path.split("/"):
        return None
    return ref

def _risk_criteria_html(criteria):
    if not criteria:
        return ""
    inputs = [(label, criteria.get("inputs", {}).get(key)) for key, label in (
        ("regulation", "Regulation"), ("contracts", "Contracts"), ("riskNature", "Nature of risk"),
        ("users", "Users"), ("productType", "Product type"), ("stateOfTheArt", "State of the art"),
    ) if criteria.get("inputs", {}).get(key)]
    if not criteria.get("schemeJustification") and not criteria.get("schemeSource") and not inputs:
        return ""
    items = "".join(f"<li><b>{_esc(label)}:</b> {_esc(value)}</li>" for label, value in inputs)
    return ("<h3>Scheme selection and criteria</h3>"
            + (f"<p><b>Justification:</b> {_esc(criteria['schemeJustification'])}</p>" if criteria.get("schemeJustification") else "")
            + (f"<p><b>Source:</b> {_esc(criteria['schemeSource'])}</p>" if criteria.get("schemeSource") else "")
            + (f"<ul>{items}</ul>" if items else ""))

def _contrast_text_color(color):
    value = str(color or "").removeprefix("#")
    if len(value) != 6:
        return "#1d2430"
    try:
        channels = [int(value[index:index + 2], 16) / 255 for index in (0, 2, 4)]
    except ValueError:
        return "#1d2430"
    luminance = sum((channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4) * weight
                    for channel, weight in zip(channels, (0.2126, 0.7152, 0.0722)))
    contrast = lambda value: (max(luminance, value) + 0.05) / (min(luminance, value) + 0.05)
    return "#fff" if contrast(1) >= contrast(0.018) else "#1d2430"

def risk_cell(likelihood, impact):
    if scheme is None:
        return f"L{_esc(likelihood if likelihood is not None else '—')} / I{_esc(impact if impact is not None else '—')} (unavailable)"
    level = classify(likelihood, impact)
    if not level:
        return "None"
    if scheme["classification"]["kind"] == "lookup":
        return _esc(level["label"])
    return f"{likelihood}x{impact}=<b style='color:{_esc(level['color'])}'>{level['score']} {_esc(level['label'])}</b>"

def risk_scheme_html():
    if scheme is None:
        return f"<h2>Risk scheme</h2><div class='warn'><b>Risk classification unavailable:</b> {_esc(scheme_warning)} Raw stored L/I values are shown.</div>{_risk_criteria_html(project.get('riskCriteria'))}"
    likelihoods = scheme["likelihood"]["levels"]
    impacts = list(reversed(scheme["impact"]["levels"]))
    matrix_rows = []
    for impact_level in impacts:
        cells = []
        for likelihood_level in likelihoods:
            level = classify(likelihood_level["value"], impact_level["value"])
            label = level["label"] if scheme["classification"]["kind"] == "lookup" else level["score"]
            cells.append(f"<td style='background:{_esc(level['color'])};color:{_contrast_text_color(level['color'])}' title='{_esc(likelihood_level['code'])} x {_esc(impact_level['code'])} · {_esc(level['label'])}'>{_esc(label)}</td>")
        matrix_rows.append(f"<tr><th scope='row'>{_esc(impact_level['code'])} · {_esc(impact_level['label'])}</th>{''.join(cells)}</tr>")
    legend = "".join(f"<span style='display:inline-flex;align-items:center;gap:4px;margin-right:10px'><i style='display:inline-block;width:10px;height:10px;background:{_esc(level['color'])}'></i>{_esc(level['label'])}</span>" for level in scheme["classification"]["levels"])
    headers = "".join(f"<th scope='col'>{_esc(level['code'])}</th>" for level in likelihoods)
    return (f"<h2>Risk scheme</h2><p><b>{_esc(scheme['title'])}</b> · v{_esc(scheme['version'])} · fingerprint "
            f"<code>{scheme_fingerprints[scheme_id]}</code></p><div>{legend}</div>"
            f"<table><caption>Active risk matrix</caption><thead><tr><th scope='col'>Impact / Likelihood</th>{headers}</tr></thead><tbody>{''.join(matrix_rows)}</tbody></table>{_risk_criteria_html(project.get('riskCriteria'))}")

def product_context_html():
    context = project.get("productContext") or {}
    functions = context.get("functions") or []
    users = context.get("users") or {}
    evidence = context.get("evidence") or []
    environment = ass.get("environment") or []
    if not functions and not users.get("description") and not users.get("vulnerableGroups") and not evidence and not environment:
        return ""
    function_items = []
    for item in functions:
        description = f" — {_esc(item['description'])}" if item.get("description") else ""
        function_items.append(f"<li><b>{_esc(item.get('name', ''))}</b>{description}</li>")
    function_rows = "<ul>" + "".join(function_items) + "</ul>" if function_items else "<p>—</p>"
    environment_items = []
    for item in environment:
        anchor = "assumption-" + "".join(char if char.isalnum() or char in "_.:-" else "-" for char in str(item.get("id", "")))
        environment_items.append(f"<li id='{_esc(anchor)}'><a href='#{_esc(anchor)}'>{_esc(item.get('id', ''))}</a> — {_esc(item.get('text', ''))}</li>")
    environment_rows = "<ul>" + "".join(environment_items) + "</ul>" if environment_items else "<p>—</p>"
    user_rows = f"<p>{_esc(users['description'])}</p>" if users.get("description") else ""
    if users.get("vulnerableGroups"):
        user_rows += "<ul>" + "".join(f"<li>{_esc(group)}</li>" for group in users["vulnerableGroups"]) + "</ul>"
    evidence_items = []
    for item in evidence:
        ref = str(item.get("ref", ""))
        href = _safe_href(ref)
        if href:
            external = href.lower().startswith(("http://", "https://"))
            target = ' target="_blank"' if external else ""
            reference = f'<a href="{_esc(href)}"{target} rel="noopener noreferrer">{_esc(ref)}</a>'
        else:
            reference = f"{_esc(ref)} <span>(not linked)</span>"
        clause = f" · {_esc(item['clause'])}" if item.get("clause") else ""
        evidence_items.append(f"<li><b>{_esc(item.get('title', ''))}</b>{clause}<br>{reference}</li>")
    evidence_rows = "<ul>" + "".join(evidence_items) + "</ul>" if evidence_items else "<p>—</p>"
    return (f"<h2>Product context</h2><h3>Functions</h3>{function_rows}"
            f"<h3>Operating environment</h3>{environment_rows}<h3>Users</h3>{user_rows or '<p>—</p>'}"
            f"<h3>Evidence</h3>{evidence_rows}")

def residual(t):
    # Mirrors webapp/server/src/risk.js: unfeasible -> 0/0; only selected countermeasures count;
    # likelihood and impact minima are taken independently across links.
    if t.get("status") == "unfeasible":
        return 0, 0
    l, i = t["likelihood"], t["impact"]
    for c in cms:
        if c.get("selected") is False:
            continue
        for a in c.get("addresses") or []:
            if a.get("threat") == t["id"]:
                rl = a.get("residualLikelihood"); ri = a.get("residualImpact")
                l = min(l, t["likelihood"] if rl is None else rl)
                i = min(i, t["impact"] if ri is None else ri)
    return l, i

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
_sd = asset_root / "schema"
for inst, sname in [(project, "tra-project"), (ass, "assumptions"), (sys_def, "system"), (dfd, "dfd"), ({"threats": threats}, "threats"), ({"countermeasures": cms}, "countermeasures")]:
    try:
        for e in _check(inst, json.loads((_sd / f"{sname}.schema.json").read_text(encoding="utf8")), "", [])[:8]:
            issues.append(f"schema [{sname}] {e}")
    except Exception as ex:
        issues.append(f"schema [{sname}] {ex}")

def cell(l, i, v):
    b = band(v)
    return f"{l}x{i}=<b style='color:{b['color']}'>{v} {b['name']}</b>"

rows = ""
def within_acceptance(threat, likelihood, impact):
    if scheme is None:
        return False
    level = classify(likelihood, impact)
    if not level or level.get("id") == "none":
        return False
    if level.get("treatment") == "auto-accept":
        return True
    acceptable_level = project.get("acceptableLevel") or scheme.get("acceptance", {}).get("defaultLevel")
    if acceptable_level:
        threshold = next((item for item in scheme["classification"]["levels"] if item["id"] == acceptable_level), None)
        return threshold is not None and level["rank"] <= threshold["rank"]
    threshold = project.get("acceptableRisk", 12)
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
        threshold = 12
    return level["score"] <= threshold

rows = ""
for t in threats:
    unf = t.get("status") == "unfeasible"; na = "<b>n/a (unfeasible)</b>"
    rl, ri = residual(t)
    classification = [
        f"<b>Classification:</b> {html_lib.escape(str(t.get('classification') or '—'), quote=True)}",
        f"<b>Responsibility:</b> {html_lib.escape(str(t.get('responsibility') or '—'), quote=True)}",
    ]
    if t.get("deploymentConstraints"):
        classification.append(f"<b>Deployment constraints:</b> {html_lib.escape(str(t['deploymentConstraints']), quote=True)}")
    initial = na if unf else risk_cell(t.get("likelihood"), t.get("impact"))
    remaining = na if unf else risk_cell(rl, ri)
    level = classify(rl, ri)
    acceptance_statement = ""
    if scheme is not None and within_acceptance(t, rl, ri) and level:
        acceptable = project.get("acceptableLevel") or scheme.get("acceptance", {}).get("defaultLevel") or project.get("acceptableRisk", 12)
        acceptance_statement = f"<br><span>Within acceptance criteria (scheme {_esc(scheme['id'])} v{_esc(scheme['version'])}, level {_esc(level['label'])}, acceptable {_esc(acceptable)}).</span>"
    compromised_objectives = "; ".join(t.get("compromisedObjectives") or [])
    cause = t.get("cause") or "—"
    rows += f"<tr><td>{html_lib.escape(str(t['id']), quote=True)}</td><td>{html_lib.escape(str(t['title']), quote=True)}</td><td>{html_lib.escape(''.join(t['stride']), quote=True)}</td><td>{'<br>'.join(classification)}</td><td>{initial}</td><td>{remaining}</td><td>{html_lib.escape(str(t['status']), quote=True)}{acceptance_statement}</td><td>{_esc(compromised_objectives or '—')}</td><td>{_esc(cause)}</td></tr>"

assets = "".join(f"<li>{_esc(a['name'])} (C{_esc(a['objectives']['confidentiality'])}/I{_esc(a['objectives']['integrity'])}/A{_esc(a['objectives']['availability'])}/S{_esc(a['objectives']['safety'])})</li>" for a in sys_def["assets"])
def cap_label(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 1:
        return f"capability {min(4, v)} · Threat actor {min(4, v)}"
    return f"capability {v if v is not None else '—'}"

atk = "".join(f"<li><b>{html_lib.escape(str(a.get('name','')), quote=True)}</b> {html_lib.escape(cap_label(a.get('capability')), quote=True)}, {html_lib.escape(str(a.get('access','—')), quote=True)}: {html_lib.escape(str(a.get('text','')), quote=True)}</li>" for a in ass["attacker"])
cmrows = "".join(f"<li><b>{_esc(c['id'])}</b> {_esc(c['title'])} → {_esc(', '.join(a['threat'] for a in c['addresses']))} ({_esc(c.get('status',''))})</li>" for c in cms)

def disclosure_item(threat, extra=""):
    requirement_ids = [item.get("id", "") for item in reqs if threat.get("id") in item.get("derivedFromThreat", [])]
    responsibility = f" · {_esc(threat.get('responsibility'))}" if threat.get("responsibility") else ""
    constraints = f"<br><b>Deployment constraints:</b> {_esc(threat.get('deploymentConstraints'))}" if threat.get("deploymentConstraints") else ""
    return (f"<li><b>{_esc(threat.get('id'))}</b> {_esc(threat.get('title'))}{responsibility}{extra}{constraints}"
            f"<br><b>Requirements:</b> {_esc(', '.join(requirement_ids) or '—')}</li>")

acceptable_risk = project.get("acceptableRisk", 12)
if not isinstance(acceptable_risk, (int, float)) or isinstance(acceptable_risk, bool):
    acceptable_risk = 12
by_responsibility = []
for threat in threats:
    residual_likelihood, residual_impact = residual(threat)
    residual_score = residual_likelihood * residual_impact
    level = classify(residual_likelihood, residual_impact)
    above_acceptable = residual_score > 0 and not (level and level.get("treatment") == "auto-accept") and residual_score > acceptable_risk
    if ((threat.get("classification") and threat.get("classification") != "product-vulnerability")
            or threat.get("status") in ("accepted", "transferred") or above_acceptable):
        by_responsibility.append(threat)
avoided = [threat for threat in threats if threat.get("status") == "avoided"]
accepted_deviations = [threat for threat in threats if threat.get("status") == "accepted" and threat.get("acceptanceDeviation")]
risk_disclosure_html = ""
if by_responsibility or avoided or accepted_deviations:
    risk_disclosure_html = "<h2>Residual risks and expectations on users and integrators</h2>"
    if by_responsibility:
        risk_disclosure_html += "<h3>By responsibility</h3><ul>" + "".join(disclosure_item(threat) for threat in by_responsibility) + "</ul>"
    if avoided:
        risk_disclosure_html += "<h3>Avoided</h3><ul>" + "".join(disclosure_item(threat, f"<br><b>Avoidance rationale:</b> {_esc(threat.get('avoidanceRationale') or '—')}") for threat in avoided) + "</ul>"
    if accepted_deviations:
        risk_disclosure_html += "<h3>Accepted deviations from the acceptance criteria</h3><ul>" + "".join(
            disclosure_item(threat, f"<br><b>Circumstance:</b> {_esc(threat['acceptanceDeviation'].get('circumstance') or '—')}<br><b>Communicated to:</b> {_esc(threat['acceptanceDeviation'].get('communicatedTo') or '—')}")
            for threat in accepted_deviations
        ) + "</ul>"

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

warn = f"<ul class=warn>{''.join(f'<li>{_esc(i)}</li>' for i in issues)}</ul>" if issues else "<p>No issues found.</p>"
html = (f"<!doctype html><html lang=\"en\"><head><meta charset=utf8><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\"><title>TRA {_esc(project['title'])}</title>"
    "<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}h1{font-size:1.4rem}.warn{color:#c62828}@media print{body{margin:0;max-width:none}table{page-break-inside:auto}tr{break-inside:avoid;page-break-inside:avoid}}</style></head><body><main>"
        f"<h1>{_esc(project['title'])}</h1><p>Device: {_esc(project['device']['name'])} | SL-C {_esc(project['slTarget'])} | mode {_esc(project['scope']['mode'])} | status {_esc(project['status'])}</p>"
        f"<p><b>Scope:</b> {_esc(project['scope'].get('boundary',''))}</p>"
        f"{product_context_html()}"
        f"<h2>Data flow diagram (layer 1)</h2>{dfd_svg(dfd)}"
        f"<h2>Attacker profiles</h2><ul>{atk}</ul><h2>Assets</h2><ul>{assets}</ul>"
        f"{risk_scheme_html()}"
        f"<h2>Threats &amp; risk</h2><table><caption>Threats and risk</caption><thead><tr><th scope='col'>ID</th><th scope='col'>Threat</th><th scope='col'>STRIDE</th><th scope='col'>Classification</th><th scope='col'>Initial</th><th scope='col'>Residual</th><th scope='col'>Status</th><th scope='col'>Compromised objectives</th><th scope='col'>Cause</th></tr></thead><tbody>{rows}</tbody></table>{risk_disclosure_html}"
        f"<h2>Countermeasures</h2><ul>{cmrows}</ul>"
        f"{trees_section}"
        f"<h2>Plausibility check</h2>{warn}</main></body></html>")
(base / "report").mkdir(exist_ok=True)
(base / "report/index.html").write_text(html, encoding="utf8")
print(f"Report written to {proj}/report/index.html; {len(issues)} plausibility issue(s).")
