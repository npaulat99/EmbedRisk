export type ConfirmOptions = {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
};

export type PromptOptions = {
    title: string;
    label: string;
    defaultValue?: string;
    validate?: (value: string) => string | null | undefined;
};

export type AlertOptions = { title: string; message: string };

export type DialogRequest =
    | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
    | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
    | { kind: 'alert'; options: AlertOptions; resolve: () => void };

type DialogHandler = (request: DialogRequest) => void;

let dialogHandler: DialogHandler | null = null;

export function registerDialogHandler(handler: DialogHandler | null) {
    dialogHandler = handler;
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
    if (!dialogHandler) return Promise.resolve(false);
    return new Promise((resolve) => dialogHandler?.({ kind: 'confirm', options, resolve }));
}

export function prompt(options: PromptOptions): Promise<string | null> {
    if (!dialogHandler) return Promise.resolve(null);
    return new Promise((resolve) => dialogHandler?.({ kind: 'prompt', options, resolve }));
}

export function alert(options: AlertOptions): Promise<void> {
    if (!dialogHandler) return Promise.resolve();
    return new Promise((resolve) => dialogHandler?.({ kind: 'alert', options, resolve }));
}

const dialogApi = { confirm, prompt, alert };

export function useDialogs() {
    return dialogApi;
}