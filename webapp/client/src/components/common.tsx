// Small reusable presentational helpers shared by the panels.
import React, { useEffect, useId, useState } from 'react';
import { useStore } from '../state/store';
import { idError } from '../lib/ids';
import type { RiskBand } from '../types';

export const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

/** Confirm an irreversible delete. Returns true if the user accepts. */
export const confirmDelete = (what: string) => window.confirm(`Delete ${what}? This cannot be undone.`);

/**
 * Editable unique-ID field. Validates charset + project-wide uniqueness live, and on commit
 * (blur / Enter) cascades the rename across every reference via the store. Reverts on error.
 * `onRename` fires after a successful rename so a parent (e.g. an open editor) can track the new id.
 */
export function IdInput({ id, onRename }: { id: string; onRename?: (newId: string) => void }) {
    const data = useStore((s) => s.data)!;
    const renameId = useStore((s) => s.renameId);
    const [val, setVal] = useState(id);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => setVal(id), [id]);
    const commit = () => {
        const v = val.trim();
        if (v === id) {
            setErr(null);
            return;
        }
        const e = idError(data, v, id);
        if (e) {
            setErr(e);
            setVal(id);
            return;
        }
        setErr(null);
        renameId(id, v);
        onRename?.(v);
    };
    return (
        <input
            className={cx('inp', 'idtag', err && 'invalid')}
            value={val}
            title={err || 'Unique ID. Renaming updates all references.'}
            onChange={(e) => {
                setVal(e.target.value);
                setErr(idError(data, e.target.value, id));
            }}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                    setVal(id);
                    setErr(null);
                }
            }}
        />
    );
}

export function RiskPill({ score, band, title }: { score: number; band: RiskBand; title?: string }) {
    return (
        <span className="pill" style={{ background: band.color }} title={title || `${score} · ${band.name}`}>
            {band.min === band.max && band.min > 0 ? band.name : `${score} · ${band.name}`}
        </span>
    );
}

export function Field({
    label,
    children,
    hint,
    style,
}: {
    label: string;
    children: React.ReactNode;
    hint?: string;
    style?: React.CSSProperties;
}) {
    const id = useId();
    const isNative = React.isValidElement(children) && typeof (children as any).type === 'string';
    const control = isNative ? React.cloneElement(children as React.ReactElement<any>, { id }) : children;
    return (
        <div className="field" style={style}>
            <label htmlFor={isNative ? id : undefined}>{label}</label>
            {control}
            {hint && <span className="hint">{hint}</span>}
        </div>
    );
}

/** Multi-select chip group. `options` are {value,label}; `value` is the selected list. */
export function Chips({
    options,
    value,
    onChange,
    empty,
    label,
}: {
    options: { value: string; label: string }[];
    value: string[];
    onChange: (next: string[]) => void;
    empty?: string;
    label?: string;
}) {
    const toggle = (v: string) => (value.includes(v) ? onChange(value.filter((x) => x !== v)) : onChange([...value, v]));
    if (!options.length) return <span className="hint">{empty || 'Nothing to select yet.'}</span>;
    return (
        <div className="chips" role="group" aria-label={label || 'multi-select'}>
            {options.map((o) => {
                const on = value.includes(o.value);
                return (
                    <span
                        key={o.value}
                        className={cx('chip', on && 'on')}
                        role="button"
                        tabIndex={0}
                        aria-pressed={on}
                        onClick={() => toggle(o.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggle(o.value);
                            }
                        }}
                    >
                        {o.label}
                    </span>
                );
            })}
        </div>
    );
}

/**
 * Multi-select for option lists that can grow large (components, assets, threats, requirements,
 * interfaces, …). Selected items show as removable tags; unselected options stay tucked away in
 * a dropdown instead of being rendered as a wall of chips.
 */
export function TagSelect({
    options,
    value,
    onChange,
    empty,
    addLabel = '+ Add…',
    label,
}: {
    options: { value: string; label: string; title?: string }[];
    value: string[];
    onChange: (next: string[]) => void;
    empty?: string;
    addLabel?: string;
    label?: string;
}) {
    const selected = value || [];
    const optOf = (v: string) => options.find((o) => o.value === v);
    const labelOf = (v: string) => optOf(v)?.label || v;
    const available = options.filter((o) => !selected.includes(o.value));
    if (!options.length) return <span className="hint">{empty || 'Nothing to select from yet.'}</span>;
    return (
        <div className="tagselect" role="group" aria-label={label || 'multi-select'}>
            <div className="tagselect-tags">
                {selected.length ? (
                    selected.map((v) => (
                        <span className="chip on" key={v} title={optOf(v)?.title}>
                            {labelOf(v)}
                            <button
                                type="button"
                                className="chipx"
                                aria-label={`Remove ${labelOf(v)}`}
                                onClick={() => onChange(selected.filter((x) => x !== v))}
                            >
                                ✕
                            </button>
                        </span>
                    ))
                ) : (
                    <span className="hint">{empty || 'None selected.'}</span>
                )}
            </div>
            {available.length > 0 && (
                <select
                    className="inp tagselect-add"
                    value=""
                    onChange={(e) => {
                        if (e.target.value) onChange([...selected, e.target.value]);
                    }}
                >
                    <option value="">{addLabel}</option>
                    {available.map((o) => (
                        <option key={o.value} value={o.value} title={o.title}>
                            {o.label}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

/** Read-only display of the currently-selected options (labels) as static chips. Used by the
 *  collapsed list view so a card shows only its own links, not the full selectable universe. */
export function SelectedChips({ options, value, empty }: { options: { value: string; label: string }[]; value?: string[]; empty?: string }) {
    const sel = value || [];
    if (!sel.length) return <span className="hint">{empty || 'none'}</span>;
    const labelOf = (v: string) => options.find((o) => o.value === v)?.label || v;
    return (
        <div className="chips readonly">
            {sel.map((v) => (
                <span className="chip on static" key={v}>
                    {labelOf(v)}
                </span>
            ))}
        </div>
    );
}

/** Descriptive 1-5 / 0-5 scales used across the risk model, so raters pick a level with a label
 *  instead of a bare number. A 0 on either axis means the threat is not possible (risk 0). */
export const LIKELIHOOD_LEVELS: [number, string][] = [
    [0, 'None — not possible'],
    [1, 'Very low'],
    [2, 'Low'],
    [3, 'Medium'],
    [4, 'High'],
    [5, 'Very high'],
];
export const IMPACT_LEVELS: [number, string][] = [
    [0, 'None — no impact'],
    [1, 'Negligible'],
    [2, 'Minor'],
    [3, 'Moderate'],
    [4, 'Major'],
    [5, 'Severe'],
];
export const OBJECTIVE_LEVELS: [number, string][] = [
    [0, 'None'],
    [1, 'Very low'],
    [2, 'Low'],
    [3, 'Moderate'],
    [4, 'High'],
    [5, 'Critical'],
];

/** A <select> over a labelled numeric scale (e.g. "3 · Medium"). Keeps the number as the stored
 *  value but shows a descriptive label so raters choose a level rather than guessing a bare digit. */
export function ScaleSelect({
    value,
    onChange,
    levels,
    allowEmpty,
    disabled,
    style,
    className,
}: {
    value: number | undefined | null;
    onChange: (n: number) => void;
    levels: [number, string][];
    allowEmpty?: boolean;
    disabled?: boolean;
    style?: React.CSSProperties;
    className?: string;
}) {
    return (
        <select className={className || 'inp'} style={style} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
            {allowEmpty && <option value="">–</option>}
            {levels.map(([n, label]) => (
                <option key={n} value={n}>
                    {n} · {label}
                </option>
            ))}
        </select>
    );
}

export function NumberStepper({
    value,
    onChange,
    min = 1,
    max = 5,
}: {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
}) {
    return (
        <input
            className="inp"
            type="number"
            min={min}
            max={max}
            value={value ?? ''}
            style={{ width: 64 }}
            onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        />
    );
}

/**
 * A free-text field with dropdown suggestions (an editable combo box). Unlike a <select>,
 * the user can type any custom value while still getting the curated options as hints.
 */
export function ComboInput({
    value,
    onChange,
    options,
    placeholder,
    width,
}: {
    value?: string;
    onChange: (v: string) => void;
    options: { value: string; label?: string }[];
    placeholder?: string;
    width?: number | string;
}) {
    const listId = useId();
    return (
        <>
            <input
                className="inp"
                list={listId}
                value={value ?? ''}
                placeholder={placeholder}
                style={width ? { width } : undefined}
                onChange={(e) => onChange(e.target.value)}
            />
            <datalist id={listId}>
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </datalist>
        </>
    );
}

export const STRIDE: { k: string; label: string }[] = [
    { k: 'S', label: 'Spoofing' },
    { k: 'T', label: 'Tampering' },
    { k: 'R', label: 'Repudiation' },
    { k: 'I', label: 'Info disclosure' },
    { k: 'D', label: 'Denial of service' },
    { k: 'E', label: 'Elevation' },
];

/** Canonical STRIDE letter order (S, T, R, I, D, E). */
export const STRIDE_ORDER: string[] = STRIDE.map((s) => s.k);

/** Return the STRIDE letters in canonical S-T-R-I-D-E order so they always display consistently,
 *  regardless of the order in which they were selected or imported. Unknown letters go last. */
export function sortStride<T extends string>(letters?: T[]): T[] {
    const rank = (k: string) => {
        const i = STRIDE_ORDER.indexOf(k);
        return i === -1 ? STRIDE_ORDER.length : i;
    };
    return [...(letters || [])].sort((a, b) => rank(a) - rank(b));
}

/** Scrolls the focused item into view (set via store.goto) and returns the focused id. */
export function useFocus(view: string): string | null {
    const focus = useStore((s) => s.focus);
    const focusId = focus && focus.view === view ? focus.id : null;
    useEffect(() => {
        if (!focusId) return;
        const t = setTimeout(() => {
            const el = document.getElementById(`f-${view}-${focusId}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
        return () => clearTimeout(t);
    }, [focusId, view]);
    return focusId;
}

/**
 * Master-detail edit state for a list panel. The list shows compact cards; adding a new entry or
 * pressing Edit opens a single-entry editor (only that entry is shown). A traceability jump (focus)
 * also opens the target entry for editing so links land on an editable card.
 */
export function useEditMode(focusId: string | null) {
    const [editingId, setEditingId] = useState<string | null>(null);
    useEffect(() => {
        if (focusId) setEditingId(focusId);
    }, [focusId]);
    return { editingId, setEditingId };
}

/** Compact "← Back to list" bar shown above a single-entry editor. */
export function EditBackBar({ label, onBack }: { label: string; onBack: () => void }) {
    return (
        <div className="editbackbar">
            <button className="btn sm" onClick={onBack}>
                ← Back to list
            </button>
            <span className="muted">{label}</span>
        </div>
    );
}

/** A clickable chip that jumps to a linked item in another view (traceability). */
export function Jump({ view, id, label, title }: { view: string; id: string; label?: string; title?: string }) {
    const goto = useStore((s) => s.goto);
    return (
        <span
            className="jump"
            role="button"
            tabIndex={0}
            title={title || `Open ${id}`}
            onClick={(e) => {
                e.stopPropagation();
                goto(view, id);
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    goto(view, id);
                }
            }}
        >
            {label || id}
        </span>
    );
}

/** A "?" button that toggles a small inline help popover. */
export function HelpButton({ title, children }: { title?: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
        <span className="helpwrap" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
            <button type="button" className="helpbtn" title="Show guidance" aria-expanded={open} aria-label="Show guidance" onClick={() => setOpen((o) => !o)}>
                <span aria-hidden="true">?</span>
            </button>
            {open && (
                <div className="helppop" role="dialog" aria-label={title || 'Guidance'}>
                    <div className="helphead">
                        <b>{title || 'Guidance'}</b>
                        <button className="btn sm ghost" aria-label="Close guidance" onClick={() => setOpen(false)}>
                            ✕
                        </button>
                    </div>
                    <div className="helpbody">{children}</div>
                </div>
            )}
        </span>
    );
}
