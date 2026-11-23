import type { ReactNode, SVGProps } from 'react';

const icons = {
    add: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.3 1.8c-1.1 1.1-1.9 1.5-1.9 3M12 17.5v.1" /></>,
    undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h9a7 7 0 0 1 0 14h-2" /></>,
    redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9h-9a7 7 0 0 0 0 14h2" /></>,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    arrowLeft: <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
    arrowRight: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
    project: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h8M8 17h4" /></>,
    assumptions: <><path d="M12 3a8 8 0 0 0-4.5 14.6c.8.5 1.5 1.1 1.5 2.4h6c0-1.3.7-1.9 1.5-2.4A8 8 0 0 0 12 3Z" /><path d="M9 21h6M9 11h.01M15 11h.01" /></>,
    system: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    dfd: <><rect x="3" y="4" width="6" height="5" rx="1" /><rect x="15" y="15" width="6" height="5" rx="1" /><path d="M9 6.5h3a3 3 0 0 1 3 3v5.5M12 12l3 3 3-3" /></>,
    useCases: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h4a4 4 0 0 1 4 4v6" /></>,
    requirements: <><path d="M7 3h10v3h3v15H4V6h3z" /><path d="M8 11h8M8 15h8M8 19h5" /></>,
    threats: <><path d="M12 3 2.7 20h18.6L12 3Z" /><path d="M12 9v5M12 17v.1" /></>,
    attackTrees: <><circle cx="12" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M12 7v5M6 17v-2h12v2M12 12H6v3m6-3h6v3" /></>,
    countermeasures: <><path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z" /><path d="m8 12 2.5 2.5L16 9" /></>,
    review: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M8 10.5l1.7 1.7 3.3-3.4" /></>,
    versions: <><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    dashboard: <><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="5" rx="1" /><rect x="13" y="10" width="8" height="11" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /></>,
    defects: <><path d="M8 8 6 6M16 8l2-2M5 12H3M21 12h-2M7 17l-2 2M17 17l2 2" /><path d="M8 8h8v9a4 4 0 0 1-8 0V8ZM9 4h6l1 4H8l1-4Z" /><path d="M12 12v4" /></>,
    knowledgeBase: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5v-12Z" /><path d="M4 16.5A2.5 2.5 0 0 1 6.5 14H20M8 7h8M8 10h6" /></>,
    save: <><path d="M5 3h12l4 4v14H3V3h2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z" />,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M5 17v4h14v-4" /></>,
    upload: <><path d="M12 15V3m-5 5 5-5 5 5" /><path d="M5 17v4h14v-4" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

export default function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
            {icons[name]}
        </svg>
    );
}