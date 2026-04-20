import { initTauri, api, isNativeTauri } from './tauri.js';
import { appState } from './state.js';
import { editor } from './editor.js';
import { fileTree } from './fileTree.js';
import { logger } from './logger.js';
import { powerShellTerminal } from './terminal.js';
import { promptDialog, showToast } from './ui.js';
import { escapeHtml, validateEntityName } from './utils.js';

const DEFAULT_OUTPUT_HEIGHT = 260;
const MIN_OUTPUT_HEIGHT = 180;
const MAX_OUTPUT_HEIGHT_RATIO = 0.65;

class App {
    constructor() {
        this.monitorInterval = null;
        this.monitorFailed = false;
        this.theme = 'dark';
        this.outputResizing = false;
        this.init();
    }

    async init() {
        this.initTheme();
        this.initOutputState();

        await initTauri();
        await this.initRuntimeStatus();
        await editor.init();

        this.setupEvents();
        this.subscribeToState();
        await this.setupWindowControls();
        await powerShellTerminal.init();
        await this.loadProjects();

        fileTree.updateTabs();
        this.renderOutput();
        this.syncOutputFilters();
        this.syncOutputVisibility();
        this.syncOutputView();
        this.applyOutputHeight();
        this.updateEditorEmptyState();
        this.updateWorkspaceLabels();
        await this.startSystemMonitor();

        logger.sys('Cat Editor is ready.');
        logger.info('Shortcuts: Ctrl+S saves the current file, Ctrl+R runs it.');
    }

    initOutputState() {
        const savedView = localStorage.getItem('cat-editor-output-view');
        const savedHeight = Number(localStorage.getItem('cat-editor-output-height'));

        if (savedView === 'terminal' || savedView === 'logs') {
            appState.set('outputView', savedView);
        }

        if (Number.isFinite(savedHeight) && savedHeight >= MIN_OUTPUT_HEIGHT) {
            appState.set('outputHeight', savedHeight);
        } else {
            appState.set('outputHeight', DEFAULT_OUTPUT_HEIGHT);
        }
    }

    async initRuntimeStatus() {
        try {
            const runtimeStatus = await api.getRuntimeStatus();
            appState.set('runtimeStatus', runtimeStatus);

            if (runtimeStatus?.project_roots?.length) {
                logger.info('Project storage ready.', {
                    context: runtimeStatus.project_roots.join(' | ')
                });
            }

            if (runtimeStatus?.compiler_available) {
                logger.info(`Compiler detected: ${runtimeStatus.compiler_label}`);
            } else {
                logger.info('No C compiler detected. Run/Syntax checks are limited until GCC, Clang, or TCC is installed.');
            }
        } catch (error) {
            logger.err('Failed to load runtime status.', {
                details: error?.message || String(error)
            });
        }
    }

    setupEvents() {
        this.bindButton('save-btn', () => editor.save());
        this.bindButton('compile-btn', () => editor.compile());
        this.bindButton('new-project-btn', () => this.createProject());
        this.bindButton('empty-new-project-btn', () => this.createProject());
        this.bindButton('new-file-btn', () => this.createNewFile());
        this.bindButton('empty-new-file-btn', () => this.createNewFile());
        this.bindButton('refresh-files-btn', () => fileTree.refresh());
        this.bindButton('toggle-output-btn', () => this.toggleOutput());
        this.bindButton('clear-output-btn', () => appState.clearOutput());
        this.bindButton('theme-toggle-btn', () => this.toggleTheme());

        document.querySelectorAll('[data-log-filter]').forEach(button => {
            button.addEventListener('click', () => {
                const filter = button.dataset.logFilter;
                appState.toggleOutputFilter(filter);
            });
        });

        document.querySelectorAll('[data-output-view]').forEach(button => {
            button.addEventListener('click', () => {
                const view = button.dataset.outputView;
                if (view === 'logs' || view === 'terminal') {
                    appState.set('outputView', view);
                }
            });
        });

        this.setupOutputResize();

        window.addEventListener('keydown', event => {
            if (event.ctrlKey && event.key.toLowerCase() === 's') {
                event.preventDefault();
                editor.save().catch(error => {
                    logger.err('Save shortcut failed.', {
                        details: error?.message || String(error)
                    });
                });
            }

            if (event.ctrlKey && event.key.toLowerCase() === 'r') {
                event.preventDefault();
                editor.compile().catch(error => {
                    logger.err('Run shortcut failed.', {
                        details: error?.message || String(error)
                    });
                });
            }
        });

        window.addEventListener('beforeunload', event => {
            const hasDirtyFiles = [...appState.get('openFiles').values()].some(file => file.dirty);
            if (!hasDirtyFiles) {
                return;
            }

            event.preventDefault();
            event.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        });

        window.addEventListener('unload', () => {
            powerShellTerminal.dispose().catch(() => {});
        });
    }

    setupOutputResize() {
        const resizer = document.getElementById('output-resizer');
        const panel = document.getElementById('output-panel');
        if (!resizer || !panel) {
            return;
        }

        let startY = 0;
        let startHeight = 0;

        const onPointerMove = event => {
            if (!this.outputResizing) {
                return;
            }

            const delta = startY - event.clientY;
            const maxHeight = Math.round(window.innerHeight * MAX_OUTPUT_HEIGHT_RATIO);
            const nextHeight = Math.max(
                MIN_OUTPUT_HEIGHT,
                Math.min(maxHeight, startHeight + delta)
            );
            appState.set('outputHeight', nextHeight);
        };

        const stopResize = () => {
            if (!this.outputResizing) {
                return;
            }

            this.outputResizing = false;
            document.body.classList.remove('is-resizing-terminal');
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', stopResize);
        };

        resizer.addEventListener('pointerdown', event => {
            event.preventDefault();
            this.outputResizing = true;
            startY = event.clientY;
            startHeight = panel.getBoundingClientRect().height;
            document.body.classList.add('is-resizing-terminal');
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', stopResize);
        });
    }

    bindButton(id, handler) {
        document.getElementById(id)?.addEventListener('click', () => {
            Promise.resolve(handler()).catch(error => {
                logger.err(`Action failed: ${id}`, {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Action failed', 'error');
            });
        });
    }

    subscribeToState() {
        appState.subscribe('output', () => this.renderOutput());
        appState.subscribe('outputFilters', () => {
            this.syncOutputFilters();
            this.renderOutput();
        });
        appState.subscribe('outputVisible', () => this.syncOutputVisibility());
        appState.subscribe('outputView', view => {
            localStorage.setItem('cat-editor-output-view', view);
            this.syncOutputView();
        });
        appState.subscribe('outputHeight', height => {
            localStorage.setItem('cat-editor-output-height', String(height));
            this.applyOutputHeight();
        });
        appState.subscribe('openFiles', () => {
            fileTree.updateTabs();
            this.updateEditorEmptyState();
        });
        appState.subscribe('currentFile', file => {
            const activeFileLabel = document.getElementById('active-file-label');
            if (activeFileLabel) {
                activeFileLabel.textContent = file?.name || 'No file selected';
            }
            this.updateEditorEmptyState();
        });
        appState.subscribe('currentProject', project => {
            this.updateWorkspaceLabels();
        });
    }

    async loadProjects() {
        try {
            const projects = await api.getProjects();
            const container = document.getElementById('project-list');
            const currentProject = appState.get('currentProject');
            const projectCount = document.getElementById('project-count');

            if (projectCount) {
                projectCount.textContent = String(projects.length);
            }

            if (!container) {
                return;
            }

            if (!projects || projects.length === 0) {
                logger.info('No saved projects found. Create one to initialize the workspace list.');
                container.innerHTML = `
                    <div class="empty-card">
                        <strong>No projects found.</strong>
                        <p>Create the first project and it will stay available across launches.</p>
                        <button id="create-first-project" class="primary-btn" type="button">Create Project</button>
                    </div>
                `;

                document.getElementById('create-first-project')?.addEventListener('click', () => {
                    this.createProject().catch(error => {
                        logger.err('Project creation dialog failed.', {
                            details: error?.message || String(error)
                        });
                    });
                });
                return;
            }

            logger.info(`Loaded ${projects.length} project(s).`);
            container.innerHTML = '';

            projects.forEach(project => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'project-item';
                item.dataset.path = project.path;

                if (currentProject?.path === project.path) {
                    item.classList.add('active');
                }

                item.innerHTML = `
                    <div class="project-main">
                        <span class="project-badge">PRJ</span>
                        <span class="project-name">${escapeHtml(project.name)}</span>
                    </div>
                    <span class="project-meta">${project.file_count || 0} files</span>
                `;

                item.addEventListener('click', () => {
                    this.openProject(project).catch(error => {
                        logger.err(`Unable to open ${project.name}`, {
                            details: error?.message || String(error)
                        });
                    });
                });

                container.appendChild(item);
            });

            this.markActiveProject(currentProject?.path || '');
        } catch (error) {
            logger.err('Failed to load project list.', {
                details: error?.message || String(error)
            });
        }
    }

    async openProject(project) {
        appState.clearOpenFiles();
        appState.set('currentFile', null);
        appState.set('activeTab', null);
        appState.set('currentProject', project);

        await fileTree.loadProject(project.path);
        this.markActiveProject(project.path);
        this.updateWorkspaceLabels();
        await powerShellTerminal.setWorkingDirectory(project.path).catch(() => {});

        logger.sys(`Opened workspace ${project.name}`, {
            context: `${project.file_count || 0} files detected`
        });
        showToast(`${project.name} opened`, 'success');
    }

    async createProject() {
        const name = await promptDialog({
            title: 'Create Project',
            message: 'Give the new workspace a name. The editor will create a starter scaffold for you.',
            label: 'Project name',
            placeholder: 'hello-world',
            confirmText: 'Create project',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        logger.sys(`Creating project ${name}`);

        try {
            let project = await api.createProject(name);
            project = await this.ensureProjectScaffold(project || { name });

            await this.loadProjects();
            await this.openProject(project);

            logger.info(`Project ready: ${name}`, {
                context: 'starter files created'
            });
            showToast(`Project ${name} created`, 'success');
        } catch (error) {
            logger.err(`Project creation failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }

    async ensureProjectScaffold(project) {
        if (!project?.path) {
            return project;
        }

        const files = await api.getFiles(project.path);
        if (Array.isArray(files) && files.length > 0) {
            return project;
        }

        logger.info(`Project ${project.name} was empty. Rebuilding starter scaffold.`);

        await api.createFile(project.path, 'main.c');
        await api.createFile(project.path, 'README.md');

        const updatedFiles = await api.getFiles(project.path);
        return {
            ...project,
            file_count: updatedFiles.length
        };
    }

    async createNewFile() {
        const currentProject = appState.get('currentProject');
        if (!currentProject) {
            showToast('Open a workspace before creating files.', 'error');
            return;
        }

        const name = await promptDialog({
            title: 'Create File',
            message: `Add a new file inside ${currentProject.name}.`,
            label: 'File name',
            placeholder: 'main.c',
            confirmText: 'Create file',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        try {
            const file = await api.createFile(currentProject.path, name);
            await fileTree.refresh();
            await fileTree.openFile(file);
            logger.sys(`Created ${name}`, {
                context: currentProject.name
            });
            showToast(`${name} created`, 'success');
        } catch (error) {
            logger.err(`Create failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }

    toggleOutput() {
        appState.set('outputVisible', !appState.get('outputVisible'));
    }

    markActiveProject(path) {
        document.querySelectorAll('.project-item').forEach(item => {
            item.classList.toggle('active', item.dataset.path === path);
        });
    }

    renderOutput() {
        const container = document.getElementById('output-content');
        if (!container) {
            return;
        }

        const output = appState.getVisibleOutput();
        container.innerHTML = '';

        if (output.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'terminal-empty';
            empty.innerHTML = `
                <strong>No visible logs right now.</strong>
                <p>Run an action or re-enable filtered log groups.</p>
            `;
            container.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();

        output.forEach(entry => {
            const row = document.createElement('div');
            row.className = `output-line level-${entry.level.toLowerCase()}`;

            const badge = document.createElement('span');
            badge.className = 'output-badge';
            badge.textContent = `[${entry.level}]`;

            const content = document.createElement('div');
            content.className = 'output-body';

            const head = document.createElement('div');
            head.className = 'output-head';

            const message = document.createElement('span');
            message.className = 'output-message';
            message.textContent = entry.message;

            const time = document.createElement('span');
            time.className = 'output-time';
            time.textContent = entry.timestamp;

            head.append(message, time);
            content.appendChild(head);

            if (entry.context) {
                const context = document.createElement('div');
                context.className = 'output-context';
                context.textContent = entry.context;
                content.appendChild(context);
            }

            if (entry.details) {
                const details = document.createElement('pre');
                details.className = 'output-details';
                details.textContent = entry.details;
                content.appendChild(details);
            }

            row.append(badge, content);
            fragment.appendChild(row);
        });

        container.appendChild(fragment);
        container.scrollTop = container.scrollHeight;
    }

    syncOutputFilters() {
        document.querySelectorAll('[data-log-filter]').forEach(button => {
            const filter = button.dataset.logFilter;
            button.classList.toggle('active', appState.isOutputFilterEnabled(filter));
        });
    }

    syncOutputVisibility() {
        const isVisible = appState.get('outputVisible');
        document.getElementById('output-panel')?.classList.toggle('hidden', !isVisible);

        const toggleButton = document.getElementById('toggle-output-btn');
        if (toggleButton) {
            toggleButton.textContent = isVisible ? 'Hide Output' : 'Show Output';
        }
    }

    syncOutputView() {
        const view = appState.get('outputView');

        document.querySelectorAll('[data-output-view]').forEach(button => {
            button.classList.toggle('active', button.dataset.outputView === view);
        });

        document.querySelectorAll('[data-panel-view]').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panelView === view);
        });

        document.querySelectorAll('[data-panel-actions]').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panelActions === view);
        });
    }

    applyOutputHeight() {
        const panel = document.getElementById('output-panel');
        if (!panel) {
            return;
        }

        panel.style.height = `${appState.get('outputHeight') || DEFAULT_OUTPUT_HEIGHT}px`;
    }

    updateEditorEmptyState() {
        const hasOpenFile = Boolean(appState.get('currentFile'));
        document.getElementById('editor-empty-state')?.classList.toggle('hidden', hasOpenFile);
        document.querySelector('.editor-stage')?.classList.toggle('is-empty', !hasOpenFile);
    }

    updateWorkspaceLabels() {
        const project = appState.get('currentProject');
        const projectName = project?.name || 'No workspace selected';

        const workspaceName = document.getElementById('workspace-name');
        const activeProjectLabel = document.getElementById('active-project-label');
        const statusProject = document.getElementById('status-project');

        if (workspaceName) {
            workspaceName.textContent = projectName;
        }

        if (activeProjectLabel) {
            activeProjectLabel.textContent = projectName === 'No workspace selected'
                ? 'Select a workspace to begin'
                : projectName;
        }

        if (statusProject) {
            statusProject.textContent = project ? `Project: ${project.name}` : 'No project';
        }
    }

    initTheme() {
        const storedTheme = localStorage.getItem('cat-editor-theme');
        this.theme = storedTheme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', this.theme);
        this.syncThemeToggle();
    }

    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', this.theme);
        localStorage.setItem('cat-editor-theme', this.theme);
        this.syncThemeToggle();
        logger.info(`Theme switched to ${this.theme}.`);
    }

    syncThemeToggle() {
        const button = document.getElementById('theme-toggle-btn');
        if (!button) {
            return;
        }

        const isLight = this.theme === 'light';
        button.textContent = isLight ? 'Dark' : 'Light';
        button.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
        button.setAttribute('aria-label', button.title);
    }

    async setupWindowControls() {
        if (!isNativeTauri()) {
            document.body.classList.add('web-mode');
            logger.info('Native window controls are unavailable outside Tauri.');
            return;
        }

        this.bindButton('minimize-btn', () => api.minimizeWindow());
        this.bindButton('maximize-btn', () => this.toggleMaximize());
        this.bindButton('close-btn', () => api.closeWindow());

        await this.syncMaximizeButton();
    }

    async toggleMaximize() {
        try {
            await api.toggleMaximizeWindow();
            await this.syncMaximizeButton();
        } catch (error) {
            logger.err('Window maximize toggle failed.', {
                details: error?.message || String(error)
            });
            showToast('Unable to resize the window.', 'error');
        }
    }

    async syncMaximizeButton() {
        const button = document.getElementById('maximize-btn');
        if (!button || !isNativeTauri()) {
            return;
        }

        try {
            const maximized = await api.isMaximizedWindow();
            button.classList.toggle('is-active', Boolean(maximized));
            button.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
            button.title = maximized ? 'Restore' : 'Maximize';
        } catch (error) {
            logger.err('Failed to sync maximize state.', {
                details: error?.message || String(error)
            });
        }
    }

    async startSystemMonitor() {
        const update = async () => {
            try {
                const info = await api.getSystemInfo();
                const metrics = document.getElementById('system-metrics');
                if (!info || !metrics) {
                    return;
                }

                const ramUsedGB = ((info.ram_used || 0) / 1024 / 1024 / 1024).toFixed(1);
                const ramTotalGB = ((info.ram_total || 0) / 1024 / 1024 / 1024).toFixed(1);
                const diskUsedGB = ((info.disk_used || 0) / 1024 / 1024 / 1024).toFixed(0);
                const diskTotalGB = ((info.disk_total || 0) / 1024 / 1024 / 1024).toFixed(0);
                metrics.textContent = `RAM ${ramUsedGB}/${ramTotalGB} GB | CPU ${Math.round(info.cpu_usage || 0)}% | Disk ${diskUsedGB}/${diskTotalGB} GB`;
                this.monitorFailed = false;
            } catch (error) {
                if (!this.monitorFailed) {
                    logger.err('System monitor update failed.', {
                        details: error?.message || String(error)
                    });
                }
                this.monitorFailed = true;
            }
        };

        await update();
        this.monitorInterval = setInterval(() => {
            update().catch(error => {
                logger.err('System monitor crashed.', {
                    details: error?.message || String(error)
                });
            });
        }, 10000);
    }
}

new App();
