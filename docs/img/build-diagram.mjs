// Generates two SVGs (detailed + overview) next to this script. Run: node build-diagram.mjs
import { writeFileSync } from 'node:fs';

const COLORS = {
    prep: '#4f46e5',
    assess: '#d97706',
    treat: '#7c3aed',
    review: '#475569',
};
const GROUPS = {
    prep: { long: 'PREPARATION', short: 'PREPARATION' },
    assess: { long: 'RISK ASSESSMENT (6.4)', short: 'ASSESSMENT' },
    treat: { long: 'TREATMENT & COMMUNICATION', short: 'TREATMENT' },
};

// Each step: inputs (external + results of earlier steps), actions, results; `short` is the one-line result for the overview.
const rows = [
    {
        group: 'prep', nr: '6.2', title: 'Define product context',
        short: 'Documented product context',
        question: 'What is the product, what is it used for and where?',
        steps: [
            'Intended and reasonably foreseeable use',
            'Product functions (incl. interfaces and RDPS)',
            'Operating environment',
            'Overview of the product architecture',
            'Description of the product users',
        ],
        inputs: ['Use cases and user types', 'State of the art', 'Existing architecture and functions'],
        from: [],
        out: ['Product context', 'Evidence in the technical documentation'],
    },
    {
        group: 'prep', nr: '6.3', title: 'Risk acceptance & methodology',
        short: 'Acceptance criteria and method',
        question: 'Which risk is acceptable and how is it measured?',
        steps: [
            'Define the method for risk assessment and treatment',
            'Define and justify acceptance criteria',
            'Considers: regulation, contracts, nature of risks, users, product, state of the art',
        ],
        inputs: ['Legal requirements', 'Stakeholder expectations', 'Contractual agreements'],
        from: ['6.2 Product context'],
        out: ['Acceptance criteria for cybersecurity risks', 'Applied methodology'],
    },
    {
        group: 'assess', nr: '6.4.2', title: 'Assets & objectives',
        short: 'Assets with security objectives',
        question: 'What needs protecting and which objectives apply?',
        steps: [
            'Identify assets (data, functions, components, interfaces, network)',
            'Determine cybersecurity objectives per asset',
        ],
        inputs: [],
        from: ['6.2 Product context'],
        out: ['List of assets with their cybersecurity objectives'],
    },
    {
        group: 'assess', nr: '6.4.3', title: 'Identify threats',
        short: 'Threats per asset',
        question: 'What can harm the assets?',
        steps: [
            'For each threat state: target asset, compromised objective, cause',
            'Structure e.g. with STRIDE, attack trees, TVRA or PASTA',
        ],
        inputs: ['Common threats (catalogues)', 'Known exploitable vulnerabilities'],
        from: ['6.2 Product context', '6.4.2 Assets'],
        out: ['List of threats per asset'],
    },
    {
        group: 'assess', nr: '6.4.4', title: 'Risk estimation',
        short: 'Likelihood, impact and risk per threat',
        question: 'How likely and how severe is each threat?',
        steps: [
            'Estimate the likelihood per threat',
            'Estimate the extent of potential loss or disruption',
            'Derive the risk (qualitative, e.g. with a risk matrix)',
        ],
        inputs: [],
        from: ['6.4.3 Threats', '6.3 Methodology'],
        out: ['Risk list with likelihood, impact and risk'],
    },
    {
        group: 'assess', nr: '6.4.5', title: 'Risk evaluation',
        short: 'Evaluated risks, residual risk justified',
        question: 'Is the risk acceptable?',
        steps: [
            'Compare each risk with the acceptance criteria',
            'Justify acceptance',
            'Unacceptable risks go to treatment',
        ],
        inputs: [],
        from: ['6.4.4 Risks', '6.3 Acceptance criteria'],
        out: ['List of evaluated risks', 'Justification of acceptable residual risks'],
    },
    {
        group: 'treat', nr: '6.5', title: 'Risk treatment',
        short: 'Treatment decision per risk',
        question: 'How is each risk treated?',
        steps: [
            'Choose an option per risk, by priority:',
            { pills: ['1 Avoid', '2 Mitigate', '3 Accept', '4 Transfer'] },
            'Lower priority only if no higher one is suitable',
            'Re-evaluate after mitigation (back to 6.4.4 / 6.4.5)',
        ],
        inputs: [],
        from: ['6.4.5 Evaluation', '6.3 Criteria & method'],
        out: ['Treatment decision with justification per risk'],
    },
    {
        group: 'treat', nr: '6.6', title: 'Risk communication',
        short: 'Residual risks shared with stakeholders',
        question: 'Who needs to know what about the residual risks?',
        steps: [
            'Disclose residual risks',
            'Recommend measures for onboarding, integration and operation',
            'State assumptions about the product context and expectations towards users and integrators',
            'Tailor to stakeholders (e.g. accessibility)',
        ],
        inputs: [],
        from: ['6.4.3 Threats', '6.4.4 Risks', '6.5 Treatment'],
        out: ['Risk information for stakeholders', 'Documented expectations towards users'],
    },
    {
        group: 'review', nr: '6.7', title: 'Review of risk management', dashed: true,
        short: 'Repeat affected steps on change',
        question: 'Does the assessment still hold?',
        steps: [
            'Applies throughout the product lifecycle (design, development, production, maintenance)',
            'If product, context or threat landscape change, the affected steps are repeated',
        ],
        inputs: [],
        from: [],
        out: [],
    },
];

const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const INK = '#1e293b', MUTED = '#64748b';
const CHIP = { fill: '#eef2ff', stroke: '#a5b4fc', color: '#3730a3' };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap = (text, max) => {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
        if (line && (line + ' ' + word).length > max) { lines.push(line); line = word; }
        else line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
    return lines;
};
const t = (x, y, s, { size = 14, fill = INK, weight = 'normal', anchor = 'start', style = '', spacing = '' } = {}) =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}"` +
    `${style ? ` font-style="${style}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`;
const arrow = (x1, y1, x2, y2, color = MUTED, width = 2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" marker-end="url(#arr)"/>`;
const pillWidth = (label, size = 12) => Math.round(label.length * size * 0.55 + 16);
const pill = (x, y, label, { fill, stroke, color, size = 12 }) => {
    const w = pillWidth(label, size);
    return `<rect x="${x}" y="${y}" width="${w}" height="22" rx="11" fill="${fill}" stroke="${stroke}"/>` +
        t(x + w / 2, y + 15, label, { size, fill: color, anchor: 'middle', weight: '600' });
};
const topRounded = (x, y, w, h, r, fill) =>
    `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`;
const badge = (x, y, nr, color) => {
    const w = nr.length * 8.5 + 18;
    return { w, svg: `<rect x="${x}" y="${y}" width="${w}" height="22" rx="11" fill="#fff"/>` + t(x + w / 2, y + 16, nr, { size: 13, fill: color, weight: 'bold', anchor: 'middle' }) };
};
const svgWrapper = (w, h, label, content) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}" role="img" aria-label="${esc(label)}">` +
    `<defs>` +
    `<marker id="arr" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,4 L0,8 z" fill="#475569"/></marker>` +
    `<filter id="shadow" x="-5%" y="-5%" width="110%" height="115%"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dy="2" result="b"/><feComponentTransfer><feFuncA type="linear" slope="0.15"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `</defs><rect width="100%" height="100%" fill="#fff"/>${content}</svg>`;
const legendItem = (x, y, swatch, label) => swatch(x, y) + t(x + 26, y + 12, label, { size: 12, fill: MUTED });

// ---------- Detailed diagram ----------
function buildDetailed() {
    const X_IN = 70, W_IN = 310;
    const X_PH = 440, W_PH = 420;
    const X_OUT = 920, W_OUT = 310;
    const X_LOOP = 1262;
    const W = 1290;
    const GAP = 38;
    const TOP = 150;

    function phaseCard(r, x, y) {
        const color = COLORS[r.group];
        let cy = y + 40 + 12;
        let body = '';
        wrap(r.question, 52).forEach((l) => { cy += 14; body += t(x + 18, cy, l, { size: 13, fill: MUTED, style: 'italic' }); cy += 4; });
        cy += 8;
        for (const step of r.steps) {
            if (step.pills) {
                let px = x + 18;
                step.pills.forEach((label) => {
                    body += pill(px, cy + 4, label, { fill: `${color}18`, stroke: color, color });
                    px += pillWidth(label) + 8;
                });
                cy += 36;
                continue;
            }
            wrap(step, 50).forEach((l, i) => {
                cy += 19;
                if (i === 0) body += `<circle cx="${x + 23}" cy="${cy - 5}" r="2.8" fill="${color}"/>`;
                body += t(x + 34, cy, l, { size: 14 });
            });
            cy += 4;
        }
        const h = cy - y + 12;
        const b = badge(x + 12, y + 9, r.nr, color);
        const svg = `<g filter="url(#shadow)">` +
            `<rect x="${x}" y="${y}" width="${W_PH}" height="${h}" rx="10" fill="#fff" stroke="${color}" stroke-width="1.5"${r.dashed ? ' stroke-dasharray="7 5"' : ''}/>` +
            topRounded(x, y, W_PH, 40, 10, color) + `</g>` +
            b.svg + t(x + 12 + b.w + 12, y + 26, r.title, { size: 16, fill: '#fff', weight: 'bold' }) + body;
        return { h, svg };
    }

    function inputCard(r, x, y) {
        const items = r.inputs.flatMap((s) => wrap(s, 38).map((l, i) => ({ l, first: i === 0 })));
        let cy = y + 30;
        let body = t(x + 16, y + 20, 'INPUTS', { size: 11, fill: MUTED, weight: 'bold', spacing: '1.2' });
        items.forEach(({ l, first }) => {
            cy += 18;
            if (first) body += `<circle cx="${x + 21}" cy="${cy - 4.5}" r="2.5" fill="${MUTED}"/>`;
            body += t(x + 32, cy, l, { size: 13 });
        });
        if (r.from.length) {
            cy += items.length ? 12 : 4;
            let px = x + 16;
            r.from.forEach((label) => {
                const text = `↳ ${label}`;
                const w = pillWidth(text);
                if (px > x + 16 && px + w > x + W_IN - 12) { px = x + 16; cy += 28; }
                body += pill(px, cy, text, CHIP);
                px += w + 6;
            });
            cy += 22;
        }
        const h = cy - y + 14;
        return { h, svg: `<rect x="${x}" y="${y}" width="${W_IN}" height="${h}" rx="10" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>` + body };
    }

    function outputCard(r, x, y) {
        const items = r.out.flatMap((s) => wrap(s, 36).map((l, i) => ({ l, first: i === 0 })));
        let cy = y + 30;
        let body = t(x + 16, y + 20, 'RESULT', { size: 11, fill: '#047857', weight: 'bold', spacing: '1.2' });
        items.forEach(({ l, first }) => {
            cy += 19;
            if (first) body += `<path d="M${x + 17},${cy - 5} l3,3 l6,-7" fill="none" stroke="#059669" stroke-width="2"/>`;
            body += t(x + 34, cy, l, { size: 14, weight: '600', fill: '#064e3b' });
        });
        const h = cy - y + 14;
        return { h, svg: `<rect x="${x}" y="${y}" width="${W_OUT}" height="${h}" rx="10" fill="#ecfdf5" stroke="#34d399" stroke-width="1.5"/>` + body };
    }

    const placed = [];
    let cursor = TOP;
    for (const r of rows) {
        const ph = phaseCard(r, X_PH, 0).h;
        const inH = (r.inputs.length || r.from.length) ? inputCard(r, X_IN, 0).h : 0;
        const outH = r.out.length ? outputCard(r, X_OUT, 0).h : 0;
        const rowH = Math.max(ph, inH, outH);
        placed.push({ r, top: cursor, rowH, ph, inH, outH });
        cursor += rowH + GAP;
    }
    const bottom = cursor - GAP;

    let body = '';
    placed.forEach(({ r, top, rowH, ph, inH, outH }, i) => {
        const mid = top + rowH / 2;
        const phY = mid - ph / 2;
        body += phaseCard(r, X_PH, phY).svg;
        if (inH) body += inputCard(r, X_IN, mid - inH / 2).svg + arrow(X_IN + W_IN, mid, X_PH - 3, mid);
        if (outH) body += outputCard(r, X_OUT, mid - outH / 2).svg + arrow(X_PH + W_PH, mid, X_OUT - 3, mid);
        if (i < placed.length - 1) {
            const next = placed[i + 1];
            const nextTop = next.top + next.rowH / 2 - next.ph / 2;
            body += arrow(X_PH + W_PH / 2, phY + ph, X_PH + W_PH / 2, nextTop - 3, '#334155', 3);
        }
    });

    for (const [key, { long }] of Object.entries(GROUPS)) {
        const members = placed.filter((p) => p.r.group === key);
        const y1 = members[0].top, y2 = members.at(-1).top + members.at(-1).rowH;
        body += `<rect x="18" y="${y1}" width="8" height="${y2 - y1}" rx="4" fill="${COLORS[key]}"/>` +
            `<text transform="translate(46 ${(y1 + y2) / 2}) rotate(-90)" font-size="12" font-weight="bold" letter-spacing="1.5" text-anchor="middle" fill="${COLORS[key]}">${esc(long)}</text>`;
    }

    const review = placed.at(-1);
    const first = placed[0];
    const loopY = TOP - 30;
    const reviewMid = review.top + review.rowH / 2;
    const firstTop = first.top + first.rowH / 2 - first.ph / 2;
    body += `<path d="M${X_PH + W_PH},${reviewMid} H${X_LOOP} V${loopY} H${X_PH + W_PH / 2} V${firstTop - 3}" fill="none" stroke="${COLORS.review}" stroke-width="2" stroke-dasharray="7 5" marker-end="url(#arr)"/>` +
        t((X_PH + W_PH / 2 + X_LOOP) / 2, loopY - 8, 'On changes: repeat the affected steps', { size: 13, fill: COLORS.review, weight: '600', anchor: 'middle' });

    const header = t(W / 2, 46, 'Risk management according to EN 40000-1-2', { size: 28, weight: 'bold', anchor: 'middle' }) +
        t(W / 2, 74, 'Clause 6: from defining the product context to communicating risk', { size: 15, fill: MUTED, anchor: 'middle' }) +
        t(W / 2, 94, 'Each step builds on the results of the previous ones: inputs on the left, results on the right', { size: 13, fill: MUTED, anchor: 'middle' });

    const ly = bottom + 36;
    const legend = `<line x1="40" y1="${ly - 14}" x2="${W - 40}" y2="${ly - 14}" stroke="#e2e8f0"/>` +
        legendItem(70, ly, (x, y) => `<rect x="${x}" y="${y}" width="18" height="14" rx="3" fill="#f8fafc" stroke="#cbd5e1"/>`, 'External inputs') +
        legendItem(230, ly, (x, y) => `<rect x="${x}" y="${y}" width="18" height="14" rx="7" fill="#eef2ff" stroke="#a5b4fc"/>`, '↳ Result of an earlier step') +
        legendItem(460, ly, (x, y) => `<rect x="${x}" y="${y}" width="18" height="14" rx="3" fill="#ecfdf5" stroke="#34d399"/>`, 'Result of the step') +
        legendItem(650, ly, (x, y) => `<line x1="${x}" y1="${y + 7}" x2="${x + 20}" y2="${y + 7}" stroke="${COLORS.review}" stroke-width="2" stroke-dasharray="5 4"/>`, 'Repetition') +
        t(70, ly + 38, 'RDPS = Remote Data Processing Solution', { size: 12, fill: MUTED });

    return svgWrapper(W, ly + 64, 'Risk management process according to EN 40000-1-2', header + body + legend);
}

// ---------- Overview diagram: steps and one short result each ----------
function buildOverview() {
    const CARD_W = 260, CARD_H = 190, HGAP = 50, VGAP = 70;
    const PER_ROW = 4;
    const X0 = 60, Y0 = 130;
    const steps = rows.filter((r) => r.group !== 'review');
    const review = rows.at(-1);
    const W = X0 * 2 + PER_ROW * CARD_W + (PER_ROW - 1) * HGAP;
    const pos = (i) => ({ x: X0 + (i % PER_ROW) * (CARD_W + HGAP), y: Y0 + Math.floor(i / PER_ROW) * (CARD_H + VGAP) });

    let body = '';
    steps.forEach((r, i) => {
        const { x, y } = pos(i);
        const color = COLORS[r.group];
        const b = badge(x + 12, y + 9, r.nr, color);
        const titleLines = wrap(r.title, 24);
        body += `<g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="#fff" stroke="${color}" stroke-width="1.5"/>` +
            topRounded(x, y, CARD_W, 40, 12, color) + `</g>` +
            b.svg + t(x + CARD_W - 14, y + 25, GROUPS[r.group].short, { size: 10, fill: '#fff', weight: 'bold', anchor: 'end', spacing: '1' });
        titleLines.forEach((l, k) => { body += t(x + 16, y + 68 + k * 22, l, { size: 17, weight: 'bold' }); });
        const oy = y + 100;
        body += `<rect x="${x + 10}" y="${oy}" width="${CARD_W - 20}" height="${CARD_H - 110}" rx="8" fill="#ecfdf5" stroke="#34d399"/>` +
            t(x + 22, oy + 18, 'RESULT', { size: 10, fill: '#047857', weight: 'bold', spacing: '1.2' });
        wrap(r.short, 26).forEach((l, k) => { body += t(x + 22, oy + 40 + k * 18, l, { size: 14, weight: '600', fill: '#064e3b' }); });

        if (i % PER_ROW < PER_ROW - 1 && i < steps.length - 1) {
            body += arrow(x + CARD_W, y + CARD_H / 2, x + CARD_W + HGAP - 3, y + CARD_H / 2, '#334155', 3);
        } else if (i === PER_ROW - 1) {
            const next = pos(i + 1);
            const midY = y + CARD_H + VGAP / 2;
            body += `<polyline points="${x + CARD_W / 2},${y + CARD_H} ${x + CARD_W / 2},${midY} ${next.x + CARD_W / 2},${midY} ${next.x + CARD_W / 2},${next.y - 3}" fill="none" stroke="#334155" stroke-width="3" marker-end="url(#arr)"/>`;
        }
    });

    const rows2 = Math.ceil(steps.length / PER_ROW);
    const by = Y0 + rows2 * (CARD_H + VGAP) - VGAP + 40;
    const bw = W - 2 * X0;
    body += `<rect x="${X0}" y="${by}" width="${bw}" height="64" rx="12" fill="#f8fafc" stroke="${COLORS.review}" stroke-width="1.5" stroke-dasharray="7 5"/>`;
    const rb = badge(X0 + 14, by + 21, review.nr, COLORS.review);
    body += `<rect x="${X0 + 14}" y="${by + 21}" width="${rb.w}" height="22" rx="11" fill="${COLORS.review}"/>` +
        t(X0 + 14 + rb.w / 2, by + 37, review.nr, { size: 13, fill: '#fff', weight: 'bold', anchor: 'middle' }) +
        t(X0 + 14 + rb.w + 14, by + 29, review.title, { size: 16, weight: 'bold' }) +
        t(X0 + 14 + rb.w + 14, by + 50, 'Whenever the product, its context or the threat landscape changes, the affected steps are repeated.', { size: 14, fill: MUTED });

    const header = t(W / 2, 46, 'Risk management according to EN 40000-1-2', { size: 28, weight: 'bold', anchor: 'middle' }) +
        t(W / 2, 76, 'Overview: the steps and what each one delivers', { size: 15, fill: MUTED, anchor: 'middle' });

    const ly = by + 64 + 36;
    const legend = Object.entries(GROUPS).map(([key, { short }], i) =>
        legendItem(X0 + i * 190, ly, (x, y) => `<rect x="${x}" y="${y}" width="18" height="14" rx="3" fill="${COLORS[key]}"/>`, short.charAt(0) + short.slice(1).toLowerCase())).join('');

    return svgWrapper(W, ly + 40, 'Overview of the risk management steps according to EN 40000-1-2', header + body + legend);
}

writeFileSync(new URL('./en40000-1-2-risk-management.svg', import.meta.url), buildDetailed());
writeFileSync(new URL('./en40000-1-2-risk-management-overview.svg', import.meta.url), buildOverview());
