function ensureModalRoot() {
    let root = document.getElementById('modal-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'modal-root';
        document.body.appendChild(root);
    }
    return root;
}

function closeModal(modal, resolve, value) {
    modal.remove();
    document.body.classList.remove('has-modal');
    resolve(value);
}

function buildModalShell({ title, message, content, confirmText, cancelText, tone = 'default' }) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div class="modal-header">
                <div>
                    <div class="modal-eyebrow">${tone === 'danger' ? 'Careful' : 'Action'}</div>
                    <h2 id="modal-title">${title}</h2>
                </div>
                <button type="button" class="modal-close" aria-label="Close">x</button>
            </div>
            <p class="modal-message">${message}</p>
            <div class="modal-body"></div>
            <div class="modal-footer">
                <button type="button" class="ghost-btn modal-cancel">${cancelText || 'Cancel'}</button>
                <button type="button" class="primary-btn modal-confirm ${tone === 'danger' ? 'danger-btn' : ''}">${confirmText || 'Confirm'}</button>
            </div>
        </div>
    `;

    modal.querySelector('.modal-body')?.append(content);
    return modal;
}

function attachSharedModalHandlers(modal, resolve, fallbackValue = null) {
    const handleCancel = () => closeModal(modal, resolve, fallbackValue);
    modal.querySelector('.modal-close')?.addEventListener('click', handleCancel);
    modal.querySelector('.modal-cancel')?.addEventListener('click', handleCancel);
    modal.addEventListener('click', event => {
        if (event.target === modal) {
            handleCancel();
        }
    });

    const onKeyDown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
        }
    };

    modal.__cleanupKeydown = onKeyDown;
    document.addEventListener('keydown', onKeyDown);
}

function cleanupSharedModalHandlers(modal) {
    if (modal.__cleanupKeydown) {
        document.removeEventListener('keydown', modal.__cleanupKeydown);
    }
}

export function promptDialog({
    title,
    message,
    label,
    placeholder = '',
    initialValue = '',
    confirmText = 'Confirm',
    validate
}) {
    return new Promise(resolve => {
        const form = document.createElement('div');
        form.className = 'modal-form';
        form.innerHTML = `
            <label class="modal-label" for="modal-input">${label}</label>
            <input id="modal-input" class="modal-input" type="text" autocomplete="off" spellcheck="false" />
            <div class="modal-error" aria-live="polite"></div>
        `;

        const input = form.querySelector('#modal-input');
        const error = form.querySelector('.modal-error');
        input.value = initialValue;
        input.placeholder = placeholder;

        const modal = buildModalShell({
            title,
            message,
            content: form,
            confirmText
        });

        const root = ensureModalRoot();
        document.body.classList.add('has-modal');
        root.appendChild(modal);
        attachSharedModalHandlers(modal, value => {
            cleanupSharedModalHandlers(modal);
            resolve(value);
        });

        const confirmButton = modal.querySelector('.modal-confirm');
        const submit = () => {
            const value = input.value.trim();
            const validationMessage = typeof validate === 'function' ? validate(value) : '';

            if (validationMessage) {
                error.textContent = validationMessage;
                input.focus();
                input.select();
                return;
            }

            cleanupSharedModalHandlers(modal);
            closeModal(modal, resolve, value);
        };

        confirmButton?.addEventListener('click', submit);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submit();
            }
        });

        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    });
}

export function confirmDialog({
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    tone = 'default'
}) {
    return new Promise(resolve => {
        const content = document.createElement('div');
        content.className = 'modal-note';
        content.textContent = tone === 'danger'
            ? 'This action cannot be undone from inside the editor.'
            : 'Please confirm to continue.';

        const modal = buildModalShell({
            title,
            message,
            content,
            confirmText,
            cancelText,
            tone
        });

        const root = ensureModalRoot();
        document.body.classList.add('has-modal');
        root.appendChild(modal);
        attachSharedModalHandlers(modal, value => {
            cleanupSharedModalHandlers(modal);
            resolve(value);
        }, false);

        modal.querySelector('.modal-confirm')?.addEventListener('click', () => {
            cleanupSharedModalHandlers(modal);
            closeModal(modal, resolve, true);
        });

        requestAnimationFrame(() => {
            modal.querySelector('.modal-confirm')?.focus();
        });
    });
}

export function showToast(message, tone = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${tone === 'error' ? 'error' : tone === 'success' ? 'success' : ''}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('visible');
    });

    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 180);
    }, 2600);
}
