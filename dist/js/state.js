const MAX_OUTPUT_ENTRIES = 1200;

const DEFAULT_OUTPUT_FILTERS = Object.freeze({
    SYS: true,
    INFO: true,
    ERR: true
});

function cloneFilters(filters) {
    return {
        ...DEFAULT_OUTPUT_FILTERS,
        ...(filters || {})
    };
}

function createTimestamp() {
    return new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function normalizeOutputEntry(entryOrMessage, options = {}) {
    if (typeof entryOrMessage === 'object' && entryOrMessage !== null) {
        return {
            id: entryOrMessage.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            timestamp: entryOrMessage.timestamp || createTimestamp(),
            level: entryOrMessage.level || 'SYS',
            message: entryOrMessage.message || '',
            context: entryOrMessage.context || '',
            details: entryOrMessage.details || ''
        };
    }

    return {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: createTimestamp(),
        level: options.level || (options.isError ? 'ERR' : 'SYS'),
        message: String(entryOrMessage ?? ''),
        context: options.context || '',
        details: options.details || ''
    };
}

class AppState {
    constructor() {
        this._state = {
            currentProject: null,
            currentFile: null,
            openFiles: new Map(),
            activeTab: null,
            fileTree: null,
            output: [],
            outputFilters: cloneFilters(),
            outputView: 'logs',
            outputVisible: true,
            outputHeight: 230,
            runtimeStatus: null,
            problems: []
        };

        this._listeners = new Map();
    }

    subscribe(key, callback) {
        if (!this._listeners.has(key)) {
            this._listeners.set(key, []);
        }

        this._listeners.get(key).push(callback);

        return () => {
            const callbacks = this._listeners.get(key) || [];
            const index = callbacks.indexOf(callback);
            if (index !== -1) {
                callbacks.splice(index, 1);
            }
        };
    }

    _notify(key, value) {
        const callbacks = this._listeners.get(key) || [];
        callbacks.forEach(callback => callback(value));
    }

    get(key) {
        return this._state[key];
    }

    set(key, value) {
        if (this._state[key] === value) {
            return;
        }

        this._state[key] = value;
        this._notify(key, value);
    }

    getOpenFile(path) {
        return this._state.openFiles.get(path);
    }

    setOpenFile(path, data) {
        const old = this._state.openFiles.get(path);
        if (JSON.stringify(old) === JSON.stringify(data)) {
            return;
        }

        this._state.openFiles.set(path, data);
        this._notify('openFiles', this._state.openFiles);
        this._notify(`file:${path}`, data);
    }

    deleteOpenFile(path) {
        if (!this._state.openFiles.delete(path)) {
            return;
        }

        this._notify('openFiles', this._state.openFiles);
    }

    clearOpenFiles() {
        if (this._state.openFiles.size === 0) {
            return;
        }

        this._state.openFiles.clear();
        this._notify('openFiles', this._state.openFiles);
    }

    addOutput(entryOrMessage, options = {}) {
        const entry = normalizeOutputEntry(entryOrMessage, options);
        this._state.output = [...this._state.output, entry].slice(-MAX_OUTPUT_ENTRIES);
        this._notify('output', this._state.output);
    }

    clearOutput() {
        this._state.output = [];
        this._notify('output', this._state.output);
    }

    setOutputFilter(level, visible) {
        const nextFilters = cloneFilters(this._state.outputFilters);
        nextFilters[level] = Boolean(visible);
        this._state.outputFilters = nextFilters;
        this._notify('outputFilters', this._state.outputFilters);
    }

    toggleOutputFilter(level) {
        const current = this._state.outputFilters[level] !== false;
        this.setOutputFilter(level, !current);
    }

    getVisibleOutput() {
        return this._state.output.filter(entry => this._state.outputFilters[entry.level] !== false);
    }

    isOutputFilterEnabled(level) {
        return this._state.outputFilters[level] !== false;
    }
}

export const appState = new AppState();
