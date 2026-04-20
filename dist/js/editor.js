import { api } from './tauri.js';
import { appState } from './state.js';
import { logger } from './logger.js';
import { showToast } from './ui.js';
import { formatBytes } from './utils.js';

class EditorWrapper {
    constructor(elementId) {
        this.element = document.getElementById(elementId);
        this.editor = null;
        this.saveTimeout = null;
        this.isApplyingExternalContent = false;
        this.compilerHintShown = false;
    }

    async init() {
        this.editor = CodeMirror.fromTextArea(this.element, {
            lineNumbers: true,
            lineWrapping: false,
            tabSize: 4,
            indentUnit: 4,
            indentWithTabs: false,
            fixedGutter: true,
            electricChars: true,
            mode: 'text/x-csrc',
            theme: 'one-dark',
            autoCloseBrackets: true,
            matchBrackets: true,
            gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
            scrollbarStyle: 'native',
            viewportMargin: Infinity,
            extraKeys: {
                Tab(cm) {
                    if (cm.somethingSelected()) {
                        cm.indentSelection('add');
                    } else {
                        cm.replaceSelection('    ', 'end');
                    }
                },
                'Ctrl-S': () => this.save(),
                'Ctrl-R': () => this.compile(),
                'Ctrl-Z': 'undo',
                'Ctrl-Y': 'redo',
                'Ctrl-F': 'findPersistent',
                'Ctrl-H': 'replace'
            }
        });

        this.editor.on('cursorActivity', () => {
            const cursor = this.editor.getCursor();
            const cursorPos = document.getElementById('cursor-pos');
            if (cursorPos) {
                cursorPos.textContent = `Ln ${cursor.line + 1}, Col ${cursor.ch + 1}`;
            }
        });

        this.editor.on('change', () => {
            this.handleChange();
        });

        setTimeout(() => {
            this.editor.setSize('100%', '100%');
            this.editor.refresh();
            this.updateFileSize();
        }, 100);

        logger.sys('Editor surface initialized.');
        return this.editor;
    }

    handleChange() {
        if (this.isApplyingExternalContent) {
            this.updateFileSize();
            return;
        }

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        const content = this.editor.getValue();
        const currentFile = appState.get('currentFile');
        if (currentFile) {
            const openFile = appState.getOpenFile(currentFile.path);
            if (openFile) {
                const dirty = content !== openFile.savedContent;
                appState.setOpenFile(currentFile.path, {
                    ...openFile,
                    content,
                    dirty
                });
                this.updateTabDirty(currentFile.path, dirty);
            }
        }

        this.saveTimeout = setTimeout(() => {
            this.autoSave().catch(error => {
                logger.err('Auto-save failed.', {
                    details: error?.message || String(error)
                });
            });
        }, 1800);

        this.updateFileSize();
    }

    updateTabDirty(path, dirty) {
        document.querySelectorAll('.tab').forEach(tab => {
            if (tab.dataset.path === path) {
                tab.classList.toggle('dirty', dirty);
            }
        });
    }

    async autoSave() {
        const currentFile = appState.get('currentFile');
        if (!currentFile) {
            return;
        }

        const openFile = appState.getOpenFile(currentFile.path);
        if (!openFile || !openFile.dirty) {
            return;
        }

        await this.saveFile(currentFile.path, { silentToast: true, source: 'auto-save' });
    }

    async save() {
        const currentFile = appState.get('currentFile');
        if (!currentFile) {
            showToast('Open a file before saving.', 'error');
            return;
        }

        await this.saveFile(currentFile.path);
    }

    async saveFile(path, options = {}) {
        const openFile = appState.getOpenFile(path);
        if (!openFile) {
            return;
        }

        const activePath = appState.get('currentFile')?.path;
        const content = path === activePath ? this.editor.getValue() : openFile.content;
        const saveBtn = document.getElementById('save-btn');
        const originalText = saveBtn?.textContent || 'Save';

        if (saveBtn && path === activePath) {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;
        }

        try {
            await api.saveFile(path, content);

            appState.setOpenFile(path, {
                ...openFile,
                content,
                savedContent: content,
                dirty: false,
                viewState: path === activePath ? this.editor.getScrollInfo() : openFile.viewState
            });

            this.updateTabDirty(path, false);
            logger.sys(`Saved ${openFile.file.name}`, {
                context: options.source === 'auto-save' ? 'auto-save' : 'manual save'
            });

            if (!options.silentToast) {
                showToast(`Saved ${openFile.file.name}`, 'success');
            }

            if (path === activePath) {
                await this.checkSyntax(content, openFile.file.name, {
                    reportSuccess: options.source !== 'auto-save'
                });
            }
        } catch (error) {
            logger.err(`Save failed for ${openFile.file.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Save failed: ${error.message}`, 'error');
        } finally {
            if (saveBtn && path === activePath) {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
            }
        }
    }

    async checkSyntax(code, filename = 'current file', options = {}) {
        const runtimeStatus = appState.get('runtimeStatus');
        if (runtimeStatus && !runtimeStatus.compiler_available) {
            if (!this.compilerHintShown && options.reportSuccess !== false) {
                logger.info('Syntax checks are disabled because no C compiler is installed.');
                this.compilerHintShown = true;
            }
            return;
        }

        try {
            const errors = await api.checkSyntax(code);
            this.editor.clearGutter('CodeMirror-lint-markers');

            if (errors && errors.length > 0) {
                errors.forEach(error => {
                    if (error.line < 0 || error.line >= this.editor.lineCount()) {
                        return;
                    }

                    const marker = document.createElement('div');
                    marker.className = 'CodeMirror-lint-marker-error';
                    marker.textContent = '!';
                    marker.title = error.message;
                    this.editor.setGutterMarker(error.line, 'CodeMirror-lint-markers', marker);
                });

                logger.info(`Syntax check found ${errors.length} issue(s) in ${filename}.`);
                return;
            }

            if (options.reportSuccess !== false) {
                logger.info(`Syntax check passed for ${filename}.`);
            }
        } catch (error) {
            logger.err('Syntax check failed.', {
                details: error?.message || String(error)
            });
        }
    }

    setContent(content, language = 'c') {
        this.isApplyingExternalContent = true;
        this.editor.clearGutter('CodeMirror-lint-markers');
        this.editor.setValue(content);
        this.isApplyingExternalContent = false;

        const normalizedLanguage = (language || 'txt').toLowerCase();
        const mode = ['c', 'h'].includes(normalizedLanguage)
            ? 'text/x-csrc'
            : ['cpp', 'cxx', 'cc', 'hpp', 'hh', 'hxx'].includes(normalizedLanguage)
                ? 'text/x-c++src'
                : 'text/plain';

        this.editor.setOption('mode', mode);

        const languageLabel = document.getElementById('file-lang');
        if (languageLabel) {
            languageLabel.textContent = normalizedLanguage.toUpperCase();
        }

        this.updateFileSize();
        setTimeout(() => this.editor.refresh(), 50);
    }

    getContent() {
        return this.editor?.getValue() || '';
    }

    updateFileSize() {
        const fileSize = document.getElementById('file-size');
        if (!fileSize || !this.editor) {
            return;
        }

        fileSize.textContent = formatBytes(new Blob([this.editor.getValue()]).size);
    }

    async compile() {
        const currentFile = appState.get('currentFile');
        if (!currentFile) {
            showToast('Open a file before running.', 'error');
            return;
        }

        const currentOpenFile = appState.getOpenFile(currentFile.path);
        if (currentOpenFile?.dirty) {
            await this.saveFile(currentFile.path, { silentToast: true, source: 'pre-run save' });
        }

        const code = this.editor.getValue();
        const compileBtn = document.getElementById('compile-btn');
        const originalText = compileBtn?.textContent || 'Run';

        if (compileBtn) {
            compileBtn.textContent = 'Running...';
            compileBtn.disabled = true;
        }

        logger.sys(`Running ${currentFile.name}`, {
            context: 'compile and execute'
        });

        try {
            const result = await api.compile(code, currentFile.name);

            if (result.success) {
                logger.info(`${result.compiler || 'Compiler'} finished in ${result.execution_time} ms`, {
                    details: result.output || 'Program completed with no terminal output.'
                });
                showToast('Run completed successfully.', 'success');
            } else {
                logger.err('Compilation failed.', {
                    details: Array.isArray(result.errors) ? result.errors.join('\n\n') : String(result.errors || '')
                });
                showToast('Compilation failed.', 'error');
            }
        } catch (error) {
            const message = error?.message || String(error);
            if (message.includes('No C compiler found')) {
                logger.err('Compilation unavailable on this machine.', {
                    details: message
                });
                showToast('Install GCC, Clang, or TCC to use Run.', 'error');
            } else {
                logger.err('Compilation pipeline crashed.', {
                    details: message
                });
                showToast(`Compilation error: ${message}`, 'error');
            }
        } finally {
            if (compileBtn) {
                compileBtn.textContent = originalText;
                compileBtn.disabled = false;
            }
        }
    }
}

export const editor = new EditorWrapper('editor');
