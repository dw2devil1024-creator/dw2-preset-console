/**
 * DW2 · Preset Console for TauriTavern
 * Isolated extension. No dependency on the Story Archive plugin.
 * Prompt switches operate on the active PromptManager order; regex switches
 * use TT's own persistence and refresh coordinator.
 */
import { promptManager } from '../../../openai.js';
import { ZHIJIE_GROUPS, ZHIJIE_PROMPT_GROUP_IDS } from './groupMap.js';
import { characters, eventSource, event_types, this_chid } from '../../../../script.js';
import {
    getScriptsByType,
    saveScriptsByType,
    SCRIPT_TYPES,
    getCurrentPresetAPI,
    getCurrentPresetName,
    isScopedScriptsAllowed,
    isPresetScriptsAllowed,
} from '../../regex/engine.js';
import { getRegexRefreshCoordinator } from '../../../tauri/perf/regex-refresh-coordinator.js';

const NS = 'dw2pc';
const ROOT_ID = 'dw2-preset-console';
const STORAGE_KEY = 'dw2.preset.console.v2';
const CATEGORIES = [
    { id: 'groups', label: '分组' },
    { id: 'favs', label: '常用' },
    { id: 'prompts', label: '全部' },
    { id: 'modes', label: '模式' },
    { id: 'regex', label: '正则' },
];
let prefs = loadPreferences();
let tab = 'groups';
let filter = '';
let root, launcher, panel, listArea, searchField, sourceStatus, tabBar;
let open = false;
let working = false;
let lastSignature = '';
let drag = null;
let dragFrame = 0;
let dragTarget = null;

function loadPreferences() {
    try {
        const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return {
            position: data.position && Number.isFinite(data.position.x) && Number.isFinite(data.position.y) ? data.position : null,
            byPreset: data.byPreset && typeof data.byPreset === 'object' ? data.byPreset : {},
        };
    } catch (_) {
        return { position: null, byPreset: {} };
    }
}

function savePreferences() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (_) {}
}

function node(tag, className = '', content = '') {
    const item = document.createElement(tag);
    if (className) item.className = NS + '-' + className;
    if (content) item.textContent = content;
    return item;
}

function button(label, className, onClick, title = '') {
    const item = node('button', className, label);
    item.type = 'button';
    if (title) item.title = title;
    item.addEventListener('click', onClick);
    return item;
}

function toast(msg, kind = 'info') {
    const t = window.toastr;
    if (typeof t?.[kind] === 'function') t[kind](msg, 'DW2 · Control');
    else console[kind === 'error' ? 'error' : 'log']('[DW2 Control] ' + msg);
}

function presetIdentity() {
    const api = getCurrentPresetAPI() || 'unknown-api';
    const preset = getCurrentPresetName() || 'unknown-preset';
    return api + '::' + preset;
}

function presetSettings() {
    const key = presetIdentity();
    const value = prefs.byPreset[key] || (prefs.byPreset[key] = {});
    if (!Array.isArray(value.favorites)) value.favorites = [];
    if (!value.modes || typeof value.modes !== 'object') value.modes = { novel: '', world: '' };
    if (!value.groupCollapsed || typeof value.groupCollapsed !== 'object') value.groupCollapsed = {};
    if (!value.regexCollapsed || typeof value.regexCollapsed !== 'object') value.regexCollapsed = {};
    return value;
}

function presetGroupData() {
    // Group data is part of the actual current preset whenever TT exposes it.
    // For the original 织界 v6.58 we can also map against identifiers in the
    // public, *name-and-ID-only* groupMap.js without publishing prompt bodies.
    const settings = promptManager?.serviceSettings;
    const native = settings?.extensions?.baibaiToolkit?.presetPromptGroups;
    if (Array.isArray(native?.groups) && native?.prompts &&
        typeof native.prompts === 'object') {
        return {
            groups: native.groups.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
            assigned: native.prompts,
        };
    }
    const prompts = settings?.prompts;
    if (!Array.isArray(prompts)) return { groups: [], assigned: {} };
    const overlap = prompts.filter(p => p && ZHIJIE_PROMPT_GROUP_IDS[p.identifier]).length;
    if (overlap < Math.max(3, Math.floor(prompts.length * 0.35))) {
        return { groups: [], assigned: {} };
    }
    const assigned = Object.fromEntries(
        Object.entries(ZHIJIE_PROMPT_GROUP_IDS).map(([id, groupId]) => [id, { groupId }])
    );
    return { groups: ZHIJIE_GROUPS.slice().sort((a,b) => a.order - b.order), assigned };
}

function isProtectedPrompt(item) {
    if (!item) return false;
    const data = presetGroupData();
    const groupName = data.groups.find(g => g.id === item.groupId)?.name || '';
    return /变量初始化.*别动|变量初始化｜别动|Agent系统入口/.test(groupName) ||
        /变量初始化.*别动|Agent System Prompt/.test(item.name);
}

function promptItems() {
    const active = promptManager?.activeCharacter;
    const settings = promptManager?.serviceSettings;
    if (!active || !Array.isArray(settings?.prompts) ||
        typeof promptManager.getPromptOrderForCharacter !== 'function') return [];

    const order = promptManager.getPromptOrderForCharacter(active) || [];
    const promptsById = new Map(settings.prompts.filter(p => p?.identifier).map(p => [p.identifier, p]));
    const names = new Map();
    const groups = presetGroupData();

    return order.filter(p => p?.identifier).map((entry) => {
        const prompt = promptsById.get(entry.identifier);
        if (!prompt) return null;
        const title = String(prompt.name || entry.identifier);
        const occurrence = names.get(title) || 0;
        names.set(title, occurrence + 1);
        return {
            id: entry.identifier,
            name: title,
            key: title + '#' + occurrence,
            enabled: entry.enabled !== false,
            marker: !!prompt.marker,
            system: !!prompt.system_prompt,
            entry,
            groupId: groups.assigned[entry.identifier]?.groupId || null,
        };
    }).filter(Boolean);
}

function regexItems() {
    const all = [];
    const types = [
        [SCRIPT_TYPES.GLOBAL, '全局'],
        [SCRIPT_TYPES.SCOPED, '角色'],
        [SCRIPT_TYPES.PRESET, '预设'],
    ];
    types.forEach(([type, label]) => {
        try {
            const scripts = getScriptsByType(type) || [];
            scripts.forEach((script, index) => {
                if (!script) return;
                all.push({
                    id: String(script.id || index),
                    type, label, script,
                    name: String(script.scriptName || '未命名规则'),
                    enabled: !script.disabled,
                });
            });
        } catch (error) {
            console.warn('[DW2 Control] Unable to read regex source', label, error);
        }
    });
    return all;
}

function findPrompt(key) {
    return promptItems().find(item => item.key === key);
}

async function setPromptStates(changes) {
    const active = promptManager?.activeCharacter;
    if (!active || !changes.length || working) return false;
    const touched = [];
    for (const { id, enabled } of changes) {
        const entry = promptManager.getPromptOrderEntry(active, id);
        if (!entry) throw new Error('预设条目已改变，请刷新后重试');
        touched.push({ entry, original: entry.enabled });
    }
    working = true;
    changes.forEach((change, i) => { touched[i].entry.enabled = change.enabled; });
    try {
        await Promise.resolve(promptManager.saveServiceSettings());
        if (typeof promptManager.renderNowAndRefresh === 'function') {
            promptManager.renderNowAndRefresh();
        }
        return true;
    } catch (error) {
        touched.forEach(item => { item.entry.enabled = item.original; });
        toast('保存预设失败：' + (error.message || error), 'error');
        return false;
    } finally {
        working = false;
        render();
    }
}

async function togglePrompt(item) {
    if (isProtectedPrompt(item)) {
        toast('这条属于受保护的初始化入口，请在 TT 原生预设编辑器中调整', 'warning');
        return;
    }
    try { await setPromptStates([{ id: item.id, enabled: !item.enabled }]); }
    catch (error) { toast(String(error.message || error), 'error'); render(); }
}

async function toggleRegex(item) {
    if (working) return;
    working = true;
    try {
        const scripts = getScriptsByType(item.type);
        const next = scripts.map((s, index) => {
            if ((s.id ? String(s.id) : String(index)) !== item.id) return s;
            return { ...s, disabled: !item.script.disabled };
        });
        await saveScriptsByType(next, item.type);
        getRegexRefreshCoordinator().requestFlush({ debounceMs: 500 });
    } catch (error) {
        toast('保存正则失败：' + (error.message || error), 'error');
    } finally {
        working = false;
        render();
    }
}

function toggleFavorite(item) {
    const settings = presetSettings();
    const index = settings.favorites.indexOf(item.key);
    if (index >= 0) settings.favorites.splice(index, 1);
    else settings.favorites.push(item.key);
    savePreferences();
    render();
}

function getModePrompts() {
    const settings = presetSettings();
    const items = promptItems();
    const world = items.find(item => item.key === settings.modes.world) ||
        items.find(item => item.name.includes('织界｜世界演绎者'));
    const novel = items.find(item => item.key === settings.modes.novel) ||
        items.find(item => item.name.includes('墨团子 · 原创小说家'));
    const addon = items.find(item => item.name.includes('墨团子｜小说叙事增强'));
    return { world, novel, addon };
}

async function activateMode(mode) {
    const { world, novel } = getModePrompts();
    const own = mode === 'world' ? world : novel;
    const other = mode === 'world' ? novel : world;
    if (!own || !other || own.id === other.id) {
        toast('请先绑定两条真实的身份核心条目', 'warning');
        return;
    }
    try {
        if (await setPromptStates([
            { id: own.id, enabled: true },
            { id: other.id, enabled: false },
        ])) toast('已切换到' + (mode === 'novel' ? '墨团子·小说家' : '织界·世界演绎者') + '身份', 'success');
    } catch (error) {
        toast(String(error.message || error), 'error');
        render();
    }
}

function currentSignature() {
    const entries = promptItems();
    let regex = [];
    try { regex = regexItems(); } catch (_) {}
    return JSON.stringify([
        presetIdentity(),
        entries.map(x => [x.id, x.name, x.enabled, x.groupId]),
        regex.map(x => [x.type, x.id, x.name, x.enabled]),
        tab, filter,
    ]);
}

function makeToggle(isOn, action, disabled = false) {
    const b = button(isOn ? 'ON' : 'OFF', 'switch' + (isOn ? ' is-on' : ''), action);
    b.setAttribute('aria-pressed', String(isOn));
    b.disabled = disabled || working;
    return b;
}

function itemRow(item, isPrompt) {
    const row = node('div', 'item');
    const detail = node('div', 'item-detail');
    detail.append(node('div', 'item-name', item.name));
    if (!isPrompt) detail.append(node('div', 'item-source', item.label + '正则'));
    else if (item.marker || item.system) detail.append(node('div', 'item-source', item.marker ? '分隔标记' : '系统条目'));
    row.append(detail);

    if (isPrompt) {
        const settings = presetSettings();
        const protectedItem = isProtectedPrompt(item);
        if (protectedItem) row.classList.add('is-protected');
        const star = button(settings.favorites.includes(item.key) ? '★' : '☆', 'favorite', () => toggleFavorite(item), '加入／移除常用');
        star.setAttribute('aria-label', '收藏 ' + item.name);
        if (protectedItem) row.append(node('span', 'protected', '锁定'));
        else row.append(star, makeToggle(item.enabled, () => togglePrompt(item)));
    } else {
        row.append(makeToggle(item.enabled, () => toggleRegex(item)));
    }
    return row;
}

function heading(label, count = null) {
    const group = node('div', 'group-title', label);
    if (count !== null) group.append(node('span', 'group-count', String(count)));
    return group;
}

function empty(label) { return node('div', 'empty', label); }

function showGroups() {
    const items = promptItems();
    const data = presetGroupData();
    if (!items.length) {
        listArea.append(empty('预设管理器尚未就绪，请先选择 Chat Completion 预设。'));
        return;
    }
    if (!data.groups.length) {
        listArea.append(node('p', 'help', '没有读取到该预设的自定义分组信息，暂按全部条目展示。'));
        showPrompts(false);
        return;
    }
    const settings = presetSettings();
    const claimed = new Set();
    const needle = filter.toLocaleLowerCase();
    for (const group of data.groups) {
        const groupItems = items.filter(x => x.groupId === group.id && x.name.toLocaleLowerCase().includes(needle));
        if (!groupItems.length && filter) continue;
        items.filter(x => x.groupId === group.id).forEach(x => claimed.add(x.id));
        const wrap = node('section', 'group-section');
        const header = button('', 'group-expand', () => {
            const visible = !content.hidden;
            if (visible) {
                content.hidden = true;
                content.replaceChildren(); // Release hundreds of hidden controls
            } else {
                const fresh = promptItems().filter(x => x.groupId === group.id && x.name.toLocaleLowerCase().includes(needle));
                content.replaceChildren(...fresh.map(x => itemRow(x, true)));
                content.hidden = false;
            }
            header.setAttribute('aria-expanded', String(!visible));
            arrow.textContent = visible ? '⌄' : '⌃';
            settings.groupCollapsed[group.id] = visible;
            savePreferences();
        });
        const name = node('span', 'group-heading', group.name);
        const count = node('span', 'group-count', String(groupItems.length));
        const arrow = node('span', 'group-arrow', '⌄');
        header.append(name, count, arrow);
        wrap.append(header);
        const content = node('div', 'group-body');
        const collapsed = !filter && (settings.groupCollapsed[group.id] ?? (typeof group.collapsed === 'boolean' ? group.collapsed : !group.defaultOpen));
        content.hidden = collapsed;
        arrow.textContent = collapsed ? '⌄' : '⌃';
        header.setAttribute('aria-expanded', String(!collapsed));
        if (!collapsed) groupItems.forEach(x => content.append(itemRow(x, true)));
        wrap.append(content);
        listArea.append(wrap);
    }
    const ungrouped = items.filter(x => !claimed.has(x.id) && x.name.toLocaleLowerCase().includes(needle));
    if (ungrouped.length) {
        listArea.append(heading('未分组条目', ungrouped.length));
        ungrouped.forEach(x => listArea.append(itemRow(x, true)));
    }
}

function showPrompts(favoritesOnly) {
    const items = promptItems();
    if (!promptManager?.activeCharacter) {
        listArea.append(empty('预设管理器尚未就绪。请选择 Chat Completion 预设，再刷新页面。'));
        return;
    }
    const settings = presetSettings();
    const visible = items.filter(x =>
        (!favoritesOnly || settings.favorites.includes(x.key)) &&
        x.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
    );
    listArea.append(heading(favoritesOnly ? '我的常用条目' : '当前预设条目', visible.length));
    if (!visible.length) {
        listArea.append(empty(favoritesOnly ? '点击预设条目旁的 ☆，它就会出现在这里。' : '没有找到匹配的预设条目。'));
        return;
    }
    visible.forEach(x => listArea.append(itemRow(x, true)));
}

function modeSelector(mode, label, items) {
    const settings = presetSettings();
    const wrap = node('div', 'mode-field');
    const title = node('label', 'mode-label', label);
    const select = node('select', 'mode-select');
    const blank = node('option', '', '选择对应条目');
    blank.value = '';
    select.append(blank);
    items.forEach(item => {
        const option = node('option', '', item.name);
        option.value = item.key;
        select.append(option);
    });
    select.value = settings.modes[mode] || '';
    select.addEventListener('change', () => {
        settings.modes[mode] = select.value;
        savePreferences();
        render();
    });
    wrap.append(title, select);
    return wrap;
}

function showModes() {
    const items = promptItems();
    listArea.append(heading('双模式快捷切换'));
    const help = node('p', 'help',
        '你的《织界》设定为「身份二选一，小说叙事可叠加」。身份按钮仅切换织界与墨团子，不会关闭独立的小说叙事增强或修改变量初始化。');
    listArea.append(help);
    if (!items.length) { listArea.append(empty('当前还没有可绑定的预设条目。')); return; }
    const { world, novel, addon } = getModePrompts();
    if (!world || !novel) {
        listArea.append(modeSelector('world', '世界演绎身份', items));
        listArea.append(modeSelector('novel', '小说家身份', items));
    } else {
        listArea.append(node('p', 'help', '已识别身份条目：' + world.name + ' / ' + novel.name));
    }
    const controls = node('div', 'mode-actions');
    controls.append(
        button('织界 · 世界演绎', 'mode-button', () => activateMode('world')),
        button('墨团子 · 小说家', 'mode-button', () => activateMode('novel'))
    );
    listArea.append(controls);
    if (addon) {
        listArea.append(heading('小说叙事增强 · 可叠加'));
        listArea.append(itemRow(addon, true));
        listArea.append(node('p', 'help', '这条是独立可选项，即使使用「织界」身份也能开启，不与身份开关互斥。'));
    }
    listArea.append(node('p', 'help', '不同版本可能有不同名称；匹配不到时可手动绑定。切换身份后仍建议检查开关状态。'));
}

function showRegex() {
    const all = regexItems();
    const needle = filter.toLocaleLowerCase();
    const settings = presetSettings();
    const groups = [
        { type: SCRIPT_TYPES.GLOBAL, id: 'global', title: '全局正则', note: '全局生效的正则脚本' },
        { type: SCRIPT_TYPES.PRESET, id: 'preset', title: '预设正则', note: '随当前预设切换的正则脚本' },
        { type: SCRIPT_TYPES.SCOPED, id: 'scoped', title: '局部正则（角色）', note: '属于当前角色的正则脚本' },
    ];
    let any = false;
    for (const group of groups) {
        const matching = all.filter(x => x.type === group.type && x.name.toLocaleLowerCase().includes(needle));
        if (!matching.length && filter) continue;
        any = any || matching.length > 0;
        const expanded = Boolean(filter) || settings.regexCollapsed[group.id] === false;
        const wrap = node('section', 'group-section regex-group');
        const content = node('div', 'group-body');
        content.hidden = !expanded;

        const header = button('', 'group-expand regex-group-expand', () => {
            const isVisible = !content.hidden;
            if (isVisible) {
                content.hidden = true;
                content.replaceChildren(); // Lazy mount on next expand
            } else {
                fillContent();
                content.hidden = false;
            }
            settings.regexCollapsed[group.id] = isVisible;
            header.setAttribute('aria-expanded', String(!isVisible));
            arrow.textContent = isVisible ? '⌄' : '⌃';
            savePreferences();
        });
        const name = node('span', 'group-heading', group.title);
        const count = node('span', 'group-count', matching.filter(x => x.enabled).length + ' / ' + matching.length + ' 已启用');
        const arrow = node('span', 'group-arrow', expanded ? '⌃' : '⌄');
        header.append(name, count, arrow);
        header.setAttribute('aria-expanded', String(expanded));

        function fillContent() {
            const permissionDenied = group.type === SCRIPT_TYPES.SCOPED
                ? !isScopedScriptsAllowed(characters?.[this_chid])
                : group.type === SCRIPT_TYPES.PRESET
                    ? !isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName())
                    : false;
            if (permissionDenied) {
                content.append(node('p', 'help regex-permission', '此来源目前未在 TT 中授权执行正则。单条 ON 不代表实际生效，请先在 TT 正则设置中启用对应来源。'));
            }
            if (!matching.length) content.append(empty('这里还没有正则脚本。'));
            else matching.forEach(item => content.append(itemRow(item, false)));
        }

        wrap.append(header, content);
        if (expanded) fillContent();
        listArea.append(wrap);
    }
    if (!any && filter) listArea.append(empty('没有找到匹配的正则脚本。'));
}

function render() {
    if (!root || !listArea || !open) return;
    sourceStatus.textContent = (getCurrentPresetName() || '未选择预设') + ' · ' + promptItems().length + ' 条';
    tabBar.querySelectorAll('button').forEach(b => {
        b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    searchField.hidden = tab === 'modes';
    if (searchField.value !== filter) searchField.value = filter;
    listArea.replaceChildren();
    if (tab === 'modes') showModes();
    else if (tab === 'regex') showRegex();
    else if (tab === 'groups') showGroups();
    else showPrompts(tab === 'favs');
    lastSignature = currentSignature();
}

function refreshIfChanged() {
    if (!open || working || !root || document.activeElement === searchField ||
        document.activeElement?.classList.contains(NS + '-mode-select')) return;
    const signature = currentSignature();
    if (signature !== lastSignature) render();
}

function placeLauncher() {
    const size = 52;
    const margin = 12;
    const x = prefs.position?.x ?? Math.max(margin, innerWidth - size - 22);
    const y = prefs.position?.y ?? Math.max(margin, innerHeight * 0.56);
    const left = Math.min(Math.max(x, margin), Math.max(margin, innerWidth - size - margin));
    const top = Math.min(Math.max(y, margin), Math.max(margin, innerHeight - size - margin));
    launcher.style.left = left + 'px';
    launcher.style.top = top + 'px';
    return { x: left, y: top };
}

function placePanel() {
    if (!open) return;
    const rect = launcher.getBoundingClientRect();
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let left = rect.left + rect.width - w;
    let top = rect.top - h - 12;
    if (top < 10) top = rect.bottom + 12;
    left = Math.max(10, Math.min(left, innerWidth - w - 10));
    top = Math.max(10, Math.min(top, innerHeight - h - 10));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
}

function showPanel(yes) {
    open = yes;
    root.classList.toggle('is-open', yes);
    launcher.setAttribute('aria-expanded', String(yes));
    panel.hidden = !yes;
    if (yes) {
        render();
        requestAnimationFrame(placePanel);
    }
}

function build() {
    root = node('div', 'root');
    root.id = ROOT_ID;
    launcher = button('✧', 'launcher', e => {
        if (e.detail === 0) showPanel(!open); // keyboard / assistive input
    }, 'DW2 · Control');
    launcher.setAttribute('aria-label', '打开 DW2 预设控制台');
    launcher.setAttribute('aria-expanded', 'false');
    root.append(launcher);

    panel = node('section', 'panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', 'DW2 预设与正则控制台');

    const head = node('header', 'header');
    const headings = node('div', 'heading');
    headings.append(node('div', 'eyebrow', 'DW2 · PRIVATE ATELIER'));
    headings.append(node('div', 'title', 'Preset Console'));
    sourceStatus = node('div', 'source-status');
    headings.append(sourceStatus);
    head.append(headings, button('×', 'close', () => showPanel(false), '关闭'));
    panel.append(head);

    tabBar = node('nav', 'tabs');
    CATEGORIES.forEach(category => {
        const b = button(category.label, 'tab', () => {
            tab = category.id;
            filter = '';
            render();
        });
        b.dataset.tab = category.id;
        tabBar.append(b);
    });
    panel.append(tabBar);

    const search = node('div', 'search-wrap');
    searchField = node('input', 'search');
    searchField.type = 'search';
    searchField.placeholder = '搜索条目或规则…';
    searchField.autocomplete = 'off';
    searchField.addEventListener('input', () => { filter = searchField.value.trim(); render(); });
    search.append(searchField);
    panel.append(search);

    listArea = node('div', 'list');
    panel.append(listArea);

    const foot = node('footer', 'footer');
    foot.append(node('span', '', 'DW2 · CONTROL  /  v0.2.1'));
    foot.append(button('⟳ 同步', 'refresh', () => render(), '重新读取当前状态'));
    panel.append(foot);
    root.append(panel);
    document.body.append(root);

    // Mobile tap should be handled at pointerup rather than waiting for the
    // platform's delayed/suppressed synthetic click. Keyboard/assistive click
    // still works through the button's normal click handler.
    launcher.style.touchAction = 'none';

    function moveLauncher(clientX, clientY) {
        if (!drag) return;
        const dx = clientX - drag.startX;
        const dy = clientY - drag.startY;
        launcher.style.left = Math.max(12, Math.min(drag.left + dx, innerWidth - launcher.offsetWidth - 12)) + 'px';
        launcher.style.top = Math.max(12, Math.min(drag.top + dy, innerHeight - launcher.offsetHeight - 12)) + 'px';
        if (open) placePanel();
    }

    launcher.addEventListener('pointerdown', e => {
        if (e.button !== 0 || drag) return;
        drag = {
            id: e.pointerId,
            startX: e.clientX, startY: e.clientY,
            left: launcher.offsetLeft, top: launcher.offsetTop, moved: false,
        };
        try { launcher.setPointerCapture(e.pointerId); } catch (_) {}
    });
    launcher.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        // 14px tolerates natural finger jitter; a stationary tap still opens.
        if (Math.hypot(dx, dy) >= 14) drag.moved = true;
        if (!drag.moved) return;
        dragTarget = { x: e.clientX, y: e.clientY };
        if (!dragFrame) {
            dragFrame = requestAnimationFrame(() => {
                dragFrame = 0;
                if (drag && dragTarget) moveLauncher(dragTarget.x, dragTarget.y);
            });
        }
    });
    launcher.addEventListener('pointerup', e => {
        if (!drag || e.pointerId !== drag.id) return;
        const didDrag = drag.moved;
        if (dragFrame) cancelAnimationFrame(dragFrame);
        dragFrame = 0;
        if (didDrag) {
            moveLauncher(e.clientX, e.clientY);
            prefs.position = { x: launcher.offsetLeft, y: launcher.offsetTop };
            savePreferences();
        }
        drag = null;
        dragTarget = null;
        if (!didDrag) showPanel(!open);
    });
    launcher.addEventListener('pointercancel', () => {
        if (dragFrame) cancelAnimationFrame(dragFrame);
        dragFrame = 0;
        dragTarget = null;
        drag = null;
    });
    launcher.addEventListener('click', e => {
        // Suppress ordinary pointer-generated click; pointerup has handled it.
        if (e.detail !== 0) e.preventDefault();
    });
    placeLauncher();

    window.addEventListener('resize', () => { placeLauncher(); placePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) showPanel(false); });

    const refreshEvents = [
        event_types?.OAI_PRESET_CHANGED_AFTER, event_types?.CHAT_LOADED,
        event_types?.CHARACTER_EDITED, event_types?.CHATCOMPLETION_MODEL_CHANGED,
    ].filter(Boolean);
    refreshEvents.forEach(type => eventSource.on(type, () => setTimeout(refreshIfChanged, 400)));
    setInterval(refreshIfChanged, 1600);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
else build();
