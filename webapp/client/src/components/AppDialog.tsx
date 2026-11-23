import { useEffect, useId, useRef } from 'react';
import type { PointerEvent, ReactNode, RefObject } from 'react';

type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export default function AppDialog({
    open,
    onClose,
    id,
    title,
    size = 'md',
    className,
    dismissOnBackdrop = false,
    initialFocus,
    onCancel,
    children,
}: {
    open: boolean;
    onClose: () => void;
    id?: string;
    title: string;
    size?: DialogSize;
    className?: string;
    dismissOnBackdrop?: boolean;
    initialFocus?: RefObject<HTMLElement | null>;
    onCancel?: () => void;
    children: ReactNode;
}) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const closeCallback = useRef(onClose);
    const titleId = useId();
    const pressedOutside = useRef(false);

    useEffect(() => {
        closeCallback.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const handleClose = () => closeCallback.current();
        const handleCancel = (event: Event) => {
            if (!onCancel) return;
            event.preventDefault();
            onCancel();
        };
        dialog.addEventListener('close', handleClose);
        dialog.addEventListener('cancel', handleCancel);
        return () => {
            dialog.removeEventListener('close', handleClose);
            dialog.removeEventListener('cancel', handleCancel);
        };
    }, [onCancel]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        if (open && !dialog.open) {
            if (dismissOnBackdrop && 'closedBy' in HTMLDialogElement.prototype) {
                dialog.setAttribute('closedby', 'any');
            } else {
                dialog.removeAttribute('closedby');
            }
            dialog.showModal();
            requestAnimationFrame(() => {
                if (!dialog.open) return;
                const target = initialFocus?.current || dialog.querySelector<HTMLElement>('[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
                (target || dialog).focus();
            });
        } else if (!open && dialog.open) {
            dialog.close();
        }
    }, [dismissOnBackdrop, initialFocus, open]);

    const isOutside = (event: PointerEvent<HTMLDialogElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };

    return (
        <dialog
            ref={dialogRef}
            id={id}
            className={`modal app-dialog${className ? ` ${className}` : ''}`}
            data-size={size}
            aria-labelledby={titleId}
            tabIndex={-1}
            onPointerDown={(event) => {
                pressedOutside.current = dismissOnBackdrop && isOutside(event);
            }}
            onPointerUp={(event) => {
                if (pressedOutside.current && isOutside(event) && event.currentTarget.open) event.currentTarget.close();
                pressedOutside.current = false;
            }}
        >
            <header className="app-dialog-head">
                <h2 id={titleId}>{title}</h2>
                <button className="btn sm" type="button" aria-label="Close dialog" onClick={() => dialogRef.current?.close()}>
                    ✕ Close
                </button>
            </header>
            <div className="app-dialog-body">{children}</div>
        </dialog>
    );
}