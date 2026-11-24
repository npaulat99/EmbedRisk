import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import AppDialog from './AppDialog';
import { registerDialogHandler } from '../lib/useDialogs';
import type { DialogRequest } from '../lib/useDialogs';

function dismissedValue(request: DialogRequest): boolean | null | undefined {
    if (request.kind === 'confirm') return false;
    if (request.kind === 'prompt') return null;
    return undefined;
}

export default function DialogProvider({ children }: { children: ReactNode }) {
    const [active, setActive] = useState<DialogRequest | null>(null);
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    const activeRef = useRef<DialogRequest | null>(null);
    const queue = useRef<DialogRequest[]>([]);
    const promptRef = useRef<HTMLInputElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const errorId = useId();

    const enqueue = useCallback((request: DialogRequest) => {
        if (activeRef.current) {
            queue.current.push(request);
            return;
        }
        activeRef.current = request;
        setActive(request);
        setValue(request.kind === 'prompt' ? request.options.defaultValue || '' : '');
        setError('');
    }, []);

    useEffect(() => {
        registerDialogHandler(enqueue);
        return () => registerDialogHandler(null);
    }, [enqueue]);

    const finish = (result: boolean | string | null | undefined) => {
        const current = activeRef.current;
        activeRef.current = null;
        if (current?.kind === 'confirm') current.resolve(result === true);
        else if (current?.kind === 'prompt') current.resolve(typeof result === 'string' ? result : null);
        else current?.resolve();
        const next = queue.current.shift() || null;
        activeRef.current = next;
        setActive(next);
        setValue(next?.kind === 'prompt' ? next.options.defaultValue || '' : '');
        setError('');
    };

    const submitPrompt = (event: FormEvent) => {
        event.preventDefault();
        if (active?.kind !== 'prompt') return;
        const validationError = active.options.validate?.(value.trim()) || '';
        if (validationError) {
            setError(validationError);
            promptRef.current?.focus();
            return;
        }
        finish(value.trim());
    };

    const title = active ? active.options.title : '';
    let content: ReactNode = null;
    let initialFocus: RefObject<HTMLElement | null> | undefined;

    if (active?.kind === 'confirm') {
        initialFocus = active.options.danger ? cancelRef : undefined;
        content = (
            <>
                <p>{active.options.message}</p>
                <div className="app-dialog-actions">
                    <button ref={cancelRef} className="btn" type="button" onClick={() => finish(false)}>Cancel</button>
                    <button className={`btn${active.options.danger ? ' danger' : ' primary'}`} type="button" onClick={() => finish(true)}>
                        {active.options.confirmLabel || 'Confirm'}
                    </button>
                </div>
            </>
        );
    } else if (active?.kind === 'prompt') {
        initialFocus = promptRef;
        content = (
            <form onSubmit={submitPrompt}>
                <label className="app-dialog-label" htmlFor={`${errorId}-input`}>{active.options.label}</label>
                <input
                    ref={promptRef}
                    id={`${errorId}-input`}
                    className="inp"
                    value={value}
                    aria-invalid={!!error || undefined}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(event) => {
                        setValue(event.target.value);
                        if (error) setError('');
                    }}
                />
                {error && <span id={errorId} className="app-dialog-error">{error}</span>}
                <div className="app-dialog-actions">
                    <button className="btn" type="button" onClick={() => finish(null)}>Cancel</button>
                    <button className="btn primary" type="submit">Continue</button>
                </div>
            </form>
        );
    } else if (active?.kind === 'alert') {
        content = (
            <>
                <p>{active.options.message}</p>
                <div className="app-dialog-actions">
                    <button className="btn primary" type="button" onClick={() => finish(undefined)}>OK</button>
                </div>
            </>
        );
    }

    return (
        <>
            {children}
            <AppDialog
                open={!!active}
                title={title}
                onClose={() => finish(active ? dismissedValue(active) : undefined)}
                initialFocus={initialFocus}
            >
                {content}
            </AppDialog>
        </>
    );
}