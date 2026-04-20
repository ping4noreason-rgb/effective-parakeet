import { api } from './tauri.js';
import { appState } from './state.js';
import { editor } from './editor.js';
import { logger } from './logger.js';
import { confirmDialog, promptDialog, showToast } from './ui.js';
import { escapeHtml, validateEntityName } from './utils.js';

class FileTree {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.nodes = new Map();
        this.expanded = new Set();
        this.projectPath = null;
    }

    async loadProject(projectPath, options = {}) {
        this.projectPath = projectPath;
        const files = await api.getFiles(projectPath);

        this.nodes.clear();
        if (!options.preserveExpanded) {
            this.expanded.clear();
        }

        this.render(files);
    }

    render(files, container = this.container, level = 0) {
        if (!container) {
            return;
        }

        if (level === 0) {
            container.innerHTML = '';
        }

        files.forEach(file => {
            const node = this.createNode(file, level);
            container.appendChild(node);

            if (file.is_directory && this.expanded.has(file.path)) {
                this.loadAndRenderChildren(file, node).catch(error => {
                    logger.err(`Unable to expand ${file.name}`, {
                        details: error?.message || String(error)
                    });
                });
            }
        });
    }

    createNode(file, level) {
        const node = document.createElement('div');
        node.className = 'tree-item';
        node.style.paddingLeft = `${14 + level * 18}px`;
        node.dataset.path = file.path;

        const icon = file.is_directory
            ? (this.expanded.has(file.path) ? 'OPEN' : 'DIR')
            : (file.extension || 'FILE').toUpperCase();

        node.innerHTML = `
            <span class="tree-icon">${icon}</span>
            <span class="tree-name">${escapeHtml(file.name)}</span>
        `;

        if (file.is_directory) {
            node.addEventListener('click', async event => {
                event.stopPropagation();
                await this.toggleFolder(file, node);
            });
        } else {
            node.addEventListener('click', async () => {
                await this.openFile(file);
            });
        }

        node.addEventListener('contextmenu', event => {
            event.preventDefault();
            this.showContextMenu(event.clientX, event.clientY, file);
        });

        this.nodes.set(file.path, { element: node, file, level });
        return node;
    }

    async toggleFolder(folder, element) {
        const isExpanded = this.expanded.has(folder.path);

        if (isExpanded) {
            const children = element.nextElementSibling;
            if (children?.classList.contains('tree-children')) {
                children.remove();
            }
            this.expanded.delete(folder.path);
            element.querySelector('.tree-icon').textContent = 'DIR';
            return;
        }

        await this.loadAndRenderChildren(folder, element);
        this.expanded.add(folder.path);
        element.querySelector('.tree-icon').textContent = 'OPEN';
    }

    async loadAndRenderChildren(folder, parentElement) {
        const files = await api.getFiles(folder.path);

        const existing = parentElement.nextElementSibling;
        if (existing?.classList.contains('tree-children')) {
            existing.remove();
        }

        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        const level = (this.nodes.get(folder.path)?.level || 0) + 1;

        if (files.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.style.paddingLeft = `${16 + level * 18}px`;
            empty.textContent = 'Empty folder';
            childrenContainer.appendChild(empty);
        } else {
            this.render(files, childrenContainer, level);
        }

        parentElement.after(childrenContainer);
    }

    async openFile(file) {
        try {
            let openFile = appState.getOpenFile(file.path);

            if (!openFile) {
                const content = await api.getFileContent(file.path);
                openFile = {
                    file,
                    content,
                    savedContent: content,
                    dirty: false,
                    viewState: null
                };
                appState.setOpenFile(file.path, openFile);
            }

            appState.set('currentFile', file);
            appState.set('activeTab', file.path);
            editor.setContent(openFile.content, file.extension || 'c');

            if (openFile.viewState) {
                editor.editor.scrollTo(openFile.viewState.left, openFile.viewState.top);
            }

            this.updateActiveNode(file.path);
            this.updateTabs();
            logger.sys(`Opened ${file.name}`);
        } catch (error) {
            logger.err(`Failed to open ${file.name}`, {
                details: error?.message || String(error)
            });
        }
    }

    updateActiveNode(path) {
        document.querySelectorAll('.tree-item.active').forEach(element => {
            element.classList.remove('active');
        });

        const node = this.nodes.get(path);
        if (node) {
            node.element.classList.add('active');
        }
    }

    updateTabs() {
        const container = document.getElementById('tabs-bar');
        if (!container) {
            return;
        }

        container.innerHTML = '';
        const openFiles = appState.get('openFiles');

        for (const [path, data] of openFiles.entries()) {
            container.appendChild(this.createTab(path, data));
        }

        if (openFiles.size === 0) {
            editor.setContent('', 'txt');
            this.updateActiveNode('');
        }
    }

    createTab(path, data) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab';
        tab.dataset.path = path;

        if (appState.get('activeTab') === path) {
            tab.classList.add('active');
        }

        if (data.dirty) {
            tab.classList.add('dirty');
        }

        tab.innerHTML = `
            <span class="tab-name">${escapeHtml(data.file.name)}</span>
            <span class="tab-close" data-path="${path}" aria-label="Close tab">x</span>
        `;

        tab.addEventListener('click', () => this.switchTab(path));
        tab.querySelector('.tab-close')?.addEventListener('click', event => {
            event.stopPropagation();
            this.closeTab(path).catch(error => {
                logger.err(`Failed to close ${data.file.name}`, {
                    details: error?.message || String(error)
                });
            });
        });

        return tab;
    }

    async switchTab(path) {
        const data = appState.getOpenFile(path);
        if (!data) {
            return;
        }

        const currentFile = appState.get('currentFile');
        if (currentFile) {
            const currentData = appState.getOpenFile(currentFile.path);
            if (currentData) {
                appState.setOpenFile(currentFile.path, {
                    ...currentData,
                    content: editor.getContent(),
                    viewState: editor.editor.getScrollInfo()
                });
            }
        }

        appState.set('currentFile', data.file);
        appState.set('activeTab', path);
        editor.setContent(data.content, data.file.extension || 'c');

        if (data.viewState) {
            editor.editor.scrollTo(data.viewState.left, data.viewState.top);
        }

        this.updateActiveNode(path);
        this.updateTabs();
    }

    async closeTab(path) {
        const data = appState.getOpenFile(path);
        if (!data) {
            return;
        }

        if (data.dirty) {
            const shouldSave = await confirmDialog({
                title: `Save ${data.file.name}?`,
                message: 'This tab has unsaved changes.',
                confirmText: 'Save and close'
            });

            if (shouldSave) {
                await editor.saveFile(path, { silentToast: true, source: 'close-tab save' });
            }
        }

        appState.deleteOpenFile(path);

        const openFiles = appState.get('openFiles');
        if (openFiles.size === 0) {
            appState.set('currentFile', null);
            appState.set('activeTab', null);
        } else if (appState.get('activeTab') === path) {
            const firstPath = openFiles.keys().next().value;
            await this.switchTab(firstPath);
        }

        this.updateTabs();
    }

    async refresh() {
        if (!this.projectPath) {
            return;
        }

        await this.loadProject(this.projectPath, { preserveExpanded: true });
        logger.info('File tree refreshed.');
    }

    showContextMenu(x, y, file) {
        document.querySelector('.context-menu')?.remove();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const items = [
            { label: 'Rename', action: () => this.renameFile(file) },
            { label: 'Delete', action: () => this.deleteFile(file) }
        ];

        if (file.is_directory) {
            items.unshift(
                { label: 'New File', action: () => this.createFileInFolder(file) },
                { label: 'New Folder', action: () => this.createFolderInFolder(file) }
            );
        }

        items.forEach(item => {
            const entry = document.createElement('button');
            entry.type = 'button';
            entry.className = 'context-menu-item';
            entry.textContent = item.label;
            entry.addEventListener('click', async () => {
                menu.remove();
                try {
                    await item.action();
                } catch (error) {
                    logger.err(`Context action failed: ${item.label}`, {
                        details: error?.message || String(error)
                    });
                }
            });
            menu.appendChild(entry);
        });

        document.body.appendChild(menu);
        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
        }, 0);
    }

    async renameFile(file) {
        const newName = await promptDialog({
            title: `Rename ${file.name}`,
            message: 'Choose a new name.',
            label: 'Name',
            placeholder: file.name,
            initialValue: file.name,
            confirmText: 'Rename',
            validate: value => {
                if (value === file.name) {
                    return 'Enter a different name.';
                }
                return validateEntityName(value);
            }
        });

        if (!newName) {
            return;
        }

        try {
            await api.renameFile(file.path, newName);
            await this.refresh();
            logger.sys(`Renamed ${file.name} to ${newName}`);
            showToast(`Renamed to ${newName}`, 'success');
        } catch (error) {
            logger.err(`Rename failed for ${file.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Rename failed: ${error.message}`, 'error');
        }
    }

    async deleteFile(file) {
        const confirmed = await confirmDialog({
            title: `Delete ${file.name}?`,
            message: 'The item will be moved to the recycle bin.',
            confirmText: 'Move to trash',
            tone: 'danger'
        });

        if (!confirmed) {
            return;
        }

        try {
            await api.deleteFile(file.path);
            await this.refresh();

            if (appState.getOpenFile(file.path)) {
                await this.closeTab(file.path);
            }

            logger.sys(`Moved ${file.name} to trash`);
            showToast(`${file.name} moved to trash`, 'success');
        } catch (error) {
            logger.err(`Delete failed for ${file.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Delete failed: ${error.message}`, 'error');
        }
    }

    async createFileInFolder(folder) {
        const name = await promptDialog({
            title: `New file in ${folder.name}`,
            message: 'Create a file inside this folder.',
            label: 'File name',
            placeholder: 'main.c',
            confirmText: 'Create file',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        try {
            await api.createFile(folder.path, name);
            await this.refresh();
            logger.sys(`Created ${name}`, {
                context: folder.name
            });
            showToast(`${name} created`, 'success');
        } catch (error) {
            logger.err(`Create failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }

    async createFolderInFolder(folder) {
        const name = await promptDialog({
            title: `New folder in ${folder.name}`,
            message: 'Create a folder inside this workspace.',
            label: 'Folder name',
            placeholder: 'include',
            confirmText: 'Create folder',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        try {
            await api.createFolder(folder.path, name);
            await this.refresh();
            logger.sys(`Created folder ${name}`, {
                context: folder.name
            });
            showToast(`${name} created`, 'success');
        } catch (error) {
            logger.err(`Create failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }
}

export const fileTree = new FileTree('file-tree');
