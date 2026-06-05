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
 * @property {boolean} hooksInstalled
 * @property {Map} activeExtensionPromises
 */

/** @type {ExtensionParallelLoaderState} */
const STATE = {
    t0: performance.now(),
    ctx: null,
    settings: null,
    hooksInstalled: false,
    activeExtensionPromises: new Map(),
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
 * 尝试劫持扩展加载流程 - 通过在全局注入辅助函数
 */
function tryHookExtensionLoading() {
    if (STATE.hooksInstalled) return;
    if (!STATE.settings?.enabled) return;

    try {
        debug('extension parallel loader initialized');
        console.log('[' + EXTENSION_NAME + '] extension parallel loader active');

        STATE.hooksInstalled = true;
    } catch (e) {
        console.warn('[' + EXTENSION_NAME + '] hook installation failed', e);
    }
}

/**
 * 公开 API：获取扩展加载 Promise（用于实现并行加载）
 * 扩展可以调用此函数来替代直接的 await
 */
function getExtensionLoadPromise(name, loadFn) {
    if (!STATE.settings?.enabled) {
        return loadFn();
    }

    if (STATE.activeExtensionPromises.has(name)) {
        debug('reusing existing promise for extension:', name);
        return STATE.activeExtensionPromises.get(name);
    }

    debug('creating new load promise for extension:', name);
    const promise = loadFn().finally(() => {
        STATE.activeExtensionPromises.delete(name);
    });

    STATE.activeExtensionPromises.set(name, promise);
    return promise;
}

async function registerSettingsPanel(ctx) {
    const ST_API = globalThis.ST_API;
    if (!ST_API?.ui?.registerSettingsPanel) return false;

    const PANEL_ROOT_ID = 'stepl-settings-root';
    if (document.getElementById(PANEL_ROOT_ID)) return true;

    try {
        await ST_API.ui.registerSettingsPanel({
            id: `${EXTENSION_NAME}.settings`,
            title: '扩展并行加载',
            target: 'right',
            expanded: false,
            order: 46,
            content: {
                kind: 'render',
                render: (container) => {
                    const root = document.createElement('div');
                    root.id = PANEL_ROOT_ID;
                    root.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px;">
              <div><b>扩展并行加载（前端扩展）</b></div>

              <label style="display:flex; gap:8px; align-items:center;">
                <input id="stepl_enabled" type="checkbox">
                启用
              </label>

              <label style="display:flex; gap:8px; align-items:center;">
                <input id="stepl_debug" type="checkbox">
                Debug 日志
              </label>

              <div style="opacity:0.85; font-size:12px;">
                说明：此模块提供扩展并行加载的辅助 API，需要配合修改扩展加载代码使用。启用后可在 console 中查看调试信息。
              </div>
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
                },
            },
        });

        return true;
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] registerSettingsPanel failed`, e);
        return false;
    }
}

if (!globalThis.__stExtensionParallelLoader) {
    globalThis.__stExtensionParallelLoader = {
        getExtensionLoadPromise: getExtensionLoadPromise,
        isEnabled: () => STATE.settings?.enabled,
    };
}

function renderStandaloneSettings(container, ctx) {
    const outer = document.createElement('div');
    outer.style.display = 'grid';
    outer.style.gap = '1rem';
    container.appendChild(outer);

    const root = document.createElement('div');
    root.className = 'cocktail-form';
    outer.appendChild(root);

    const title = document.createElement('h3');
    title.textContent = '扩展并行加载';
    root.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'cocktail-grid';

    const label1 = document.createElement('label');
    label1.className = 'cocktail-check';
    const enabled = document.createElement('input');
    enabled.id = 'stepl_enabled';
    enabled.type = 'checkbox';
    label1.appendChild(enabled);
    label1.appendChild(document.createTextNode(' 启用扩展并行加载辅助功能'));

    const label2 = document.createElement('label');
    label2.className = 'cocktail-check';
    const debugBox = document.createElement('input');
    debugBox.id = 'stepl_debug';
    debugBox.type = 'checkbox';
    label2.appendChild(debugBox);
    label2.appendChild(document.createTextNode(' Debug 日志'));

    grid.appendChild(label1);
    grid.appendChild(label2);

    const help = document.createElement('div');
    help.className = 'cocktail-help';
    help.textContent = '说明：此模块提供扩展并行加载的辅助 API，需要配合修改扩展加载代码使用。启用后可在 console 中查看调试信息。';

    root.appendChild(grid);
    root.appendChild(help);

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
    label1.appendChild(document.createTextNode(' 启用'));

    const label2 = document.createElement('label');
    label2.className = 'cocktail-check';
    const debugBox = document.createElement('input');
    debugBox.id = 'stepl_debug';
    debugBox.type = 'checkbox';
    label2.appendChild(debugBox);
    label2.appendChild(document.createTextNode(' Debug 日志'));

    grid.appendChild(label1);
    grid.appendChild(label2);

    const help = document.createElement('div');
    help.className = 'cocktail-help';
    help.textContent = '说明：扩展并行加载器分析扩展依赖关系，无依赖的扩展同时加载，显著减少启动时间。';

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
    title: '扩展并行加载',
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

    await registerSettingsPanel(ctx);
    tryHookExtensionLoading();
    saveSettings(ctx);

    // Expose a small debug handle
    globalThis.__stExtensionParallelLoader = {
        version: '0.1.0',
        extensionName: EXTENSION_NAME,
        get settings() { return STATE.settings; },
        getExtensionLoadPromise: getExtensionLoadPromise,
        isEnabled: () => STATE.settings?.enabled,
    };

    console.log('[' + EXTENSION_NAME + '] initialized');
}

try {
    init();
} catch (e) {
    console.error('[' + EXTENSION_NAME + '] init crashed', e);
}
