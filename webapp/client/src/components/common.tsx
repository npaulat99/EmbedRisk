// Small reusable presentational helpers shared by the panels.
import React, { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { idError } from '../lib/ids';
import { confirm } from '../lib/useDialogs';
import { announce } from './LiveStatus';
import type { RiskBand } from '../types';

export const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

/** Confirm an irreversible delete. Returns true if the user accepts. */
export const confirmDelete = (what: string) => confirm({ title: 'Confirm deletion', message: `Delete ${what}? This cannot be undone.`, confirmLabel: 'Delete', danger: true });

/**
 * Editable unique-ID field. Validates charset + project-wide uniqueness live, and on commit
 * (blur / Enter) cascades the rename across every reference via the store. Reverts on error.
 * `onRename` fires after a successful rename so a parent (e.g. an open editor) can track the new id.
 */
export function IdInput({ id, onRename, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }: { id: string; onRename?: (newId: string) => void; 'aria-labelledby'?: string; 'aria-describedby'?: string }) {
    const data = useStore((s) => s.data)!;
    const renameId = useStore((s) => s.renameId);
    const [val, setVal] = useState(id);
    const [err, setErr] = useState<string | null>(null);
    const generatedId = useId();
    const errorId = `${generatedId}-error`;
    const description = [describedBy, err ? errorId : null].filter(Boolean).join(' ') || undefined;
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
        <>
            <input
                className={cx('inp', 'idtag', err && 'invalid')}
                id={generatedId}
                aria-label={labelledBy ? undefined : 'Unique ID'}
                aria-labelledby={labelledBy}
                aria-invalid={err ? true : undefined}
                aria-describedby={description}
                value={val}
                title="Unique ID. Renaming updates all references."
                onChange={(e) => {
                    setVal(e.target.value);
                    setErr(idError(data, e.target.value, id));
                }}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') {
                        setVal(id);
                        setErr(null);
                    }
                }}
            />
            {err && <span id={errorId} className="id-input-error">{err}</span>}
        </>
    );
}

export function RiskPill({ score, band, title }: { score: number; band: RiskBand; title?: string }) {
    return (
        <span className="pill" style={{ background: band.color }} title={title || (band.lookup ? band.name : `${score} · ${band.name}`)}>
            {band.lookup ? band.name : `${score} · ${band.name}`}
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
    const labelId = `${id}-label`;
    const hintId = `${id}-hint`;
    const childType = React.isValidElement(children) ? children.type : undefined;
    const isNative = typeof childType === 'string' && ['input', 'select', 'textarea'].includes(childType);
    const isCustomControl = typeof childType === 'function';
    const childProps = React.isValidElement(children) ? (children.props as { 'aria-describedby'?: string }) : {};
    const describedBy = [childProps['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined;
    const control = isNative
        ? React.cloneElement(children as React.ReactElement<any>, { id, 'aria-describedby': describedBy })
        : isCustomControl && React.isValidElement(children)
            ? React.cloneElement(children as React.ReactElement<any>, {
                'aria-labelledby': labelId,
                'aria-describedby': describedBy,
                ...(children.type === TagSelect || children.type === Chips ? { label } : {}),
            })
            : <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>{children}</div>;
    return (
        <div className="field" style={style}>
            <label id={labelId} htmlFor={isNative ? id : undefined}>{label}</label>
            {control}
            {hint && <span id={hintId} className="hint">{hint}</span>}
        </div>
    );
}

export function TableRegion({ label, children }: { label: string; children: React.ReactElement<any> }) {
    const captionId = useId();
    const regionRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const region = regionRef.current;
        const table = region?.querySelector('table');
        if (!region || !table) return;
        const updateHeight = () => region.classList.toggle('is-tall', table.scrollHeight > window.innerHeight);
        const observer = new ResizeObserver(updateHeight);
        observer.observe(table);
        window.addEventListener('resize', updateHeight);
        updateHeight();
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', updateHeight);
        };
    }, []);
    const table = React.cloneElement(children, {}, (
        <>
            <caption id={captionId} className="sr-only">{label}</caption>
            {children.props.children}
        </>
    ));
    return <div ref={regionRef} className="tbl-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>{table}</div>;
}

/** Multi-select chip group. `options` are {value,label}; `value` is the selected list. */
export function Chips({
    options,
    value,
    onChange,
    empty,
    label,
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
}: {
    options: { value: string; label: string }[];
    value: string[];
    onChange: (next: string[]) => void;
    empty?: string;
    label?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
}) {
    const toggle = (v: string) => (value.includes(v) ? onChange(value.filter((x) => x !== v)) : onChange([...value, v]));
    if (!options.length) return <div className="hint" role="group" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy}>{empty || 'Nothing to select yet.'}</div>;
    return (
        <div className="chips" role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy}>
            {options.map((o) => {
                const on = value.includes(o.value);
                return (
                    <button
                        key={o.value}
                        className={cx('chip', on && 'on')}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(o.value)}
                    >
                        {o.label}
                    </button>
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
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
}: {
    options: { value: string; label: string; title?: string }[];
    value: string[];
    onChange: (next: string[]) => void;
    empty?: string;
    addLabel?: string;
    label?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
}) {
    const tagsRef = useRef<HTMLDivElement>(null);
    const selectRef = useRef<HTMLSelectElement>(null);
    const selected = value || [];
    const optOf = (v: string) => options.find((o) => o.value === v);
    const labelOf = (v: string) => optOf(v)?.label || v;
    const available = options.filter((o) => !selected.includes(o.value));
    if (!options.length) return <div className="hint" role="group" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy}>{empty || 'Nothing to select from yet.'}</div>;
    const remove = (valueToRemove: string, index: number) => {
        onChange(selected.filter((item) => item !== valueToRemove));
        announce(`Removed ${labelOf(valueToRemove)}.`);
        requestAnimationFrame(() => {
            const buttons = tagsRef.current?.querySelectorAll<HTMLButtonElement>('.chipx');
            (buttons?.[Math.min(index, (buttons.length || 1) - 1)] || selectRef.current)?.focus();
        });
    };
    return (
        <div className="tagselect" role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy}>
            <div className="tagselect-tags" ref={tagsRef}>
                {selected.length ? (
                    selected.map((v, index) => (
                        <span className="chip on" key={v} title={optOf(v)?.title}>
                            {labelOf(v)}
                            <button
                                type="button"
                                className="chipx"
                                aria-label={`Remove ${labelOf(v)}`}
                                onClick={() => remove(v, index)}
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
                    ref={selectRef}
                    className="inp tagselect-add"
                    value=""
                    aria-label={`Add to ${label || 'selection'}`}
                    aria-describedby={describedBy}
                    onChange={(e) => {
                        const added = e.target.value;
                        if (added) {
                            onChange([...selected, added]);
                            announce(`Added ${labelOf(added)}.`);
                        }
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
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
}: {
    value: number | undefined | null;
    onChange: (n: number) => void;
    levels: [number, string][];
    allowEmpty?: boolean;
    disabled?: boolean;
    style?: React.CSSProperties;
    className?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
}) {
    return (
        <select className={className || 'inp'} style={style} value={value ?? ''} disabled={disabled} aria-labelledby={labelledBy} aria-describedby={describedBy} onChange={(e) => onChange(Number(e.target.value))}>
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
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
}: {
    value?: string;
    onChange: (v: string) => void;
    options: { value: string; label?: string }[];
    placeholder?: string;
    width?: number | string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
}) {
    const listId = useId();
    return (
        <>
            <input
                className="inp"
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
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
        <button
            className="jump"
            type="button"
            title={title || `Open ${id}`}
            onClick={(e) => { e.stopPropagation(); goto(view, id); }}
        >
            {label || id}
        </button>
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
