const INVALID_NAME_PATTERN = /[\\/:*?"<>|\u0000]/;

export function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

export function formatBytes(bytes) {
    const value = Number(bytes || 0);

    if (value < 1024) {
        return `${value} B`;
    }

    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }

    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function validateEntityName(value) {
    const name = String(value || '').trim();

    if (!name) {
        return 'Name is required.';
    }

    if (name.length > 255) {
        return 'Name must be 255 characters or less.';
    }

    if (name === '.' || name === '..') {
        return 'Reserved names are not allowed.';
    }

    if (name.startsWith('.')) {
        return 'Hidden names are not supported here.';
    }

    if (INVALID_NAME_PATTERN.test(name)) {
        return 'Name contains invalid characters.';
    }

    return '';
}

export function toContextText(context) {
    if (!context) {
        return '';
    }

    if (typeof context === 'string') {
        return context;
    }

    return Object.entries(context)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${value}`)
        .join(' | ');
}
