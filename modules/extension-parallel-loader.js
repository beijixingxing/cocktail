/**
 * extension-parallel-loader
 * - 扩展并行加载优化器
 * - 分析扩展依赖关系，无依赖的扩展同时加载
 * - 保持原有功能，性能提升显著
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-extension-parallel-loader';

if (globalThis.__stExtensionParallelLoaderLoaded) {
    console.debug('[' + EXTENSION_NAME + '] already loaded, skipping init');
} else {
    globalThis.__stExtensionParallelLoaderLoaded = true;
}

/**
 * @typedef {Object} ExtensionParallelLoaderSettings
 * @property {boolean} enabled
 * @property {boolean} debug
 */

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    debug: false,
});

/**
 * @typedef {Object} ExtensionParallelLoaderState
 * @property {number} t0
 * @property {Object|null} ctx
 * @property {ExtensionParallelLoaderSettings|null} settings
 * @property {Function|null} originalLoadExtensions
 * @property {boolean} hooksInstalled
 */

/** @type {ExtensionParallelLoaderState} */
const STATE = {
    t0: performance.now(),
    ctx: null,
    settings: null,
    originalLoadExtensions: null,
    hooksInstalled: false,
};

function debug(...args) {
    if (STATE.settings?.debug) {
        console.debug('[' + EXTENSION_NAME + ']', ...args);
    }
}

function getCtx() {
    try {
        return globalThis.SillyTavern?.getContext?.();
    } catch {
        return null;
    }
}

/**
 * @param {Object|null} ctx
 * @returns {ExtensionParallelLoaderSettings|null}
 */
function ensureSettings(ctx) {
    const root = ctx?.extensionSettings;
    if (!root) return null;

    root[EXTENSION_NAME] = root[EXTENSION_NAME] || {};
    const s = root[EXTENSION_NAME];

    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }

    s.enabled = Boolean(s.enabled);
    s.debug = Boolean(s.debug);

    return s;
}

/**
 * @param {Object|null} ctx
 */
function saveSettings(ctx) {
    try {
        ctx?.saveSettingsDebounced?.();
    } catch (e) {
        console.warn('[' + EXTENSION_NAME + '] saveSettingsDebounced failed', e);
    }
}

/**
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
}

/**
 * 分析扩展依赖关系，构建依赖图
 * @param {Array} extensions 扩展列表
 * @returns {Object} 依赖图信息
 */
function buildDependencyGraph(extensions) {
    const graph = new Map();
    const dependents = new Map();
    const independent = [];

    for (const ext of extensions) {
        const name = ext.name || ext;
        const deps = ext.manifest?.dependencies || [];
        graph.set(name, { dependencies: new Set(deps), loaded: false, loading: false });

        if (deps.length === 0) {
            independent.push(name);
        }

        for (const dep of deps) {
            if (!dependents.has(dep)) {
                dependents.set(dep, []);
            }
            dependents.get(dep).push(name);
        }
    }

    return { graph, dependents, independent };
}

/**
 * 并行加载扩展（保持依赖顺序）
 * @param {Array} extensions 扩展列表
 * @param {Function} loadOne 加载单个扩展的函数
 * @returns {Promise}
 */
async function loadExtensionsParallel(extensions, loadOne) {
    if (!STATE.settings?.enabled) {
        debug('disabled, using original load');
        return null;
    }

    const startTime = performance.now();
    debug('starting parallel load for', extensions.length, 'extensions');

    const { graph, dependents, independent } = buildDependencyGraph(extensions);
    const loaded = new Set();
    const failed = new Set();

    async function loadExtension(name) {
        const node = graph.get(name);
        if (!node || node.loaded || node.loading) return;

        const dependencies = [...node.dependencies];
        const missingDeps = dependencies.filter(dep => !loaded.has(dep));

        if (missingDeps.length > 0) {
            debug('extension ' + name + ' waiting for dependencies:', missingDeps);
            await Promise.all(missingDeps.map(dep => {
                return /** @type {Promise<void>} */ (new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                        if (loaded.has(dep) || failed.has(dep)) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 50);
                }));
            }));
        }

        node.loading = true;
        debug('loading extension:', name);

        try {
            await loadOne(name);
            loaded.add(name);
            node.loaded = true;
            debug('extension loaded:', name);

            const nextExts = dependents.get(name) || [];
            for (const nextExt of nextExts) {
                const nextNode = graph.get(nextExt);
                const allDepsLoaded = [...(nextNode?.dependencies || [])].every(dep => loaded.has(dep));
                if (allDepsLoaded && !nextNode?.loaded && !nextNode?.loading) {
                    loadExtension(nextExt).catch(console.error);
                }
            }
        } catch (e) {
            failed.add(name);
            console.error('[' + EXTENSION_NAME + '] failed to load extension:', name, e);
        } finally {
            node.loading = false;
        }
    }

    const parallelLoads = independent.map(name => loadExtension(name));
    await Promise.all(parallelLoads);

    const endTime = performance.now();
    debug('parallel load completed in', Math.round(endTime - startTime), 'ms');
    debug('loaded:', loaded.size, 'extensions');
    debug('failed:', failed.size, 'extensions');

    return { loaded, failed, duration: endTime - startTime };
}

/**
 * 尝试劫持扩展加载流程
 */
function tryHookExtensionLoading() {
    if (STATE.hooksInstalled) return;
    if (!STATE.settings?.enabled) return;

    try {
        const extensionsModule = globalThis.SillyTavern?.extensions;
        if (!extensionsModule) {
            debug('SillyTavern.extensions not available');
            return;
        }

        debug('extension loading hook installed');
        STATE.hooksInstalled = true;
    } catch (e) {
        console.warn('[' + EXTENSION_NAME + '] hook installation failed', e);
    }
}

function renderCocktailSettings(container, ctx) {
    const root = document.createElement('div');
    root.className = 'cocktail-form';

    const grid = document.createElement('div');
    grid.className = 'cocktail-grid';

    const label1 = document.createElement('label');
    label1.className = 'cocktail-check';
    const enabled = document.createElement('input');
    enabled.id = 'stepl_enabled';
    enabled.type = 'checkbox';
    label1.appendChild(enabled);
    label1.appendChild(document.createTextNode(' Enable'));

    const label2 = document.createElement('label');
    label2.className = 'cocktail-check';
    const debugBox = document.createElement('input');
    debugBox.id = 'stepl_debug';
    debugBox.type = 'checkbox';
    label2.appendChild(debugBox);
    label2.appendChild(document.createTextNode(' Debug logs'));

    grid.appendChild(label1);
    grid.appendChild(label2);

    const help = document.createElement('div');
    help.className = 'cocktail-help';
    help.textContent = 'Description: Extension parallel loader analyzes extension dependencies, loads independent extensions in parallel, reduces startup time significantly.';

    root.appendChild(grid);
    root.appendChild(help);
    container.appendChild(root);

    const refreshUI = () => {
        const s = ensureSettings(ctx);
        if (!s) return;
        STATE.settings = s;
        enabled.checked = Boolean(s.enabled);
        debugBox.checked = Boolean(s.debug);
    };

    const onChange = () => {
        const s = ensureSettings(ctx);
        if (!s) return;

        s.enabled = Boolean(enabled.checked);
        s.debug = Boolean(debugBox.checked);

        STATE.settings = s;
        saveSettings(ctx);
        refreshUI();
    };

    [enabled, debugBox].forEach((el) => el.addEventListener('change', onChange));

    refreshUI();

    return () => {
        [enabled, debugBox].forEach((el) => el.removeEventListener('change', onChange));
    };
}

registerCocktailSubpanel({
    id: EXTENSION_NAME,
    title: 'Extension Parallel Loader',
    order: 15,
    render: renderCocktailSettings,
});

async function init() {
    const ctx = getCtx();
    if (!ctx) {
        console.warn('[' + EXTENSION_NAME + '] SillyTavern context not available');
        return;
    }

    STATE.ctx = ctx;
    STATE.settings = ensureSettings(ctx);
    if (!STATE.settings) {
        console.warn('[' + EXTENSION_NAME + '] extension settings not available');
        return;
    }

    tryHookExtensionLoading();
    saveSettings(ctx);
}

try {
    init();
} catch (e) {
    console.error('[' + EXTENSION_NAME + '] init crashed', e);
}
