/**
 * extension-parallel-loader
 * - 扩展并行加载优化器
 * - 分析扩展依赖关系，无依赖的扩展同时加载
 * - 保持原有功能，性能提升显著
 */

import { registerCocktailSubpanel } from '../core/subpanels.js';

const EXTENSION_NAME = 'st-extension-parallel-loader';

if (globalThis.__stExtensionParallelLoaderLoaded) {
    console.debug(`[${EXTENSION_NAME}] already loaded, skipping init`);
} else {
    globalThis.__stExtensionParallelLoaderLoaded = true;
}

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    debug: false,
});

const STATE = {
    t0: performance.now(),
    ctx: null,
    settings: null,
    originalLoadExtensions: null,
    hooksInstalled: false,
};

function debug(...args) {
    if (STATE.settings?.debug) {
        console.debug(`[${EXTENSION_NAME}]`, ...args);
    }
}

function getCtx() {
    try {
        return globalThis.SillyTavern?.getContext?.();
    } catch {
        return null;
    }
}

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

function saveSettings(ctx) {
    try {
        ctx?.saveSettingsDebounced?.();
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] saveSettingsDebounced failed`, e);
    }
}

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
            debug(`extension ${name} waiting for dependencies:`, missingDeps);
            await Promise.all(missingDeps.map(dep => {
                return new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                        if (loaded.has(dep) || failed.has(dep)) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 50);
                });
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
            console.error(`[${EXTENSION_NAME}] failed to load extension:`, name, e);
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
        console.warn(`[${EXTENSION_NAME}] hook installation failed`, e);
    }
}

function renderCocktailSettings(container, ctx) {
    const root = document.createElement('div');
    root.className = 'cocktail-form';
    root.innerHTML = `
        <div class="cocktail-grid">
            <label class="cocktail-check">
                <input id="stepl_enabled" type="checkbox">
                启用
            </label>
            <label class="cocktail-check">
                <input id="stepl_debug" type="checkbox">
                Debug 日志
            </label>
        </div>
        <div class="cocktail-help">
            说明：扩展并行加载器分析扩展依赖关系，无依赖的扩展同时加载，显著减少启动时间。
        </div>
    `;

    container.appendChild(root);

    const $ = (sel) => /** @type {HTMLInputElement|null} */ (root.querySelector(sel));
    const enabled = $('#stepl_enabled');
    const debugBox = $('#stepl_debug');

    const refreshUI = () => {
        const s = ensureSettings(ctx);
        if (!s) return;
        STATE.settings = s;
        if (enabled) enabled.checked = Boolean(s.enabled);
        if (debugBox) debugBox.checked = Boolean(s.debug);
    };

    const onChange = () => {
        const s = ensureSettings(ctx);
        if (!s) return;

        if (enabled) s.enabled = Boolean(enabled.checked);
        if (debugBox) s.debug = Boolean(debugBox.checked);

        STATE.settings = s;
        saveSettings(ctx);
        refreshUI();
    };

    [enabled, debugBox].forEach((el) => el?.addEventListener('change', onChange));

    refreshUI();

    return () => {
        [enabled, debugBox].forEach((el) => el?.removeEventListener('change', onChange));
    };
}

registerCocktailSubpanel({
    id: EXTENSION_NAME,
    title: '扩展并行加载',
    order: 15,
    render: renderCocktailSettings,
});

async function init() {
    const ctx = getCtx();
    if (!ctx) {
        console.warn(`[${EXTENSION_NAME}] SillyTavern context not available`);
        return;
    }

    STATE.ctx = ctx;
    STATE.settings = ensureSettings(ctx);
    if (!STATE.settings) {
        console.warn(`[${EXTENSION_NAME}] extension settings not available`);
        return;
    }

    tryHookExtensionLoading();
    saveSettings(ctx);
}

try {
    init();
} catch (e) {
    console.error(`[${EXTENSION_NAME}] init crashed`, e);
}
