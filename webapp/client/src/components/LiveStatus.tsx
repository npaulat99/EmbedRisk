import { useEffect, useRef } from 'react';

let liveStatus: HTMLDivElement | null = null;

export function announce(message: string) {
    if (!liveStatus) return;
    liveStatus.textContent = '';
    requestAnimationFrame(() => {
        if (liveStatus) liveStatus.textContent = message;
    });
}

export default function LiveStatus() {
    const statusRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        liveStatus = statusRef.current;
        return () => {
            if (liveStatus === statusRef.current) liveStatus = null;
        };
    }, []);

    return <div ref={statusRef} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />;
}