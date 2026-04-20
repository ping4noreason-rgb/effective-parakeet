import { appState } from './state.js';
import { toContextText } from './utils.js';

function write(level, message, options = {}) {
    const context = toContextText(options.context);
    const details = options.details ? String(options.details) : '';
    const normalizedMessage = String(message || '').trim() || 'Empty log message';

    appState.addOutput({
        level,
        message: normalizedMessage,
        context,
        details
    });

    const consoleMessage = `[${level}] ${normalizedMessage}`;
    if (level === 'ERR') {
        console.error(consoleMessage, context || details || '');
    } else if (level === 'INFO') {
        console.info(consoleMessage, context || '');
    } else {
        console.log(consoleMessage, context || '');
    }
}

export const logger = {
    sys(message, options) {
        write('SYS', message, options);
    },
    info(message, options) {
        write('INFO', message, options);
    },
    err(message, options) {
        write('ERR', message, options);
    }
};
