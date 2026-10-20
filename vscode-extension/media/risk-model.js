/* Deterministic risk engine — mirrors tra-webapp/client/src/lib/risk.ts.
   Isomorphic: attaches to window (webviews) and module.exports (Node tests).
   Risk = Likelihood x Impact (5x5), banded Low/Medium/High/Critical. */
(function (g) {
  "use strict";
  var DEFAULT_BANDS = [
    { name: "Low", min: 1, max: 5, color: "#2e7d32" },
    { name: "Medium", min: 6, max: 11, color: "#f9a825" },
    { name: "High", min: 12, max: 19, color: "#ef6c00" },
    { name: "Critical", min: 20, max: 25, color: "#c62828" },
  ];
  function bandsOf(scheme) {
    return scheme && scheme.matrix && scheme.matrix.bands && scheme.matrix.bands.length ? scheme.matrix.bands : DEFAULT_BANDS;
  }
  /* A zero likelihood or impact means the threat is not possible — risk 0, its own band. */
  var NONE_BAND = { name: "None", min: 0, max: 0, color: "#6b7280" };
  function band(score, scheme) {
    if (score <= 0) return NONE_BAND;
    var bands = bandsOf(scheme);
    return bands.find(function (b) { return score >= b.min && score <= b.max; }) || bands[0];
  }

  /* Residual [likelihood, impact] across all selected countermeasure links (selected === false is skipped).
     All applied controls are in effect simultaneously, so an attacker must overcome the strongest one on
     each axis: the residual likelihood is the LOWEST residual likelihood any single control achieves (the
     most protective control dominates), and likewise for impact. Unfeasible threats have no residual. */
  function residual(threat, cms) {
    if (threat.status === "unfeasible") return [0, 0];
    var links = [];
    (cms || []).forEach(function (c) {
      if (c.selected === false) return;
      (c.addresses || []).forEach(function (a) { if (a.threat === threat.id) links.push(a); });
    });
    if (!links.length) return [threat.likelihood, threat.impact];
    var rl = threat.likelihood;
    var ri = threat.impact;
    links.forEach(function (a) {
      rl = Math.min(rl, a.residualLikelihood == null ? threat.likelihood : a.residualLikelihood);
      ri = Math.min(ri, a.residualImpact == null ? threat.impact : a.residualImpact);
    });
    return [rl, ri];
  }

  function riskOf(threat, cms, scheme) {
    var initial = threat.status === "unfeasible" ? 0 : (threat.likelihood || 0) * (threat.impact || 0);
    var r = residual(threat, cms);
    var res = (r[0] || 0) * (r[1] || 0);
    return {
      initial: initial,
      initialBand: band(initial, scheme),
      residual: res,
      residualBand: band(res, scheme),
      residualLikelihood: r[0],
      residualImpact: r[1],
    };
  }

  /* Bug Bar: impact is the worst plausible dimension (max of C/I/A/Safety). */
  function deriveImpact(d) {
    if (!d) return null;
    var vals = [d.confidentiality, d.integrity, d.availability, d.safety].filter(function (x) { return typeof x === "number"; });
    return vals.length ? Math.max.apply(null, vals) : null;
  }

  /* Likelihood = geometric mean of Exposure x Exploitability, remapped to the 1-5 axis
     (P11 interview finding: a single coarse likelihood is insufficient). */
  function deriveLikelihood(f) {
    if (!f) return null;
    var has = typeof f.exposure === "number" || typeof f.exploitability === "number";
    if (!has) return null;
    var e = typeof f.exposure === "number" ? f.exposure : 3;
    var x = typeof f.exploitability === "number" ? f.exploitability : 3;
    return Math.min(5, Math.max(1, Math.round(Math.sqrt(e * x))));
  }

  function bandClass(name) { return String(name || "").toLowerCase(); }

  /* CVSS v3.1 base score from a vector string (e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H").
     Returns null when the vector is missing required metrics. Only v3.x is supported; v4.0 requires
     large lookup tables — users can still enter a v4.0 base score manually. */
  function cvss3BaseScore(vector) {
    if (!vector) return null;
    function mv(k) { var m = new RegExp('/' + k + ':([A-Z])').exec(vector); return m ? m[1] : null; }
    var AV = mv('AV'), AC = mv('AC'), PR = mv('PR'), UI = mv('UI'), S = mv('S'), C = mv('C'), I = mv('I'), A = mv('A');
    if (!AV || !AC || !PR || !UI || !S || !C || !I || !A) return null;
    var avT = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
    var acT = { L: 0.77, H: 0.44 };
    var prU = { N: 0.85, L: 0.62, H: 0.27 };
    var prC = { N: 0.85, L: 0.68, H: 0.5 };
    var uiT = { N: 0.85, R: 0.62 };
    var ciaT = { H: 0.56, L: 0.22, N: 0 };
    var sc = S === 'C';
    var av = avT[AV], ac = acT[AC], pr = (sc ? prC : prU)[PR], ui = uiT[UI];
    var cv = ciaT[C], iv = ciaT[I], av2 = ciaT[A];
    if ([av, ac, pr, ui, cv, iv, av2].some(function (x) { return typeof x !== 'number'; })) return null;
    var iss = 1 - (1 - cv) * (1 - iv) * (1 - av2);
    var impact = sc ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss * 0.9731 - 0.02, 13) : 6.42 * iss;
    var exp2 = 8.22 * av * ac * pr * ui;
    if (impact <= 0) return 0;
    var raw = sc ? Math.min(1.08 * (impact + exp2), 10) : Math.min(impact + exp2, 10);
    // v3.1 round-up: smallest value with one decimal place >= raw
    var i = Math.round(raw * 100000);
    return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
  }

  /* 1-5 exploitability hint derived from attack-side metrics in a CVSS v3.x or v4.0 vector.
     For v3.x uses AC/PR/UI. For v4.0 also includes AT (Attack Requirements). */
  function cvssExploitability(vector) {
    if (!vector) return null;
    var ver = detectCvssVersion(vector);
    function mv(k) { var m = new RegExp('/' + k + ':([A-Z])').exec(vector); return m ? m[1] : null; }
    var AC = mv('AC'), PR = mv('PR'), UI = mv('UI'), AT = mv('AT'); // AT only in v4.0
    if (!AC && !PR && !UI && !AT) return null;
    var s = 3;
    if (AC === 'L') s += 1; else if (AC === 'H') s -= 1;
    if (PR === 'N') s += 1; else if (PR === 'H') s -= 1;
    if (ver === '4.0') {
      if (AT === 'P') s -= 0.5; // Attack Requirements: present makes it harder
      if (UI === 'N') s += 0.5; else if (UI === 'A') s -= 0.5; // Active harder than Passive
    } else {
      if (UI === 'N') s += 0.5; else if (UI === 'R') s -= 0.5;
    }
    return Math.max(1, Math.min(5, Math.round(s)));
  }

  /* Map an interface exposure string to the 1-5 Exposure scale (physical=1 … remote unauthenticated=4).
     Returns null for unrecognised values so the caller knows not to auto-seed. */
  function exposureFromInterface(exposure) {
    return { physical: 1, local: 2, adjacent: 3, remote: 4 }[exposure] || null;
  }

  // ---- CVSS v4.0 data tables (FIRST.org BSD-2-Clause) ----
  var C4_LOOKUP = { "100000": 9.8, "100001": 9.5, "100010": 9.4, "100011": 8.7, "100020": 9.1, "100021": 8.1, "100100": 9.4, "100101": 8.9, "100110": 8.6, "100111": 7.4, "100120": 7.7, "100121": 6.4, "100200": 8.7, "100201": 7.5, "100210": 7.4, "100211": 6.3, "100220": 6.3, "100221": 4.9, "101000": 9.4, "101001": 8.9, "101010": 8.8, "101011": 7.7, "101020": 7.6, "101021": 6.7, "101100": 8.6, "101101": 7.6, "101110": 7.4, "101111": 5.8, "101120": 5.9, "101121": 5, "101200": 7.2, "101201": 5.7, "101210": 5.7, "101211": 5.2, "101220": 5.2, "101221": 2.5, "102001": 8.3, "102011": 7, "102021": 5.4, "102101": 6.5, "102111": 5.8, "102121": 2.6, "102201": 5.3, "102211": 2.1, "102221": 1.3, "110000": 9.5, "110001": 9, "110010": 8.8, "110011": 7.6, "110020": 7.6, "110021": 7, "110100": 9, "110101": 7.7, "110110": 7.5, "110111": 6.2, "110120": 6.1, "110121": 5.3, "110200": 7.7, "110201": 6.6, "110210": 6.8, "110211": 5.9, "110220": 5.2, "110221": 3, "111000": 8.9, "111001": 7.8, "111010": 7.6, "111011": 6.7, "111020": 6.2, "111021": 5.8, "111100": 7.4, "111101": 5.9, "111110": 5.7, "111111": 5.7, "111120": 4.7, "111121": 2.3, "111200": 6.1, "111201": 5.2, "111210": 5.7, "111211": 2.9, "111220": 2.4, "111221": 1.6, "112001": 7.1, "112011": 5.9, "112021": 3, "112101": 5.8, "112111": 2.6, "112121": 1.5, "112201": 2.3, "112211": 1.3, "112221": 0.6, "200000": 9.3, "200001": 8.7, "200010": 8.6, "200011": 7.2, "200020": 7.5, "200021": 5.8, "200100": 8.6, "200101": 7.4, "200110": 7.4, "200111": 6.1, "200120": 5.6, "200121": 3.4, "200200": 7, "200201": 5.4, "200210": 5.2, "200211": 4, "200220": 4, "200221": 2.2, "201000": 8.5, "201001": 7.5, "201010": 7.4, "201011": 5.5, "201020": 6.2, "201021": 5.1, "201100": 7.2, "201101": 5.7, "201110": 5.5, "201111": 4.1, "201120": 4.6, "201121": 1.9, "201200": 5.3, "201201": 3.6, "201210": 3.4, "201211": 1.9, "201220": 1.9, "201221": 0.8, "202001": 6.4, "202011": 5.1, "202021": 2, "202101": 4.7, "202111": 2.1, "202121": 1.1, "202201": 2.4, "202211": 0.9, "202221": 0.4, "210000": 8.8, "210001": 7.5, "210010": 7.3, "210011": 5.3, "210020": 6, "210021": 5, "210100": 7.3, "210101": 5.5, "210110": 5.9, "210111": 4, "210120": 4.1, "210121": 2, "210200": 5.4, "210201": 4.3, "210210": 4.5, "210211": 2.2, "210220": 2, "210221": 1.1, "211000": 7.5, "211001": 5.5, "211010": 5.8, "211011": 4.5, "211020": 4, "211021": 2.1, "211100": 6.1, "211101": 5.1, "211110": 4.8, "211111": 1.8, "211120": 2, "211121": 0.9, "211200": 4.6, "211201": 1.8, "211210": 1.7, "211211": 0.7, "211220": 0.8, "211221": 0.2, "212001": 5.3, "212011": 2.4, "212021": 1.4, "212101": 2.4, "212111": 1.2, "212121": 0.5, "212201": 1, "212211": 0.3, "212221": 0.1, "000000": 10, "000001": 9.9, "000010": 9.8, "000011": 9.5, "000020": 9.5, "000021": 9.2, "000100": 10, "000101": 9.6, "000110": 9.3, "000111": 8.7, "000120": 9.1, "000121": 8.1, "000200": 9.3, "000201": 9, "000210": 8.9, "000211": 8, "000220": 8.1, "000221": 6.8, "001000": 9.8, "001001": 9.5, "001010": 9.5, "001011": 9.2, "001020": 9, "001021": 8.4, "001100": 9.3, "001101": 9.2, "001110": 8.9, "001111": 8.1, "001120": 8.1, "001121": 6.5, "001200": 8.8, "001201": 8, "001210": 7.8, "001211": 7, "001220": 6.9, "001221": 4.8, "002001": 9.2, "002011": 8.2, "002021": 7.2, "002101": 7.9, "002111": 6.9, "002121": 5, "002201": 6.9, "002211": 5.5, "002221": 2.7, "010000": 9.9, "010001": 9.7, "010010": 9.5, "010011": 9.2, "010020": 9.2, "010021": 8.5, "010100": 9.5, "010101": 9.1, "010110": 9, "010111": 8.3, "010120": 8.4, "010121": 7.1, "010200": 9.2, "010201": 8.1, "010210": 8.2, "010211": 7.1, "010220": 7.2, "010221": 5.3, "011000": 9.5, "011001": 9.3, "011010": 9.2, "011011": 8.5, "011020": 8.5, "011021": 7.3, "011100": 9.2, "011101": 8.2, "011110": 8, "011111": 7.2, "011120": 7, "011121": 5.9, "011200": 8.4, "011201": 7, "011210": 7.1, "011211": 5.2, "011220": 5, "011221": 3, "012001": 8.6, "012011": 7.5, "012021": 5.2, "012101": 7.1, "012111": 5.2, "012121": 2.9, "012201": 6.3, "012211": 2.9, "012221": 1.7 };
  var C4_MAX_COMPOSED = { "eq1": { "0": ["AV:N/PR:N/UI:N/"], "1": ["AV:A/PR:N/UI:N/", "AV:N/PR:L/UI:N/", "AV:N/PR:N/UI:P/"], "2": ["AV:P/PR:N/UI:N/", "AV:A/PR:L/UI:P/"] }, "eq2": { "0": ["AC:L/AT:N/"], "1": ["AC:H/AT:N/", "AC:L/AT:P/"] }, "eq3": { "0": { "0": ["VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/"], "1": ["VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/", "VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/"] }, "1": { "0": ["VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/", "VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/"], "1": ["VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/", "VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/", "VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/", "VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/", "VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/"] }, "2": { "1": ["VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/"] } }, "eq4": { "0": ["SC:H/SI:S/SA:S/"], "1": ["SC:H/SI:H/SA:H/"], "2": ["SC:L/SI:L/SA:L/"] }, "eq5": { "0": ["E:A/"], "1": ["E:P/"], "2": ["E:U/"] } };
  var C4_MAX_SEV = { "eq1": { "0": 1, "1": 4, "2": 5 }, "eq2": { "0": 1, "1": 2 }, "eq3eq6": { "0": { "0": 7, "1": 6 }, "1": { "0": 8, "1": 8 }, "2": { "1": 10 } }, "eq4": { "0": 6, "1": 5, "2": 4 }, "eq5": { "0": 1, "1": 1, "2": 1 } };
  var C4_LEVELS = { AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 }, PR: { N: 0, L: 0.1, H: 0.2 }, UI: { N: 0, P: 0.1, A: 0.2 }, AC: { L: 0, H: 0.1 }, AT: { N: 0, P: 0.1 }, VC: { H: 0, L: 0.1, N: 0.2 }, VI: { H: 0, L: 0.1, N: 0.2 }, VA: { H: 0, L: 0.1, N: 0.2 }, SC: { H: 0.1, L: 0.2, N: 0.3 }, SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 }, SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 }, CR: { H: 0, M: 0.1, L: 0.2 }, IR: { H: 0, M: 0.1, L: 0.2 }, AR: { H: 0, M: 0.1, L: 0.2 } };
  var C4_METRICS = ['AV', 'PR', 'UI', 'AC', 'AT', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA', 'CR', 'IR', 'AR'];

  function c4parse(vector) {
    var out = {};
    vector.trim().split('/').forEach(function (part) { var kv = part.split(':'); if (kv[0] && kv[1] && kv[0] !== 'CVSS') out[kv[0]] = kv[1]; });
    return out;
  }
  function c4m(sel, metric) {
    var val = sel[metric];
    if (metric === 'E' && (val === undefined || val === 'X')) return 'A';
    if ((metric === 'CR' || metric === 'IR' || metric === 'AR') && (val === undefined || val === 'X')) return 'H';
    var mod = sel['M' + metric];
    if (mod !== undefined && mod !== 'X') return mod;
    return val;
  }
  function c4emv(metric, str) {
    var extracted = str.slice(str.indexOf(metric) + metric.length + 1);
    var slash = extracted.indexOf('/');
    return slash > 0 ? extracted.substring(0, slash) : extracted;
  }
  function c4macro(sel) {
    var eq = function (k) { return c4m(sel, k); };
    var eq1 = (eq('AV') === 'N' && eq('PR') === 'N' && eq('UI') === 'N') ? '0' :
      ((eq('AV') === 'N' || eq('PR') === 'N' || eq('UI') === 'N') && !(eq('AV') === 'N' && eq('PR') === 'N' && eq('UI') === 'N') && eq('AV') !== 'P') ? '1' : '2';
    var eq2 = (eq('AC') === 'L' && eq('AT') === 'N') ? '0' : '1';
    var eq3 = (eq('VC') === 'H' && eq('VI') === 'H') ? '0' : (eq('VC') === 'H' || eq('VI') === 'H' || eq('VA') === 'H') ? '1' : '2';
    var eq4 = (eq('MSI') === 'S' || eq('MSA') === 'S') ? '0' : (eq('SC') === 'H' || eq('SI') === 'H' || eq('SA') === 'H') ? '1' : '2';
    var eq5 = eq('E') === 'A' ? '0' : eq('E') === 'P' ? '1' : '2';
    var eq6 = ((eq('CR') === 'H' && eq('VC') === 'H') || (eq('IR') === 'H' && eq('VI') === 'H') || (eq('AR') === 'H' && eq('VA') === 'H')) ? '0' : '1';
    return eq1 + eq2 + eq3 + eq4 + eq5 + eq6;
  }
  function cvss4BaseScore(vector) {
    if (!vector) return null;
    var sel = c4parse(vector);
    if (!['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every(function (k) { return k in sel; })) return null;
    if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every(function (k) { return c4m(sel, k) === 'N'; })) return 0;
    var macro = c4macro(sel);
    var value = C4_LOOKUP[macro];
    if (value === undefined) return null;
    var digits = macro.split('').map(function (c) { return parseInt(c, 10); });
    var eq1 = digits[0], eq2 = digits[1], eq3 = digits[2], eq4 = digits[3], eq5 = digits[4], eq6 = digits[5];
    var nextKeys = [
      String(eq1 + 1) + eq2 + eq3 + eq4 + eq5 + eq6,
      String(eq1) + String(eq2 + 1) + eq3 + eq4 + eq5 + eq6,
      null, // eq3+eq6 handled below
      String(eq1) + eq2 + eq3 + String(eq4 + 1) + eq5 + eq6,
      String(eq1) + eq2 + eq3 + eq4 + String(eq5 + 1) + eq6,
    ];
    var sNext = nextKeys.map(function (k) { return k ? C4_LOOKUP[k] : undefined; });
    var sEq3Eq6;
    if (eq3 === 1 && eq6 === 1) sEq3Eq6 = C4_LOOKUP[String(eq1) + eq2 + String(eq3 + 1) + eq4 + eq5 + eq6];
    else if (eq3 === 0 && eq6 === 1) sEq3Eq6 = C4_LOOKUP[String(eq1) + eq2 + String(eq3 + 1) + eq4 + eq5 + eq6];
    else if (eq3 === 1 && eq6 === 0) sEq3Eq6 = C4_LOOKUP[String(eq1) + eq2 + eq3 + eq4 + eq5 + String(eq6 + 1)];
    else if (eq3 === 0 && eq6 === 0) { var l2 = C4_LOOKUP[String(eq1) + eq2 + eq3 + eq4 + eq5 + String(eq6 + 1)], r2 = C4_LOOKUP[String(eq1) + eq2 + String(eq3 + 1) + eq4 + eq5 + eq6]; sEq3Eq6 = (l2 === undefined && r2 === undefined) ? undefined : Math.max(l2 === undefined ? -Infinity : l2, r2 === undefined ? -Infinity : r2); }
    else sEq3Eq6 = C4_LOOKUP[String(eq1) + eq2 + String(eq3 + 1) + eq4 + eq5 + String(eq6 + 1)];
    var eq1m = C4_MAX_COMPOSED.eq1[String(eq1)];
    var eq2m = C4_MAX_COMPOSED.eq2[String(eq2)];
    var eq3eq6m = C4_MAX_COMPOSED.eq3[String(eq3)][String(eq6)];
    var eq4m = C4_MAX_COMPOSED.eq4[String(eq4)];
    var eq5m = C4_MAX_COMPOSED.eq5[String(eq5)];
    var maxVectors = [];
    for (var a = 0; a < eq1m.length; a++) for (var b = 0; b < eq2m.length; b++) for (var c = 0; c < eq3eq6m.length; c++) for (var d = 0; d < eq4m.length; d++) for (var e = 0; e < eq5m.length; e++) maxVectors.push(eq1m[a] + eq2m[b] + eq3eq6m[c] + eq4m[d] + eq5m[e]);
    var dist = {};
    for (var vi = 0; vi < maxVectors.length; vi++) {
      var mv = maxVectors[vi], di = {};
      for (var mi = 0; mi < C4_METRICS.length; mi++) { var met = C4_METRICS[mi]; di[met] = (C4_LEVELS[met][c4m(sel, met)] || 0) - (C4_LEVELS[met][c4emv(met, mv)] || 0); }
      dist = di;
      if (!C4_METRICS.some(function (met) { return di[met] < 0; })) break;
    }
    var step = 0.1;
    var csd1 = dist.AV + dist.PR + dist.UI, csd2 = dist.AC + dist.AT, csd36 = dist.VC + dist.VI + dist.VA + dist.CR + dist.IR + dist.AR, csd4 = dist.SC + dist.SI + dist.SA;
    var avEq1 = value - sNext[0], avEq2 = value - sNext[1], avEq36 = value - sEq3Eq6, avEq4 = value - sNext[3], avEq5 = value - sNext[4];
    var ms1 = C4_MAX_SEV.eq1[eq1] * step, ms2 = C4_MAX_SEV.eq2[eq2] * step, ms36 = C4_MAX_SEV.eq3eq6[eq3][eq6] * step, ms4 = C4_MAX_SEV.eq4[eq4] * step;
    var n = 0, ns = 0;
    if (!isNaN(avEq1)) { n++; ns += avEq1 * (csd1 / ms1); }
    if (!isNaN(avEq2)) { n++; ns += avEq2 * (csd2 / ms2); }
    if (!isNaN(avEq36) && !isNaN(ms36)) { n++; ns += avEq36 * (csd36 / ms36); }
    if (!isNaN(avEq4)) { n++; ns += avEq4 * (csd4 / ms4); }
    if (!isNaN(avEq5)) { n++; }
    var mean = n === 0 ? 0 : ns / n;
    value -= mean;
    return Math.round(Math.max(0, Math.min(10, value)) * 10) / 10;
  }

  /** Auto-detect CVSS version from the vector prefix (CVSS:3.1/... or CVSS:4.0/...).
   *  Falls back to the supplied version string when no prefix is found. */
  function detectCvssVersion(vector, fallback) {
    var m = vector ? /^CVSS:(\d+\.\d+)\//.exec(vector.trim()) : null;
    return m ? m[1] : (fallback || '3.1');
  }

  /** Full CVSS base score from a vector, supporting v3.0/3.1 and v4.0. */
  function cvssBaseScore(vector, version) {
    if (!vector) return null;
    var ver = detectCvssVersion(vector, version);
    if (ver === '4.0') return cvss4BaseScore(vector);
    return cvss3BaseScore(vector);
  }

  var api = { DEFAULT_BANDS: DEFAULT_BANDS, bandsOf: bandsOf, band: band, residual: residual, riskOf: riskOf, deriveImpact: deriveImpact, deriveLikelihood: deriveLikelihood, bandClass: bandClass, cvss3BaseScore: cvss3BaseScore, cvss4BaseScore: cvss4BaseScore, cvssBaseScore: cvssBaseScore, cvssExploitability: cvssExploitability, exposureFromInterface: exposureFromInterface };
  g.RiskModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
