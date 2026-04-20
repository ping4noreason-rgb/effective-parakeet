import { api } from './tauri.js';
import { logger } from './logger.js';
import { showToast } from './ui.js';

const POLL_INTERVAL_MS = 250;

class PowerShellTerminal {
    constructor() {
        this.sessionId = null;
        this.currentCwd = '';
        this.pollTimer = null;
        this.output = null;
        this.input = null;
        this.form = null;
        this.cwdLabel = null;
        this.restartButton = null;
        this.clearButton = null;
        this.ready = false;
    }

    async init() {
        this.output = document.getElementById('terminal-output');
        this.input = document.getElementById('terminal-input');
        this.form = document.getElementById('terminal-form');
        this.cwdLabel = document.getElementById('terminal-cwd');
        this.restartButton = document.getElementById('restart-terminal-btn');
        this.clearButton = document.getElementById('clear-terminal-btn');

        if (!this.output || !this.form || !this.input) {
            return;
        }

        this.bindEvents();
        try {
            await this.startSession();
            this.startPolling();
        } catch (error) {
            this.appendLine('stderr', error?.message || String(error));
            logger.err('Failed to initialize PowerShell terminal.', {
                details: error?.message || String(error)
            });
        }
    }

    bindEvents() {
        this.form?.addEventListener('submit', event => {
            event.preventDefault();
            this.runCurrentInput().catch(error => {
                logger.err('Terminal command failed.', {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Terminal command failed', 'error');
            });
        });

        this.input?.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.runCurrentInput().catch(error => {
                    logger.err('Terminal command failed.', {
                        details: error?.message || String(error)
                    });
                    showToast(error?.message || 'Terminal command failed', 'error');
                });
            }
        });

        this.restartButton?.addEventListener('click', () => {
            this.restartSession().catch(error => {
                logger.err('Terminal restart failed.', {
                    details: error?.message || String(error)
                });
            });
        });

        this.clearButton?.addEventListener('click', () => this.clear());
    }

    async startSession(initialCwd = null) {
        const session = await api.createTerminalSession(initialCwd);
        this.sessionId = session.session_id;
        this.currentCwd = session.cwd || '';
        this.ready = true;
        this.updatePrompt();
        this.appendLine('meta', `${session.shell} session started.`);
        if (this.currentCwd) {
            this.appendLine('meta', `Working directory: ${this.currentCwd}`);
        }
    }

    async restartSession() {
        if (this.sessionId) {
            await api.closeTerminalSession(this.sessionId).catch(() => {});
        }

        this.clear();
        this.sessionId = null;
        this.ready = false;
        await this.startSession(this.currentCwd || null);
        logger.info('PowerShell terminal restarted.');
    }

    async runCurrentInput() {
        const input = this.input?.value || '';
        const command = input.trim();
        if (!command || !this.sessionId) {
            return;
        }

        this.appendLine('input', command);
        this.input.value = '';
        await api.executeTerminalCommand(this.sessionId, command);
    }

    async setWorkingDirectory(path) {
        if (!this.sessionId || !path) {
            return;
        }

        const nextPath = await api.setTerminalCwd(this.sessionId, path);
        this.currentCwd = nextPath || path;
        this.updatePrompt();
    }

    clear() {
        if (this.output) {
            this.output.innerHTML = '';
        }
    }

    startPolling() {
        if (this.pollTimer || !this.sessionId) {
            return;
        }

        this.pollTimer = setInterval(() => {
            this.poll().catch(error => {
                logger.err('Terminal polling failed.', {
                    details: error?.message || String(error)
                });
            });
        }, POLL_INTERVAL_MS);
    }

    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async poll() {
        if (!this.sessionId) {
            return;
        }

        const events = await api.drainTerminalOutput(this.sessionId);
        if (!Array.isArray(events) || events.length === 0) {
            return;
        }

        events.forEach(event => this.handleEvent(event));
    }

    handleEvent(event) {
        if (event.kind === 'cwd' && event.cwd) {
            this.currentCwd = event.cwd;
            this.updatePrompt();
            return;
        }

        if (event.kind === 'ready') {
            this.updatePrompt();
            return;
        }

        if (event.kind === 'session-ended') {
            this.appendLine('meta', event.text || 'PowerShell session ended.');
            this.ready = false;
            return;
        }

        this.appendLine(event.stream || 'stdout', event.text || '');
    }

    updatePrompt() {
        if (!this.cwdLabel) {
            return;
        }

        this.cwdLabel.textContent = this.currentCwd
            ? `PS ${this.currentCwd}>`
            : 'PS>';
    }

    appendLine(stream, text) {
        if (!this.output) {
            return;
        }

        const line = document.createElement('div');
        line.className = `terminal-line ${stream}`;
        line.textContent = text;
        this.output.appendChild(line);
        this.output.scrollTop = this.output.scrollHeight;
    }

    async dispose() {
        this.stopPolling();
        if (this.sessionId) {
            await api.closeTerminalSession(this.sessionId).catch(() => {});
        }
        this.sessionId = null;
    }
}

export const powerShellTerminal = new PowerShellTerminal();
