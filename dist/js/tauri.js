import { logger } from './logger.js';

let invoke = null;
let tauriConnected = false;

const mockState = {
    projects: [],
    files: new Map(),
    contents: new Map(),
    terminalSessionId: 'mock-terminal',
    terminalOutput: [],
    terminalCwd: 'C:/mock'
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createMockFile(path, name, isDirectory = false) {
    return {
        name,
        path,
        size: isDirectory ? 0 : (mockState.contents.get(path)?.length || 0),
        is_directory: isDirectory,
        modified: new Date().toLocaleString(),
        extension: isDirectory ? null : name.split('.').pop() || null
    };
}

function getParentPath(path) {
    const normalized = String(path || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function ensureMockFolder(path) {
    if (!mockState.files.has(path)) {
        mockState.files.set(path, []);
    }
}

function addMockChild(parentPath, file) {
    ensureMockFolder(parentPath);
    const siblings = mockState.files.get(parentPath) || [];
    if (!siblings.some(entry => entry.path === file.path)) {
        siblings.push(file);
        siblings.sort((a, b) => {
            if (a.is_directory !== b.is_directory) {
                return a.is_directory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        mockState.files.set(parentPath, siblings);
    }
}

function buildMockProject(name) {
    const projectPath = `mock/${name}`;
    const mainPath = `${projectPath}/main.c`;
    const readmePath = `${projectPath}/README.md`;
    const now = new Date().toLocaleString();

    const project = {
        name,
        path: projectPath,
        created: now,
        modified: now,
        file_count: 2
    };

    const mainFile = createMockFile(mainPath, 'main.c');
    const readmeFile = createMockFile(readmePath, 'README.md');

    mockState.contents.set(
        mainPath,
        '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from Cat Editor!\\n");\n    return 0;\n}\n'
    );
    mockState.contents.set(
        readmePath,
        `# ${name}\n\nProject scaffold created in web preview mode.\n`
    );
    mockState.projects.push(project);
    mockState.projects.sort((a, b) => a.name.localeCompare(b.name));
    mockState.files.set(projectPath, [mainFile, readmeFile]);

    return project;
}

function pushMockTerminal(stream, text, extra = {}) {
    mockState.terminalOutput.push({
        stream,
        text,
        kind: extra.kind || null,
        cwd: extra.cwd || null
    });
}

async function mockInvoke(cmd, args = {}) {
    switch (cmd) {
        case 'get_projects':
            return [...mockState.projects];

        case 'create_project':
            return buildMockProject(args.name);

        case 'get_files':
            return [...(mockState.files.get(args.path) || [])];

        case 'get_file_content':
            return mockState.contents.get(args.path) || '';

        case 'save_file':
            mockState.contents.set(args.path, args.content);
            return null;

        case 'create_file': {
            const path = `${args.parentPath}/${args.name}`.replace(/\\/g, '/');
            const file = createMockFile(path, args.name);
            mockState.contents.set(path, args.name.endsWith('.md') ? '' : '/* Mock file */\n');
            addMockChild(args.parentPath.replace(/\\/g, '/'), file);
            return file;
        }

        case 'create_folder': {
            const path = `${args.parentPath}/${args.name}`.replace(/\\/g, '/');
            const folder = createMockFile(path, args.name, true);
            ensureMockFolder(path);
            addMockChild(args.parentPath.replace(/\\/g, '/'), folder);
            return folder;
        }

        case 'delete_file_safe': {
            const parent = getParentPath(args.path);
            mockState.contents.delete(args.path);
            mockState.files.delete(args.path);
            if (mockState.files.has(parent)) {
                mockState.files.set(
                    parent,
                    (mockState.files.get(parent) || []).filter(entry => entry.path !== args.path)
                );
            }
            return null;
        }

        case 'rename_file': {
            const parent = getParentPath(args.path);
            const siblings = mockState.files.get(parent) || [];
            const target = siblings.find(entry => entry.path === args.path);
            if (!target) {
                throw new Error('Mock file not found');
            }
            target.name = args.newName;
            target.path = `${parent}/${args.newName}`;
            return null;
        }

        case 'compile_code':
            return {
                success: true,
                output: 'Mock run completed.',
                execution_time: 42,
                compiler: 'mock',
                errors: []
            };

        case 'check_syntax':
            return [];

        case 'get_system_info':
            return {
                ram_used: 2 * 1024 * 1024 * 1024,
                ram_total: 8 * 1024 * 1024 * 1024,
                cpu_usage: 12
            };

        case 'get_runtime_status':
            return {
                compiler_available: true,
                compiler_label: 'mock',
                project_roots: ['mock']
            };

        case 'create_terminal_session':
            pushMockTerminal('meta', 'Windows PowerShell ready.', {
                kind: 'ready',
                cwd: mockState.terminalCwd
            });
            return {
                session_id: mockState.terminalSessionId,
                shell: 'Windows PowerShell',
                cwd: mockState.terminalCwd
            };

        case 'execute_terminal_command':
            pushMockTerminal('stdout', `Executed: ${args.input}`);
            pushMockTerminal('meta', `Working directory: ${mockState.terminalCwd}`, {
                kind: 'cwd',
                cwd: mockState.terminalCwd
            });
            return null;

        case 'set_terminal_cwd':
            mockState.terminalCwd = args.path.replace(/\\/g, '/');
            pushMockTerminal('meta', `Working directory: ${mockState.terminalCwd}`, {
                kind: 'cwd',
                cwd: mockState.terminalCwd
            });
            return mockState.terminalCwd;

        case 'drain_terminal_output': {
            const output = [...mockState.terminalOutput];
            mockState.terminalOutput = [];
            return output;
        }

        case 'close_terminal_session':
            pushMockTerminal('meta', 'PowerShell session ended.', {
                kind: 'session-ended'
            });
            return null;

        case 'window_minimize':
        case 'window_close':
            return null;

        case 'window_toggle_maximize':
            return true;

        case 'window_is_maximized':
            return false;

        default:
            return null;
    }
}

async function waitForTauri(maxAttempts = 50, delayMs = 100) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (window.__TAURI__) {
            return window.__TAURI__;
        }
        await sleep(delayMs);
    }

    return null;
}

export async function initTauri() {
    const tauri = await waitForTauri();

    if (tauri) {
        invoke = tauri.core?.invoke || tauri.invoke || null;

        if (invoke) {
            tauriConnected = true;
            logger.sys('Native Tauri bridge connected.');
            return true;
        }
    }

    invoke = mockInvoke;
    logger.err('Tauri bridge is unavailable. Running in fallback web mode.');
    return false;
}

async function safeInvoke(cmd, args = {}) {
    if (!invoke) {
        throw new Error('Tauri bridge has not been initialized');
    }

    try {
        return await invoke(cmd, args);
    } catch (error) {
        const message = typeof error === 'string'
            ? error
            : error?.message || JSON.stringify(error);

        console.error(
            `[ERR] Command failed: ${cmd}`,
            tauriConnected ? 'native command error' : 'fallback command error',
            message
        );

        throw new Error(message);
    }
}

export function getWindow() {
    return null;
}

export function isNativeTauri() {
    return tauriConnected;
}

export const api = {
    async getProjects() { return await safeInvoke('get_projects'); },
    async createProject(name) { return await safeInvoke('create_project', { name }); },
    async getFiles(path) { return await safeInvoke('get_files', { path }); },
    async getFileContent(path) { return await safeInvoke('get_file_content', { path }); },
    async saveFile(path, content) { return await safeInvoke('save_file', { path, content }); },
    async createFile(parentPath, name) { return await safeInvoke('create_file', { parentPath, name }); },
    async createFolder(parentPath, name) { return await safeInvoke('create_folder', { parentPath, name }); },
    async deleteFile(path) { return await safeInvoke('delete_file_safe', { path }); },
    async renameFile(path, newName) { return await safeInvoke('rename_file', { path, newName }); },
    async compile(code, filename) { return await safeInvoke('compile_code', { code, filename }); },
    async checkSyntax(code) { return await safeInvoke('check_syntax', { code }); },
    async getSystemInfo() { return await safeInvoke('get_system_info'); },
    async getRuntimeStatus() { return await safeInvoke('get_runtime_status'); },
    async createTerminalSession(initialCwd) { return await safeInvoke('create_terminal_session', { initialCwd }); },
    async executeTerminalCommand(sessionId, input) { return await safeInvoke('execute_terminal_command', { sessionId, input }); },
    async setTerminalCwd(sessionId, path) { return await safeInvoke('set_terminal_cwd', { sessionId, path }); },
    async drainTerminalOutput(sessionId) { return await safeInvoke('drain_terminal_output', { sessionId }); },
    async closeTerminalSession(sessionId) { return await safeInvoke('close_terminal_session', { sessionId }); },
    async minimizeWindow() { return await safeInvoke('window_minimize'); },
    async toggleMaximizeWindow() { return await safeInvoke('window_toggle_maximize'); },
    async isMaximizedWindow() { return await safeInvoke('window_is_maximized'); },
    async closeWindow() { return await safeInvoke('window_close'); }
};
