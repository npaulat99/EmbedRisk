// Report + export generator (zero extra dependencies). Produces the assessor-facing HTML
// report AND machine-readable exports (traceability CSV/JSON, CycloneDX SBOM) so the full
// asset -> threat -> risk -> requirement -> control -> residual -> evidence chain can leave
// the tool. Extend buildReport().files to add further formats (OSCAL, SARIF, …).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { projectsDir } from './paths.js';
import { readProject } from './artifacts.js';
import { resolveProjectScheme, computeRisk, residual } from './risk.js';
import { validate } from './validate.js';
import { kbVersion } from './git.js';
import { routeAround, roundedPath, labelPtOnPolyline, borderPoint } from '../../shared/dfdEngine.js';
import { normalizeActorLevel, actorLevelLabel } from '../../shared/attackerScale.js';

const esc = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const contrastTextColor = (background) => {
    const match = /^#?([\da-f]{6})$/i.exec(String(background || ''));
    if (!match) return '#1d2430';
    const channels = [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16) / 255);
    const luminance = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (value) => (Math.max(luminance, value) + 0.05) / (Math.min(luminance, value) + 0.05);
    return contrast(1) >= contrast(0.018) ? '#fff' : '#1d2430';
};
const safeHref = (value) => {
    const href = String(value ?? '').trim();
    if (!href || href.startsWith('/') || href.includes('\\') || /[\u0000-\u0020\u007f]/.test(href)) return null;
    let parsed;
    try { parsed = new URL(href, 'https://embedrisk.invalid/'); } catch { return null; }
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href)) return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && /^https?:\/\//i.test(href) ? href : null;
    if (parsed.origin !== 'https://embedrisk.invalid') return null;
    const path = href.split(/[?#]/, 1)[0];
    try {
        const decodedPath = decodeURIComponent(path);
        if (decodedPath.startsWith('/') || decodedPath.includes('\\') || decodedPath.split('/').some((part) => part === '..')) return null;
    } catch { return null; }
    return href;
};
const linkAttributes = (value) => {
    const href = safeHref(value);
    if (!href) return null;
    const external = /^https?:\/\//i.test(href);
    return `href='${esc(href)}'${external ? " target='_blank'" : ''} rel='noopener noreferrer'`;
};
const renderLink = (value, label, className = '') => {
    const attrs = linkAttributes(value);
    return attrs ? `<a ${attrs}${className ? ` class='${className}'` : ''}>${esc(label)}</a>` : esc(label);
};
const ID_PATTERN = /^[A-Za-z0-9 _\-:.]+$/;
const assumptionAnchor = (id) => `assumption-${String(id ?? '').replace(/[^A-Za-z0-9_.:-]/g, '-')}`;

/** Canonical STRIDE order (S,T,R,I,D,E) so the report always lists categories consistently. */
const STRIDE_ORDER = ['S', 'T', 'R', 'I', 'D', 'E'];
const sortStride = (letters) => [...(letters || [])].sort((a, b) => {
    const ra = STRIDE_ORDER.indexOf(a);
    const rb = STRIDE_ORDER.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
});
const SZ = { 'external-entity': [150, 60], process: [120, 80], multiprocess: [120, 80], store: [140, 60] };

function wrapSvgText(value, maxChars) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean).flatMap((word) => {
        const parts = [];
        for (let i = 0; i < word.length; i += maxChars) parts.push(word.slice(i, i + maxChars));
        return parts;
    });
    const lines = [];
    for (const word of words) {
        const current = lines[lines.length - 1];
        if (current && `${current} ${word}`.length <= maxChars) lines[lines.length - 1] = `${current} ${word}`;
        else lines.push(word);
    }
    return lines.length ? lines : [''];
}

function svgTextLines(lines, x, centerY, lineHeight, attrs = '') {
    const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
    return `<text x='${x}' y='${firstY}' ${attrs}>${lines.map((line, index) => `<tspan x='${x}' dy='${index ? lineHeight : 0}'>${esc(line)}</tspan>`).join('')}</text>`;
}

// --- DFD geometry helpers (mirror the client's edge routing so the report matches the editor) ---
function bboxOfBoxes(items) {
    return {
        minX: Math.min(...items.map((b) => b.x)),
        minY: Math.min(...items.map((b) => b.y)),
        maxX: Math.max(...items.map((b) => b.x + b.w)),
        maxY: Math.max(...items.map((b) => b.y + b.h)),
    };
}

/** Render one DFD layer to SVG so it matches the interactive editor: trust boundaries as dashed
 *  frames that host the external-interface chips in their header, and curved data flows that route
 *  around the shapes (never behind them) with their labels drawn on top. */
function layerSvg(dfd, parentId, system = {}) {
    const compById = new Map((system.components || []).map((c) => [c.id, c]));
    const nodes = (dfd.nodes || []).filter((n) => (n.parent ?? null) === parentId && n.type !== 'trust-boundary');
    if (!nodes.length) return '';
    const tbs = (dfd.nodes || []).filter((n) => (n.parent ?? null) === parentId && n.type === 'trust-boundary');
    const box = (n) => {
        const [w, h] = SZ[n.type] || [130, 70];
        const labelLines = wrapSvgText(n.label, 22);
        return { x: n.x || 0, y: n.y || 0, w, h: Math.max(h, labelLines.length * 12 + 18), labelLines };
    };
    const bxs = new Map(nodes.map((n) => [n.id, box(n)]));

    const targetForComponent = (compId) => {
        let c = compId;
        const seen = new Set();
        while (c && !seen.has(c)) {
            seen.add(c);
            const node = nodes.find((n) => n.componentRef === c);
            if (node) return node.id;
            c = compById.get(c)?.parent;
        }
        return null;
    };
    const ifaces = (system.interfaces || []).filter((itf) => !itf.hidden);
    const CHIP_W = 150;
    const interfaceLabelLines = new Map(ifaces.map((itf) => [itf.id, wrapSvgText(itf.name, 24)]));
    const CHIP_H = Math.max(34, ...[...interfaceLabelLines.values()].map((lines) => 20 + lines.length * 11));
    const GAP = 20;
    const CHIP_MEMBER_GAP = 74; // vertical breathing room between the chip row and the members
    const TB_PAD = 26;
    const TB_LABEL_H = 20;
    const TB_GAP = 8;

    // Group the visible interfaces by the trust boundary (or bare node) their target sits in.
    const targetOf = new Map();
    ifaces.forEach((itf) => {
        const t = targetForComponent(itf.component);
        if (t) targetOf.set(itf.id, t);
    });
    const memberTb = (tid) => tbs.find((tb) => (tb.members || []).includes(tid) && nodes.some((n) => (tb.members || []).includes(n.id)));
    const groups = {};
    ifaces.forEach((itf) => {
        if (!targetOf.has(itf.id)) return;
        const t = targetOf.get(itf.id);
        const tb = memberTb(t);
        const key = tb ? `tb:${tb.id}` : `node:${t}`;
        (groups[key] = groups[key] || []).push(itf.id);
    });

    // Size trust-boundary frames to enclose members + a header (name) + a row of interface chips.
    const frames = [];
    const chipBox = new Map();
    for (const tb of tbs) {
        const members = nodes.filter((n) => (tb.members || []).includes(n.id)).map((n) => bxs.get(n.id));
        if (!members.length) continue;
        const b = bboxOfBoxes(members);
        const chips = groups[`tb:${tb.id}`] || [];
        const chipRowW = chips.length ? chips.length * CHIP_W + (chips.length - 1) * GAP : 0;
        const innerW = Math.max(b.maxX - b.minX, chipRowW);
        const w = innerW + TB_PAD * 2;
        const topOffset = TB_LABEL_H + TB_GAP + (chips.length ? CHIP_H + CHIP_MEMBER_GAP : 0);
        const cx = (b.minX + b.maxX) / 2;
        const bx = Math.round(cx - w / 2);
        const by = Math.round(b.minY - topOffset);
        frames.push({ tb, bx, by, bw: Math.round(w), bh: Math.round(b.maxY - b.minY + topOffset + TB_PAD) });
        const startX = bx + w / 2 - chipRowW / 2;
        const chipY = by + TB_LABEL_H + TB_GAP;
        chips.forEach((id, i) => chipBox.set(id, { x: Math.round(startX + i * (CHIP_W + GAP)), y: chipY, w: CHIP_W, h: CHIP_H }));
    }
    // Interfaces whose target is not inside a boundary -> chip just above the target node.
    Object.entries(groups).forEach(([key, ids]) => {
        if (key.startsWith('tb:')) return;
        const nb = bxs.get(key.slice(5));
        const rowW = ids.length * CHIP_W + (ids.length - 1) * GAP;
        const startX = (nb ? nb.x + nb.w / 2 : 0) - rowW / 2;
        const y = (nb ? nb.y : 0) - CHIP_H - CHIP_MEMBER_GAP;
        ids.forEach((id, i) => chipBox.set(id, { x: Math.round(startX + i * (CHIP_W + GAP)), y: Math.round(y), w: CHIP_W, h: CHIP_H }));
    });

    const boxOf = (id) => bxs.get(id) || chipBox.get(id) || null;

    const allB = [...bxs.values(), ...chipBox.values(), ...frames.map((f) => ({ x: f.bx, y: f.by, w: f.bw, h: f.bh }))];
    const minX = Math.min(...allB.map((b) => b.x)) - 40;
    const minY = Math.min(...allB.map((b) => b.y)) - 30;
    const maxX = Math.max(...allB.map((b) => b.x + b.w)) + 40;
    const maxY = Math.max(...allB.map((b) => b.y + b.h)) + 30;
    const W = Math.max(160, maxX - minX);
    const H = Math.max(120, maxY - minY);
    const tx = (x) => x - minX;
    const ty = (y) => y - minY;
    const out = [];

    // Obstacles for routing = node + chip boxes (NOT trust boundaries).
    const obstacles = [...bxs.entries(), ...chipBox.entries()].map(([id, b]) => ({ id, x: b.x, y: b.y, w: b.w, h: b.h }));
    const labels = [];
    const drawLink = (fromId, toId, opts) => {
        const sB = boxOf(fromId);
        const tB = boxOf(toId);
        if (!sB || !tB) return;
        const sc = [sB.x + sB.w / 2, sB.y + sB.h / 2];
        const tc = [tB.x + tB.w / 2, tB.y + tB.h / 2];
        const s = borderPoint(sB, tc[0], tc[1]);
        const t = borderPoint(tB, sc[0], sc[1]);
        const obs = opts.noRoute ? [] : obstacles.filter((o) => o.id !== fromId && o.id !== toId);
        const route = routeAround(s[0], s[1], t[0], t[1], obs, 14);
        const directDist = Math.hypot(t[0] - s[0], t[1] - s[1]) || 1;
        let polyLen = 0;
        for (let i = 1; i < route.length; i++) polyLen += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
        let d;
        let mid;
        if (route.length > 2 && polyLen <= 2.4 * directDist) {
            d = roundedPath(route.map(([x, y]) => [tx(x), ty(y)]), 12);
            const m = labelPtOnPolyline(route);
            mid = [tx(m[0]), ty(m[1])];
        } else {
            const off = opts.offset || 0;
            const dx = t[0] - s[0];
            const dy = t[1] - s[1];
            const len = Math.hypot(dx, dy) || 1;
            const mx = (s[0] + t[0]) / 2 + (-dy / len) * off;
            const my = (s[1] + t[1]) / 2 + (dx / len) * off;
            d = `M ${tx(s[0])},${ty(s[1])} Q ${tx(mx)},${ty(my)} ${tx(t[0])},${ty(t[1])}`;
            mid = [tx(mx), ty(my)];
        }
        out.push(`<path d='${d}' fill='none' stroke='${opts.stroke}' stroke-width='${opts.width}'${opts.dash ? ` stroke-dasharray='${opts.dash}'` : ''} marker-end='url(#a)'/>`);
        if (opts.label) labels.push({ x: mid[0], y: mid[1], text: String(opts.label) });
    };

    // Trust-boundary frames (drawn first, behind everything).
    for (const { tb, bx, by, bw, bh } of frames) {
        out.push(
            `<rect x='${tx(bx)}' y='${ty(by)}' width='${bw}' height='${bh}' fill='rgba(15,157,143,0.05)' stroke='#0f9d8f' stroke-width='1.5' stroke-dasharray='6 4' rx='10'/>` +
            `<text x='${tx(bx) + 8}' y='${ty(by) + 14}' font-size='10' fill='#0f9d8f'>${esc(tb.label)}</text>`,
        );
    }
    // Data flows + derived interface connectors (behind the shapes), with lane offsets.
    const flows = (dfd.flows || []).filter((f) => boxOf(f.from) && boxOf(f.to));
    const pairKey = (a, b) => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);
    const lanes = {};
    flows.forEach((f) => (lanes[pairKey(f.from, f.to)] = lanes[pairKey(f.from, f.to)] || []).push(f.id));
    Object.values(lanes).forEach((ids) => ids.sort());
    for (const f of flows) {
        const ids = lanes[pairKey(f.from, f.to)];
        const i = ids.indexOf(f.id);
        const visualLane = (i - (ids.length - 1) / 2) * 30;
        const offset = visualLane * (f.from < f.to ? 1 : -1);
        drawLink(f.from, f.to, { stroke: '#6b7688', width: 1.5, offset, label: f.label });
    }
    // Shapes (front) — occlude any flow that passes underneath.
    for (const n of nodes) {
        const b = bxs.get(n.id);
        const x = tx(b.x);
        const y = ty(b.y);
        let shape;
        if (n.type === 'process' || n.type === 'multiprocess') shape = `<ellipse cx='${x + b.w / 2}' cy='${y + b.h / 2}' rx='${b.w / 2}' ry='${b.h / 2}' fill='#fff' stroke='#333'/>`;
        else if (n.type === 'store')
            shape =
                `<rect x='${x}' y='${y}' width='${b.w}' height='${b.h}' fill='#fff' stroke='none'/>` +
                `<line x1='${x}' y1='${y}' x2='${x + b.w}' y2='${y}' stroke='#333'/><line x1='${x}' y1='${y + b.h}' x2='${x + b.w}' y2='${y + b.h}' stroke='#333'/>`;
        else shape = `<rect x='${x}' y='${y}' width='${b.w}' height='${b.h}' fill='#fff' stroke='#333'/>`;
        out.push(shape + svgTextLines(b.labelLines, x + b.w / 2, y + b.h / 2 + 3, 12, "text-anchor='middle' font-size='10'"));
    }
    for (const itf of ifaces) {
        const b = chipBox.get(itf.id);
        if (!b) continue;
        const x = tx(b.x);
        const y = ty(b.y);
        out.push(
            `<rect x='${x}' y='${y}' width='${b.w}' height='${b.h}' rx='7' fill='#fff' stroke='#0f9d8f' stroke-width='1.3'/>` +
            `<text x='${x + 8}' y='${y + 14}' font-size='9' font-weight='700' fill='#0f9d8f'>${esc(itf.tag || itf.protocol || 'interface')}</text>` +
            svgTextLines(interfaceLabelLines.get(itf.id), x + 8, y + 25 + ((interfaceLabelLines.get(itf.id).length - 1) * 11) / 2, 11, "font-size='9.5'"),
        );
    }
    // Flow labels on top so a shape never hides them.
    const placedLabelBoxes = [];
    for (const l of labels) {
        const lines = wrapSvgText(l.text, 28);
        const w = Math.max(42, Math.min(180, Math.max(...lines.map((line) => line.length)) * 5.4 + 12));
        const h = lines.length * 11 + 6;
        let y = l.y;
        let attempt = 0;
        const overlaps = (box) => placedLabelBoxes.some((placed) => box.x < placed.x + placed.w && box.x + box.w > placed.x && box.y < placed.y + placed.h && box.y + box.h > placed.y);
        while (overlaps({ x: l.x - w / 2, y: y - h / 2, w, h }) && attempt < 20) {
            attempt += 1;
            y = l.y + Math.ceil(attempt / 2) * (h + 4) * (attempt % 2 ? 1 : -1);
        }
        placedLabelBoxes.push({ x: l.x - w / 2, y: y - h / 2, w, h });
        out.push(
            `<rect x='${l.x - w / 2}' y='${y - h / 2}' width='${w}' height='${h}' rx='3' fill='#ffffff' fill-opacity='0.9' stroke='#e2e5ea'/>` +
            svgTextLines(lines, l.x, y + 3, 11, "text-anchor='middle' font-size='9' fill='#1d2430'"),
        );
    }
    return `<svg width='${Math.min(W, 900)}' height='${Math.min(H, 620)}' viewBox='0 0 ${W} ${H}' xmlns='http://www.w3.org/2000/svg'><defs><marker id='a' markerWidth='8' markerHeight='8' refX='7' refY='3' orient='auto'><path d='M0,0L7,3L0,6' fill='#6b7688'/></marker></defs>${out.join('')}</svg>`;
}

function useCaseSvg(diagram = {}) {
    const entities = Array.isArray(diagram.entities) ? diagram.entities : [];
    const groups = Array.isArray(diagram.groups) ? diagram.groups : [];
    const conns = Array.isArray(diagram.connections) ? diagram.connections : [];
    if (!entities.length) return '<p>No entities in this diagram.</p>';

    const ACTOR_W = 80;
    const ACTOR_H = 120;
    const ACTION_W = 180;
    const ACTION_H = 70;
    const boxOf = (e, idx) => {
        const x = Number.isFinite(e?.x) ? e.x : 80 + (idx % 4) * 220;
        const y = Number.isFinite(e?.y) ? e.y : 80 + Math.floor(idx / 4) * 180;
        if (e.kind === 'actor' || e.kind === 'misuse-actor') return { x, y, w: ACTOR_W, h: ACTOR_H };
        return { x, y, w: ACTION_W, h: ACTION_H };
    };
    const byId = new Map(entities.map((e, i) => [e.id, { e, b: boxOf(e, i) }]));

    const groupSvgs = groups
        .map((g) => {
            const memberBoxes = (g.members || []).map((id) => byId.get(id)?.b).filter(Boolean);
            if (!memberBoxes.length) return '';
            const minX = Math.min(...memberBoxes.map((b) => b.x)) - 30;
            const minY = Math.min(...memberBoxes.map((b) => b.y)) - 45;
            const maxX = Math.max(...memberBoxes.map((b) => b.x + b.w)) + 30;
            const maxY = Math.max(...memberBoxes.map((b) => b.y + b.h)) + 24;
            return (
                `<rect x='${minX}' y='${minY}' width='${maxX - minX}' height='${maxY - minY}' fill='none' stroke='#4d5a6d' stroke-width='1.4' rx='8'/>` +
                `<text x='${minX + 10}' y='${minY + 16}' font-size='11' fill='#2a3342'>${esc(g.name || g.id)}</text>`
            );
        })
        .join('');

    const defs =
        '<defs>' +
        "<marker id='uc-arrow' markerWidth='8' markerHeight='8' refX='7' refY='3' orient='auto'><path d='M0,0L7,3L0,6' fill='#5e6a7b'/></marker>" +
        '</defs>';

    const connSvgs = conns
        .map((c) => {
            const from = byId.get(c.from)?.b;
            const to = byId.get(c.to)?.b;
            if (!from || !to) return '';
            const x1 = from.x + from.w / 2;
            const y1 = from.y + from.h / 2;
            const x2 = to.x + to.w / 2;
            const y2 = to.y + to.h / 2;
            const dashed = c.dashed ? " stroke-dasharray='6 4'" : '';
            const arrow = c.arrow || 'none';
            const start = arrow === 'backward' || arrow === 'both' ? " marker-start='url(#uc-arrow)'" : '';
            const end = arrow === 'forward' || arrow === 'both' ? " marker-end='url(#uc-arrow)'" : '';
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2;
            const label = c.label
                ? `<rect x='${mx - 70}' y='${my - 18}' width='140' height='14' rx='3' fill='#fff' stroke='#d9dee7'/><text x='${mx}' y='${my - 8}' text-anchor='middle' font-size='10'>${esc(c.label)}</text>`
                : '';
            return `<line x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}' stroke='#5e6a7b' stroke-width='1.6'${dashed}${start}${end}/>${label}`;
        })
        .join('');

    const entitySvgs = entities
        .map((e, i) => {
            const b = boxOf(e, i);
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            if (e.kind === 'actor' || e.kind === 'misuse-actor') {
                const dark = e.kind === 'misuse-actor';
                const stroke = dark ? '#111' : '#2f3a4a';
                const fill = dark ? '#111' : 'none';
                const textFill = dark ? '#fff' : '#1d2430';
                return (
                    `<circle cx='${cx}' cy='${b.y + 16}' r='10' fill='${fill}' stroke='${stroke}' stroke-width='1.8'/>` +
                    `<line x1='${cx}' y1='${b.y + 26}' x2='${cx}' y2='${b.y + 64}' stroke='${stroke}' stroke-width='1.8'/>` +
                    `<line x1='${cx - 18}' y1='${b.y + 40}' x2='${cx + 18}' y2='${b.y + 40}' stroke='${stroke}' stroke-width='1.8'/>` +
                    `<line x1='${cx}' y1='${b.y + 64}' x2='${cx - 14}' y2='${b.y + 92}' stroke='${stroke}' stroke-width='1.8'/>` +
                    `<line x1='${cx}' y1='${b.y + 64}' x2='${cx + 14}' y2='${b.y + 92}' stroke='${stroke}' stroke-width='1.8'/>` +
                    `<text x='${cx}' y='${b.y + 110}' text-anchor='middle' font-size='10.5' fill='${textFill}'>${esc(e.name || e.id)}</text>`
                );
            }
            const dark = e.kind === 'misuse-action';
            return (
                `<ellipse cx='${cx}' cy='${cy}' rx='${b.w / 2}' ry='${b.h / 2}' fill='${dark ? '#111' : '#fff'}' stroke='${dark ? '#111' : '#2f3a4a'}' stroke-width='1.6'/>` +
                `<text x='${cx}' y='${cy + 4}' text-anchor='middle' font-size='10.5' fill='${dark ? '#fff' : '#1d2430'}'>${esc(e.name || e.id)}</text>`
            );
        })
        .join('');

    const all = [...entities.map((e, i) => boxOf(e, i))];
    const minX = Math.min(...all.map((b) => b.x)) - 60;
    const minY = Math.min(...all.map((b) => b.y)) - 60;
    const maxX = Math.max(...all.map((b) => b.x + b.w)) + 60;
    const maxY = Math.max(...all.map((b) => b.y + b.h)) + 60;
    const w = Math.max(400, maxX - minX);
    const h = Math.max(260, maxY - minY);

    return `<svg width='${Math.min(980, w)}' height='${Math.min(700, h)}' viewBox='${minX} ${minY} ${w} ${h}' xmlns='http://www.w3.org/2000/svg'>${defs}${groupSvgs}${connSvgs}${entitySvgs}</svg>`;
}

/** The traceability chain, one row per threat — reused by the HTML matrix and CSV/JSON exports. */
export function buildTraceability({ system, threats, requirements, countermeasures, scheme }) {
    const assetById = new Map((system.assets || []).map((a) => [a.id, a]));
    return (threats || []).map((t) => {
        const computedRisk = scheme ? computeRisk(scheme, [t], countermeasures)[0] : null;
        const [rl, ri] = computedRisk
            ? [computedRisk.residualLikelihood, computedRisk.residualImpact]
            : residual(t, countermeasures);
        const rqs = (requirements || []).filter((r) => (r.derivedFromThreat || []).includes(t.id));
        const ctrls = (countermeasures || []).filter((c) => c.selected !== false && (c.addresses || []).some((a) => a.threat === t.id));
        const initial = computedRisk?.initial ?? null;
        const res = computedRisk?.residual ?? null;
        return {
            asset: (t.assets || []).map((a) => assetById.get(a)?.name || a).join('; '),
            cias: (t.assets || [])
                .map((a) => {
                    const o = assetById.get(a)?.objectives || {};
                    return `C${o.confidentiality ?? '-'}/I${o.integrity ?? '-'}/A${o.availability ?? '-'}/S${o.safety ?? '-'}`;
                })
                .join('; '),
            threat: t.id,
            title: t.title,
            stride: sortStride(t.stride).join(''),
            assumptionRefs: t.assumptionRefs || [],
            likelihoodRationale: t.likelihoodRationale || '',
            impactRationale: t.impactRationale || '',
            initial,
            initialBand: computedRisk?.initialBand.name || 'Unavailable',
            initialColor: computedRisk?.initialBand.color || null,
            requirement: rqs.map((r) => `${r.id}${r.standardRef ? ` [${r.standardRef}]` : ''}${(r.satisfiedByCM || []).length ? ` → ${(r.satisfiedByCM || []).join('+')}` : ''}`).join('; '),
            control: ctrls.map((c) => `${c.id} (${c.status || '?'})`).join('; '),
            residual: res,
            residualBand: computedRisk?.residualBand.name || 'Unavailable',
            residualColor: computedRisk?.residualBand.color || null,
            evidence: ctrls
                .flatMap((c) => [...(c.ticketUrls || []), c.ticketUrl, c.verificationUrl])
                .filter(Boolean)
                .join(' '),
            status: t.status || '',
            ratedBy: t.ratedBy || '',
            signoff: t.status === 'accepted' ? [t.acceptedBy && `by ${t.acceptedBy}`, t.reviewDate && `review ${t.reviewDate}`, t.acceptanceRationale].filter(Boolean).join(' · ') : '',
            ...(!computedRisk ? {
                likelihood: t.likelihood ?? null,
                impact: t.impact ?? null,
                residualLikelihood: rl,
                residualImpact: ri,
            } : {}),
            classification: t.classification || '',
            responsibility: t.responsibility || '',
            deploymentConstraints: t.deploymentConstraints || '',
        };
    });
}

/** CycloneDX SBOM (+ VEX vulnerabilities from the defect register) from the component list. */
export function buildSbom({ project, system, defects = [] }) {
    const comps = (system.components || []).filter((c) => c.kind !== 'external-entity');
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: {
            timestamp: new Date().toISOString(),
            component: { type: 'device', name: project.device?.name || project.title || 'device', version: project.device?.version || '' },
        },
        components: comps.map((c) => ({
            'bom-ref': c.id,
            type: c.kind === 'hardware' ? 'device' : 'application',
            name: c.name,
            version: c.version || '',
            ...(c.supplier ? { supplier: { name: c.supplier } } : {}),
            ...(c.license ? { licenses: [{ license: { id: c.license } }] } : {}),
            ...(c.cpe && c.cpe.startsWith('cpe:') ? { cpe: c.cpe } : {}),
            ...(c.cpe && c.cpe.startsWith('pkg:') ? { purl: c.cpe } : {}),
            properties: [{ name: 'tra:provenance', value: c.provenance || 'unspecified' }],
        })),
        vulnerabilities: (defects || [])
            .filter((d) => d.cve || d.id)
            .map((d) => ({
                id: d.cve || d.id,
                ...(d.component ? { affects: [{ ref: d.component }] } : {}),
                ...(d.severity ? { ratings: [{ severity: d.severity }] } : {}),
                analysis: { state: d.status === 'fixed' ? 'resolved' : d.status === 'wont-fix' ? 'not_affected' : 'exploitable' },
                description: d.title || '',
            })),
    };
}

/** SPDX 2.3 SBOM (JSON) generated from the component list — the alternative to CycloneDX. */
export function buildSpdx({ project, system }) {
    const comps = (system.components || []).filter((c) => c.kind !== 'external-entity');
    const sid = (id) => 'SPDXRef-Package-' + String(id).replace(/[^A-Za-z0-9.\-]/g, '-');
    const created = new Date().toISOString();
    const name = (project.device?.name || project.title || 'device').replace(/[^A-Za-z0-9.\-]/g, '-');
    return {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        SPDXID: 'SPDXRef-DOCUMENT',
        name: `${name}-sbom`,
        documentNamespace: `https://spdx.org/spdxdocs/${name}-${created}`,
        creationInfo: { created, creators: ['Tool: tra-webapp'] },
        packages: comps.map((c) => {
            const externalRefs = [];
            if (c.cpe && c.cpe.startsWith('cpe:')) externalRefs.push({ referenceCategory: 'SECURITY', referenceType: 'cpe23Type', referenceLocator: c.cpe });
            if (c.cpe && c.cpe.startsWith('pkg:')) externalRefs.push({ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.cpe });
            return {
                SPDXID: sid(c.id),
                name: c.name,
                versionInfo: c.version || 'NOASSERTION',
                supplier: c.supplier ? `Organization: ${c.supplier}` : 'NOASSERTION',
                downloadLocation: 'NOASSERTION',
                licenseConcluded: c.license || 'NOASSERTION',
                licenseDeclared: c.license || 'NOASSERTION',
                copyrightText: 'NOASSERTION',
                ...(externalRefs.length ? { externalRefs } : {}),
            };
        }),
        relationships: comps.map((c) => ({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: sid(c.id) })),
    };
}

/** STRIDE-per-element coverage: for each modellable component/interface, which STRIDE letters are
 * covered by at least one threat. Empty cells are candidate gaps (Shostack STRIDE-per-element). */
export function buildStrideCoverage(system, threats) {
    const S = ['S', 'T', 'R', 'I', 'D', 'E'];
    const elems = [
        ...(system.components || []).filter((c) => c.kind !== 'external-entity' && c.kind !== 'device').map((c) => ({ id: c.id, name: c.name, kind: 'component' })),
        ...(system.interfaces || []).map((i) => ({ id: i.id, name: i.name, kind: 'interface' })),
    ];
    return elems.map((e) => {
        const rel = (threats || []).filter((t) => (t.components || []).includes(e.id) || (t.interfaceRefs || []).includes(e.id) || t.interfaceRef === e.id);
        const covered = new Set(rel.flatMap((t) => t.stride || []));
        return { ...e, cells: S.map((s) => covered.has(s)), gaps: S.filter((s) => !covered.has(s)).length === S.length };
    });
}

const STRIDE_LABELS = { S: 'Spoofing', T: 'Tampering', R: 'Repudiation', I: 'Information disclosure', D: 'Denial of service', E: 'Elevation of privilege' };

/** The distinct pairs of entities that communicate across a boundary, derived from the DFD node
 *  hierarchy — NOT from flow.crossesBoundary (stale/unreliable). A flow crosses the boundary when
 *  exactly one of its endpoints is in the DFD member set (or a nested descendant). */
export function boundaryPairs(system = {}, dfd = {}, tbId) {
    const tbDfdNode = (dfd.nodes || []).find((n) => n.id === tbId && n.type === 'trust-boundary');
    if (!tbDfdNode) return [];
    const insideNodeIds = new Set(tbDfdNode.members || []);
    let changed = true;
    while (changed) {
        changed = false;
        for (const n of dfd.nodes || []) {
            if (n.parent && insideNodeIds.has(n.parent) && !insideNodeIds.has(n.id)) {
                insideNodeIds.add(n.id);
                changed = true;
            }
        }
    }
    const nodeById = new Map((dfd.nodes || []).map((n) => [n.id, n]));
    const ifaceById = new Map((system.interfaces || []).map((i) => [i.id, i]));
    const dfdNodeForComp = (compId) => (dfd.nodes || []).find((n) => n.componentRef === compId);
    const isInsideEndpoint = (ep) => {
        if (insideNodeIds.has(ep)) return true;
        const iface = ifaceById.get(ep);
        if (iface?.component) {
            const compNode = dfdNodeForComp(iface.component);
            if (compNode && insideNodeIds.has(compNode.id)) return true;
        }
        return false;
    };
    const endpointLabel = (ep) => nodeById.get(ep)?.label ?? ifaceById.get(ep)?.name ?? ep;
    const seen = new Map();
    for (const f of dfd.flows || []) {
        if (!f.from || !f.to) continue;
        const fromIn = isInsideEndpoint(f.from);
        const toIn = isInsideEndpoint(f.to);
        if (fromIn === toIn) continue;
        const key = [f.from, f.to].sort().join('~');
        if (seen.has(key)) continue;
        const [insideEp, outsideEp] = fromIn ? [f.from, f.to] : [f.to, f.from];
        seen.set(key, { key, inside: { id: insideEp, label: endpointLabel(insideEp) }, outside: { id: outsideEp, label: endpointLabel(outsideEp) } });
    }
    return [...seen.values()];
}

const cellHasContent = (cell) => !!cell && ((cell.strengths || []).some((x) => x && x.trim()) || (cell.weaknesses || []).some((x) => x && x.trim()));
// Analysis is stored flat by pair key; an entry has content when any endpoint cell has text.
const analysisHasContent = (a) => !!a?.endpoints && Object.values(a.endpoints).some((side) => side && Object.values(side.cells || {}).some(cellHasContent));

/** Render one strengths/weaknesses list into HTML (or an em-dash placeholder when empty). */
const swList = (items) => {
    const list = (items || []).map((x) => String(x || '').trim()).filter(Boolean);
    return list.length ? `<ul style='margin:0;padding-left:16px'>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span style="color:#8a93a2">—</span>';
};

/** The per-trust-boundary STRIDE strengths/weaknesses tables — one per communicating entity pair.
 *  Analysis is stored flat by pair key (shared across boundaries), so the inside/outside role is
 *  determined by the boundary being rendered, not by how the data was authored. */
function strideBoundaryTablesHtml(system = {}, dfd = {}) {
    const analyses = system.strideAnalyses || {}; // flat: pairKey -> StridePairAnalysis
    const sections = (system.trustBoundaries || [])
        .map((b) => {
            const tables = boundaryPairs(system, dfd, b.id)
                .filter((pair) => analysisHasContent(analyses[pair.key]))
                .map((pair) => {
                    const a = analyses[pair.key] || {};
                    // inside/outside determined by this boundary's perspective, not the storage order
                    const aLabel = a.endpoints?.[pair.inside.id]?.label || pair.inside.label;
                    const bLabel = a.endpoints?.[pair.outside.id]?.label || pair.outside.label;
                    const aCells = (k) => a.endpoints?.[pair.inside.id]?.cells?.[k] || {};
                    const bCells = (k) => a.endpoints?.[pair.outside.id]?.cells?.[k] || {};
                    const rows = STRIDE_ORDER.map((s) => (
                        `<tr><th style='white-space:nowrap'>${esc(s)} · ${esc(STRIDE_LABELS[s] || '')}</th>` +
                        `<td>${swList(aCells(s).strengths)}</td><td>${swList(aCells(s).weaknesses)}</td>` +
                        `<td>${swList(bCells(s).strengths)}</td><td>${swList(bCells(s).weaknesses)}</td></tr>`
                    )).join('');
                    return (
                        `<h4>${esc(pair.inside.label)} ⇄ ${esc(pair.outside.label)}</h4>` +
                        `<table><caption>STRIDE strengths and weaknesses for ${esc(b.name)}: ${esc(pair.inside.label)} and ${esc(pair.outside.label)}</caption><thead><tr><th scope='col' rowspan='2'>STRIDE</th><th scope='col' colspan='2'>${esc(aLabel)}</th><th scope='col' colspan='2'>${esc(bLabel)}</th></tr>` +
                        `<tr><th scope='col'>Strengths</th><th scope='col'>Weaknesses</th><th scope='col'>Strengths</th><th scope='col'>Weaknesses</th></tr></thead><tbody>${rows}</tbody></table>`
                    );
                });
            return tables.length ? `<h3>${esc(b.id)} · ${esc(b.name)}</h3>${tables.join('')}` : '';
        })
        .filter(Boolean);
    return sections.length ? `<h2>STRIDE analysis per trust boundary</h2>${sections.join('')}` : '';
}

const csvCell = (s) => {
    const value = String(s ?? '');
    const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${neutralized.replace(/"/g, '""')}"`;
};
function traceabilityCsv(rows) {
    const head = ['Asset', 'C/I/A/S', 'Threat', 'Title', 'STRIDE', 'Assumptions', 'Rationale', 'Initial', 'InitialBand', 'Requirement', 'Control', 'Residual', 'ResidualBand', 'Evidence', 'Status', 'RatedBy', 'SignOff', 'Classification', 'Responsibility', 'DeploymentConstraints'];
    const body = rows.map((r) =>
        [
            r.asset,
            r.cias,
            r.threat,
            r.title,
            r.stride,
            (r.assumptionRefs || []).join('; '),
            [r.likelihoodRationale && `L: ${r.likelihoodRationale}`, r.impactRationale && `I: ${r.impactRationale}`].filter(Boolean).join(' | '),
            r.initial,
            r.initialBand,
            r.requirement,
            r.control,
            r.residual,
            r.residualBand,
            r.evidence,
            r.status,
            r.ratedBy,
            r.signoff,
            r.classification,
            r.responsibility,
            r.deploymentConstraints,
        ]
            .map(csvCell)
            .join(','),
    );
    return [head.map(csvCell).join(','), ...body].join('\r\n') + '\r\n';
}

/** Assemble every report artifact for a project (in memory). */
export async function buildReport(id) {
    const p = await readProject(id);
    const { project, assumptions, system, dfd, useCases, threats: td, requirements: rd, countermeasures: cd, attackTrees, defects: dd } = p;
    const schemeResolution = await resolveProjectScheme(project);
    const scheme = schemeResolution.scheme;
    const reportRiskEngine = scheme ? globalThis.RiskEngine.createRiskEngine(scheme, project) : null;
    const threats = td.threats || [];
    const reqs = rd.requirements || [];
    const cms = cd.countermeasures || [];
    const defects = dd.defects || [];
    const issues = validate({ project, assumptions, system, threats: td, requirements: rd, countermeasures: cd, dfd, useCases, attackTrees, defects: dd, riskScheme: scheme, riskSchemeWarning: schemeResolution.warning });
    const trace = buildTraceability({ system, threats, requirements: reqs, countermeasures: cms, scheme });
    const lookupScheme = scheme?.classification?.kind === 'lookup';
    const assumptionsFlat = [
        ...(assumptions.device || []).map((a) => ({ id: a.id, text: a.text || '', source: 'Device' })),
        ...(assumptions.system || []).map((a) => ({ id: a.id, text: a.text || '', source: 'System' })),
        ...(assumptions.environment || []).map((a) => ({ id: a.id, text: a.text || '', source: 'Environment' })),
        ...(assumptions.operational || []).map((a) => ({ id: a.id, text: a.text || '', source: 'Operational' })),
        ...(assumptions.attacker || []).map((a) => ({ id: a.id, text: a.text || a.name || '', source: 'Attacker' })),
    ].filter((a) => a.id);
    const assumptionById = new Map(assumptionsFlat.map((a) => [a.id, a]));
    const assumptionCitedBy = new Map();
    for (const t of threats) {
        for (const aid of t.assumptionRefs || []) {
            const list = assumptionCitedBy.get(aid) || [];
            list.push(t.id);
            assumptionCitedBy.set(aid, list);
        }
    }
    const sbom = buildSbom({ project, system, defects });
    const sbomMode = project.sbom?.mode || 'in-tool';
    const sbomFormat = project.sbom?.format || 'cyclonedx';
    const sbomFile = sbomMode !== 'in-tool' ? project.sbom?.url || '(external, no URL)' : sbomFormat === 'spdx' ? 'report/sbom.spdx.json' : 'report/sbom.cdx.json';
    const riskSchemeSection = reportRiskEngine
        ? (() => {
            const likelihoods = reportRiskEngine.likelihoodLevels();
            const impacts = reportRiskEngine.impactLevels().slice().reverse();
            const matrixRows = impacts.map((impact) => {
                const cells = likelihoods.map((likelihood) => {
                    const level = reportRiskEngine.classify(likelihood.value, impact.value);
                    const score = likelihood.value * impact.value;
                    const label = scheme.classification.kind === 'lookup' ? level.label : score;
                    return `<td style='background:${esc(level.color)};color:${contrastTextColor(level.color)}' title='${esc(likelihood.code)} × ${esc(impact.code)} · ${esc(level.label)}'>${esc(label)}</td>`;
                }).join('');
                return `<tr><th>${esc(impact.code)} · ${esc(impact.label)}</th>${cells}</tr>`;
            }).join('');
            const legend = scheme.classification.levels.map((level) =>
                `<span style='display:inline-flex;align-items:center;gap:4px;margin-right:10px'><i style='display:inline-block;width:10px;height:10px;background:${esc(level.color)}'></i>${esc(level.label)}</span>`
            ).join('');
            const headers = likelihoods.map((level) => `<th>${esc(level.code)}</th>`).join('');
            return `<h2>Risk scheme</h2><p><b>${esc(scheme.title)}</b> · v${esc(scheme.version)} · fingerprint <code>${schemeResolution.fingerprint}</code></p><div>${legend}</div><table><caption>Active risk matrix</caption><thead><tr><th scope='col'>Impact / Likelihood</th>${headers.replace(/<th>/g, "<th scope='col'>")}</tr></thead><tbody>${matrixRows}</tbody></table>`;
        })()
        : '';
    const strideCov = buildStrideCoverage(system, threats);
    const strideTbSection = project.reportOptions?.includeStrideBoundaryAnalysis ? strideBoundaryTablesHtml(system, dfd) : '';
    const acceptedNotices = new Set(project.acceptedNotices || []);
        const withinAcceptanceCriteria = (threat) => {
            if (!reportRiskEngine) return false;
            const [likelihood, impact] = residual(threat, cms);
            const level = reportRiskEngine.classify(likelihood, impact);
            if (level.id === 'none') return false;
            if (level.treatment === 'auto-accept') return true;
            const acceptableLevel = project.acceptableLevel || scheme.acceptance?.defaultLevel;
            const acceptableRank = acceptableLevel ? scheme.classification.levels.find((item) => item.id === acceptableLevel)?.rank : null;
            return Number.isInteger(acceptableRank)
                ? level.rank <= acceptableRank
                : level.score <= (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12);
        };

    const openIssueList = issues.filter((i) => !(i.severity === 'notice' && acceptedNotices.has(i.key)));
    const acceptedIssueList = issues.filter((i) => i.severity === 'notice' && acceptedNotices.has(i.key));
    const kbv = await kbVersion().catch(() => null);

    const parents = [null, ...dfd.nodes.filter((n) => dfd.nodes.some((m) => m.parent === n.id)).map((n) => n.id)];
    const dfdHtml =
        parents
            .map((pid) => {
                const svg = layerSvg(dfd, pid, system);
                if (!svg) return '';
                const label = pid ? dfd.nodes.find((n) => n.id === pid)?.label || pid : 'Layer 1 — device context';
                return `<h3>${esc(label)}</h3>${svg}`;
            })
            .filter(Boolean)
            .join('') || '<p>No DFD nodes.</p>';

    const traceRows = trace
        .map((r) => {
            const assumptionRefs = (r.assumptionRefs || [])
                .map((aid) => {
                    if (!ID_PATTERN.test(aid)) return `<span class='mono'>${esc(aid)}</span> (invalid ID)`;
                    const row = assumptionById.get(aid);
                    if (!row) return `<span class='mono'>${esc(aid)}</span> (missing)`;
                    return `${renderLink(`#${assumptionAnchor(aid)}`, aid, 'mono')} <span style='color:#4d5a6d'>(${esc(row.source)})</span>`;
                })
                .join(', ');
            const rationale = [
                r.likelihoodRationale ? `L: ${esc(r.likelihoodRationale)}` : '',
                r.impactRationale ? `I: ${esc(r.impactRationale)}` : '',
            ]
                .filter(Boolean)
                .join('<br>');
            const support = [
                assumptionRefs ? `<div style='margin-top:3px'><span class='mono'>Assumptions:</span> ${assumptionRefs}</div>` : '',
                rationale ? `<div style='margin-top:3px;color:#4d5a6d'>${rationale}</div>` : '',
            ]
                .filter(Boolean)
                .join('');
            const threat = threats.find((item) => item.id === r.threat);
            const acceptanceSetting = project.acceptableLevel || scheme?.acceptance?.defaultLevel || (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12);
            const acceptanceStatement = threat && withinAcceptanceCriteria(threat)
                ? `<br><span class='mono'>Within acceptance criteria (scheme ${esc(scheme.id)} v${esc(scheme.version)}, level ${esc(r.residualBand)}, acceptable ${esc(acceptanceSetting)}).</span>`
                : '';
            return (
                `<tr id='threat-${esc(r.threat)}'><td>${esc(r.asset)}</td><td>${esc(r.cias)}</td><td><b>${esc(r.threat)}</b> ${esc(r.title)} <span class=mono>${esc(r.stride)}</span></td>` +
                `<td${r.initialColor ? ` style='color:${esc(r.initialColor)}'` : ''}>${r.initial === null ? `L${esc(r.likelihood ?? '—')} / I${esc(r.impact ?? '—')} (${esc(r.initialBand)})` : lookupScheme ? esc(r.initialBand) : `${r.initial} ${esc(r.initialBand)}`}</td><td>${esc(r.requirement) || '—'}</td>` +
                `<td>${esc(r.control) || '—'}</td><td${r.residualColor ? ` style='color:${esc(r.residualColor)}'` : ''}>${r.residual === null ? `L${esc(r.residualLikelihood ?? '—')} / I${esc(r.residualImpact ?? '—')} (${esc(r.residualBand)})` : lookupScheme ? esc(r.residualBand) : `${r.residual} ${esc(r.residualBand)}`}</td>` +
                `<td>${r.evidence ? r.evidence.split(' ').map((u) => renderLink(u, 'link')).join(' ') : '—'}${support}</td><td>${esc(r.status)}${r.signoff ? `<br><span class=mono style='font-size:11px'>${esc(r.signoff)}</span>` : ''}${r.ratedBy ? `<br><span class=mono style='font-size:11px'>rated: ${esc(r.ratedBy)}</span>` : ''}</td>` +
                `<td>${r.evidence ? r.evidence.split(' ').map((u) => renderLink(u, 'link')).join(' ') : '—'}${support}</td><td>${esc(r.status)}${r.signoff ? `<br><span class=mono style='font-size:11px'>${esc(r.signoff)}</span>` : ''}${r.ratedBy ? `<br><span class=mono style='font-size:11px'>rated: ${esc(r.ratedBy)}</span>` : ''}${acceptanceStatement}</td>` +
                `<td>${esc(r.classification) || '—'}</td><td>${esc(r.responsibility) || '—'}</td><td>${esc(r.deploymentConstraints) || '—'}</td></tr>`
            );
        })
        .join('');

    const assumptionSection = ['device', 'system', 'environment', 'operational']
        .map((k) => {
            const items = assumptions[k] || [];
            if (!items.length) return '';
            return `<h3>${k[0].toUpperCase() + k.slice(1)} assumptions</h3><ul>${items
                .map((a) => {
                    const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => renderLink(`#threat-${tid}`, tid, 'mono')).join(', ');
                    return `<li id='${esc(assumptionAnchor(a.id))}'><span class='mono'><b>${esc(a.id)}</b></span> — ${esc(a.text || a)}${cited ? `<br><span style='font-size:11px;color:#4d5a6d'>cited by: ${cited}</span>` : ''}</li>`;
                })
                .join('')}</ul>`;
        })
        .join('');
    const atk = (assumptions.attacker || [])
        .map((a) => {
            const cited = (assumptionCitedBy.get(a.id) || []).map((tid) => renderLink(`#threat-${tid}`, tid, 'mono')).join(', ');
            return `<li id='${esc(assumptionAnchor(a.id))}'><span class='mono'><b>${esc(a.id)}</b></span> · <b>${esc(a.name)}</b> (capability ${normalizeActorLevel(a.capability)} · ${esc(actorLevelLabel(a.capability))}, ${esc(a.access)}): ${esc(a.text || '')}${cited ? `<br><span style='font-size:11px;color:#4d5a6d'>cited by: ${cited}</span>` : ''}</li>`;
        })
        .join('');
    const assets = (system.assets || [])
        .map((a) => `<li>${esc(a.name)} (C${a.objectives?.confidentiality}/I${a.objectives?.integrity}/A${a.objectives?.availability}/S${a.objectives?.safety})${a.storage ? ` — <i>${esc(a.storage)}</i>` : ''}</li>`)
        .join('');
    const ifaceList = (system.interfaces || [])
        .map((i) => `<li><b>${esc(i.name)}</b> ${esc(i.protocol || '')} · ${esc(i.exposure)}${i.category ? ` · ${esc(i.category)}` : ''}</li>`)
        .join('');
    const ucDiagrams = Array.isArray(useCases?.diagrams) ? useCases.diagrams : [];
    const useCaseSection = project.reportOptions?.includeUseCases
        ? ucDiagrams.length
            ? `<h2>Scenarios & diagrams</h2>${ucDiagrams
                .map((d) => `<h3>${esc(d.name || d.id)}</h3>${d.kind === 'independent-dfd' ? (layerSvg(d.dfd || {}, null, {}) || '<p>No components in this diagram.</p>') : useCaseSvg(d)}`)
                .join('')}`
            : ''
        : '';
    const reqRows = reqs
        .map(
            (r) =>
                `<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.text)}</td><td>${esc(r.standardRef || '')}${r.slFr ? ` · ${esc(r.slFr)}` : ''}</td><td>${esc((r.derivedFromThreat || []).join(', '))}</td><td>${esc((r.satisfiedByCM || []).join(', '))}</td></tr>`,
        )
        .join('');
    const cmrows = cms
        .filter((c) => c.selected !== false)
        .map(
            (c) =>
                `<li><b>${esc(c.id)}</b> ${esc(c.title)} <i>(${esc(c.type || '')}, ${esc(c.status || '')})</i> &rarr; ${esc((c.addresses || []).map((a) => a.threat).join(', '))}${[...(c.ticketUrls || []), c.ticketUrl].filter(Boolean).map((u, i) => ` · ${renderLink(u, `ticket ${i + 1}`)}`).join('')}${c.verificationUrl ? ` · ${renderLink(c.verificationUrl, 'verification')}` : ''}${(c.negativeEffects || []).filter(Boolean).length ? `<br><span style='color:#8a6d3b;font-size:11px'>Trade-offs: ${esc((c.negativeEffects || []).filter(Boolean).join('; '))}</span>` : ''}</li>`,
        )
        .join('');
    const sbomRows = sbom.components
        .map(
            (c) =>
                `<tr><td>${esc(c.name)}</td><td>${esc(c.version)}</td><td>${esc(c.supplier?.name || '')}</td><td>${esc(c.licenses?.[0]?.license?.id || '')}</td><td class=mono>${esc(c.cpe || c.purl || '')}</td><td>${esc(c.properties?.[0]?.value || '')}</td></tr>`,
        )
        .join('');
    const treeList = (attackTrees?.trees || [])
        .map((t) => {
            const refs = [...new Set([...(t.threatRefs || []), ...(t.threatRef ? [t.threatRef] : [])])];
            return `<li><b>${esc(t.id)}</b> ${esc(t.title)}${refs.length ? ` &rarr; ${esc(refs.join(', '))}` : ''}</li>`;
        })
        .join('');
    const strideRows = strideCov
        .map((e) => `<tr${e.gaps ? " style='background:#fff7f0'" : ''}><td>${esc(e.id)} ${esc(e.name)} <span class=mono>${esc(e.kind)}</span></td>${e.cells.map((c) => `<td style='text-align:center'>${c ? '✓' : '·'}</td>`).join('')}</tr>`)
        .join('');
    const strideSection = strideCov.length
        ? `<h2>STRIDE-per-element coverage</h2><p>✓ = at least one threat of that category on the element; · = candidate gap.</p><table><caption>STRIDE-per-element coverage</caption><thead><tr><th scope='col'>Element</th><th scope='col'>S</th><th scope='col'>T</th><th scope='col'>R</th><th scope='col'>I</th><th scope='col'>D</th><th scope='col'>E</th></tr></thead><tbody>${strideRows}</tbody></table>`
        : '';
    const componentsById = new Map((system.components || []).map((component) => [component.id, component]));
    const componentsByTag = new Map((system.components || []).filter((component) => component.tag).map((component) => [component.tag, component]));
    const dfdNodesById = new Map((dfd.nodes || []).map((node) => [node.id, node]));
    const boundaryMemberName = (memberId) => {
        const node = dfdNodesById.get(memberId);
        const component = componentsById.get(memberId) || componentsById.get(node?.componentRef) || componentsByTag.get(memberId);
        return component?.name || node?.label || memberId;
    };
    const tbRows = (system.trustBoundaries || [])
        .map((b) => {
            const crossing = (dfd.flows || []).filter((f) => f.crossesBoundary === b.id).map((f) => f.id);
            const members = (b.members || []).map(boundaryMemberName);
            return `<tr><td><b>${esc(b.id)}</b> ${esc(b.name)}</td><td>${esc(members.join(', '))}</td><td>${esc(crossing.join(', ')) || '—'}</td></tr>`;
        })
        .join('');
    const tbSection = (system.trustBoundaries || []).length
        ? `<h2>Trust boundaries</h2><table><caption>Trust boundaries</caption><thead><tr><th scope='col'>Boundary</th><th scope='col'>Members</th><th scope='col'>Crossing flows</th></tr></thead><tbody>${tbRows}</tbody></table>`
        : '';
    const warn = openIssueList.length
        ? `<ul class=warn>${openIssueList.map((i) => `<li>${i.severity === 'error' ? '⛔' : i.severity === 'notice' ? 'ℹ' : '⚠'} ${esc(i.message)}</li>`).join('')}</ul>`
        : '<p>No open issues found.</p>';
    const acceptedNoticeSection = acceptedIssueList.length
        ? `<h3>Accepted notices</h3><ul>${acceptedIssueList.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul>`
        : '';
    const sbomSection =
        sbomMode !== 'in-tool'
            ? project.sbom?.url
                ? `<h2>Software bill of materials (SBOM)</h2><p>Provided externally: ${renderLink(project.sbom.url, project.sbom.url)}</p>`
                : `<h2>Software bill of materials (SBOM)</h2><p>Declared as externally provided; no URL was recorded.</p>`
            : sbomRows
                ? `<h2>Software bill of materials (SBOM)</h2><p>${sbomFormat === 'spdx' ? 'SPDX 2.3' : 'CycloneDX'} — <code>${esc(sbomFile)}</code></p><table><caption>Software bill of materials</caption><thead><tr><th scope='col'>Component</th><th scope='col'>Version</th><th scope='col'>Supplier</th><th scope='col'>License</th><th scope='col'>CPE / purl</th><th scope='col'>Provenance</th></tr></thead><tbody>${sbomRows}</tbody></table>`
                : '';

    const requirementIdsFor = (threatId) => reqs.filter((requirement) => (requirement.derivedFromThreat || []).includes(threatId)).map((requirement) => requirement.id);
    const disclosureItem = (threat, extra = '') => {
        const requirementIds = requirementIdsFor(threat.id);
        return `<li><b>${esc(threat.id)}</b> ${esc(threat.title)}${threat.responsibility ? ` · ${esc(threat.responsibility)}` : ''}${extra}${threat.deploymentConstraints ? `<br><b>Deployment constraints:</b> ${esc(threat.deploymentConstraints)}` : ''}<br><b>Requirements:</b> ${esc(requirementIds.join(', ') || '—')}</li>`;
    };
    const byResponsibility = threats.filter((threat) => {
        const risk = trace.find((row) => row.threat === threat.id);
        const aboveAcceptable = risk?.residual > 0 && (reportRiskEngine
            ? !reportRiskEngine.isAcceptable(threat, cms, project)
            : risk.residual > (Number.isFinite(project.acceptableRisk) ? project.acceptableRisk : 12));
        return (threat.classification && threat.classification !== 'product-vulnerability')
            || ['accepted', 'transferred'].includes(threat.status)
            || aboveAcceptable;
    });
    const avoidedThreats = threats.filter((threat) => threat.status === 'avoided');
    const acceptedDeviations = threats.filter((threat) => threat.status === 'accepted' && threat.acceptanceDeviation);
    const riskDisclosureSection = byResponsibility.length || avoidedThreats.length || acceptedDeviations.length
        ? `<h2>Residual risks and expectations on users and integrators</h2>` +
        (byResponsibility.length ? `<h3>By responsibility</h3><ul>${byResponsibility.map((threat) => disclosureItem(threat)).join('')}</ul>` : '') +
        (avoidedThreats.length ? `<h3>Avoided</h3><ul>${avoidedThreats.map((threat) => disclosureItem(threat, `<br><b>Avoidance rationale:</b> ${esc(threat.avoidanceRationale || '—')}`)).join('')}</ul>` : '') +
        (acceptedDeviations.length ? `<h3>Accepted deviations from the acceptance criteria</h3><ul>${acceptedDeviations.map((threat) => disclosureItem(threat, `<br><b>Circumstance:</b> ${esc(threat.acceptanceDeviation.circumstance || '—')}<br><b>Communicated to:</b> ${esc(threat.acceptanceDeviation.communicatedTo || '—')}`)).join('')}</ul>` : '')
        : '';

    const html =
        `<!doctype html><html lang='en'><head><meta charset=utf8><meta name='viewport' content='width=device-width, initial-scale=1'><meta http-equiv='Content-Security-Policy' content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>TRA ${esc(project.title)}</title>` +
        '<style>body{font:14px system-ui;margin:2rem auto;max-width:78rem;color:#1d2430;line-height:1.45}table{border-collapse:collapse;width:100%;margin:.75rem 0 1.25rem;background:#fff}td,th{border:1px solid #d9dee7;padding:8px 10px;text-align:left;vertical-align:top;font-size:12.5px}th{background:#f4f7fb}h1{font-size:1.65rem;margin-bottom:.35rem}h2{margin-top:1.8rem;border-bottom:2px solid #e7ebf2;padding-bottom:4px}.lead{color:#4d5a6d;max-width:68rem}.warn{color:#c62828}.mono{font-family:ui-monospace,monospace}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem;margin:1rem 0 1.5rem}.meta div{background:#f7f9fc;border:1px solid #e2e7ef;border-radius:10px;padding:.75rem .9rem}svg{max-width:100%;border:1px solid #e7ebf2;border-radius:10px;margin:.4rem 0;background:#fff}.trace-note{background:#f7f9fc;border:1px solid #e2e7ef;border-radius:10px;padding:.8rem 1rem;margin:.5rem 0 1rem}@media print{body{margin:0;max-width:none}table{page-break-inside:auto}tr{break-inside:avoid;page-break-inside:avoid}}</style></head><body><main>' +
        `<h1>${esc(project.title)}</h1><p>Device: ${esc(project.device?.name)} | SL-C ${esc(project.slTarget)} | mode ${esc(project.scope?.mode)} | status ${esc(project.status)} | generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${kbv ? ` | KB/repo ${esc(kbv)}` : ''}</p>` +
        `<div class='meta'><div><b>Device</b><br>${esc(project.device?.name || '—')}</div><div><b>Security target</b><br>${esc(project.slTarget || '—')}</div><div><b>Assessment mode</b><br>${esc(project.scope?.mode || '—')}</div><div><b>Status</b><br>${esc(project.status || 'draft')}</div></div>` +
        `<p><b>Scope:</b> ${esc(project.scope?.boundary || '')}</p>` +
        (project.intendedUse ? `<p><b>Intended purpose:</b> ${esc(project.intendedUse)}</p>` : '') +
        (project.foreseeableUse?.length ? `<p><b>Reasonably foreseeable use:</b></p><ul>${project.foreseeableUse.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '') +
        (schemeResolution.warning ? `<div class='warn' role='alert'>${esc(schemeResolution.warning)} Risk-axis values are shown without classification.</div>` : '') +
        `<h2>Traceability matrix</h2><div class='trace-note'>This matrix shows the full chain from protected asset to assessed threat, required security response, implemented countermeasure, residual risk and linked evidence. Machine-readable exports are written alongside the report as <code>report/traceability.csv</code>, <code>report/traceability.json</code> and <code>${esc(sbomFile)}</code>.</div>` +
        `<h2>Traceability matrix</h2><div class='trace-note'>This matrix shows the full chain from protected asset to assessed threat, required security response, implemented countermeasure, residual risk and linked evidence. Machine-readable exports are written alongside the report as <code>report/traceability.csv</code>, <code>report/traceability.json</code> and <code>${esc(sbomFile)}</code>.</div>` +
        `<table><caption>Traceability matrix</caption><thead><tr><th scope='col'>Asset</th><th scope='col'>C/I/A/S</th><th scope='col'>Threat</th><th scope='col'>Initial</th><th scope='col'>Requirement</th><th scope='col'>Control</th><th scope='col'>Residual</th><th scope='col'>Evidence</th><th scope='col'>Status</th><th scope='col'>Classification</th><th scope='col'>Responsibility</th><th scope='col'>Deployment constraints</th></tr></thead><tbody>${traceRows}</tbody></table>` +
        `<h2>Data flow diagram (all layers)</h2>${dfdHtml}` +
        useCaseSection +
        tbSection +
        strideSection +
        strideTbSection +
        `<h2>Attacker profiles</h2><ul>${atk}</ul>` +
        (assumptionSection ? `<h2>Assumptions</h2>${assumptionSection}` : '') +
        `<h2>Assets</h2><ul>${assets}</ul>` +
        riskSchemeSection +
        riskDisclosureSection +
        (ifaceList ? `<h2>External interfaces</h2><ul>${ifaceList}</ul>` : '') +
        (reqRows ? `<h2>Security requirements</h2><table><caption>Security requirements</caption><thead><tr><th scope='col'>ID</th><th scope='col'>Requirement</th><th scope='col'>Standard / SL·FR</th><th scope='col'>From threats</th><th scope='col'>Satisfied by</th></tr></thead><tbody>${reqRows}</tbody></table>` : '') +
        `<h2>Countermeasures</h2><ul>${cmrows}</ul>` +
        sbomSection +
        (treeList ? `<h2>Attack trees</h2><ul>${treeList}</ul>` : '') +
        `<h2>Plausibility check</h2>${warn}${acceptedNoticeSection}</main></body></html>`;

    return {
        html,
        issues,
        files: {
            'index.html': html,
            'traceability.csv': traceabilityCsv(trace),
            'traceability.json': JSON.stringify(trace, null, 2) + '\n',
            ...(sbomMode === 'in-tool'
                ? sbomFormat === 'spdx'
                    ? { 'sbom.spdx.json': JSON.stringify(buildSpdx({ project, system }), null, 2) + '\n' }
                    : { 'sbom.cdx.json': JSON.stringify(sbom, null, 2) + '\n' }
                : {}),
        },
    };
}

/** Generate the report and write the full export bundle into the project's report/ folder. */
export async function generateReport(id) {
    const { html, issues, files } = await buildReport(id);
    const dir = join(projectsDir, id, 'report');
    await fs.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) await fs.writeFile(join(dir, name), content, 'utf8');
    return { html, issues };
}
