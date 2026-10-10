/**
 * DW2 · Preset Console for TauriTavern
 * Credits: S.A. · DW2
 * Isolated extension. No dependency on the Story Archive plugin.
 * Prompt switches operate on the active PromptManager order; regex switches
 * use TT's own persistence and refresh coordinator.
 */
import { promptManager } from '../../../openai.js';
import { extension_settings, extensionTypes, openThirdPartyExtensionMenu } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { ZHIJIE_GROUPS, ZHIJIE_PROMPT_GROUP_IDS } from './groupMap.js';
import { createQuickStudio } from './quickStudio.js';
import { characters, eventSource, event_types, this_chid, getRequestHeaders } from '../../../../script.js';
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
const SETTINGS_ID = 'dw2-preset-console-settings';
const VERSION = '0.4.7';
const STORAGE_KEY = 'dw2.preset.console.v2';
const CATEGORIES = [
    { id: 'quick', label: '快捷' },
    { id: 'all', label: '全部' },
    { id: 'favs', label: '常用' },
    { id: 'modes', label: '模式' },
    { id: 'regex', label: '正则' },
];
let prefs = loadPreferences();
let tab = 'quick';

let filter = '';
let root, launcher, panel, listArea, searchField, sourceStatus, tabBar, saveButton, themeButton;
let open = false;
let working = false;
let lastSignature = '';
let drag = null;
let dragFrame = 0;
let dragTarget = null;
let peekTimer = null;
let settingsAttempts = 0;
let updateInProgress = false;

function loadPreferences() {
    try {
        const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return {
            position: data.position && Number.isFinite(data.position.x) && Number.isFinite(data.position.y) ? data.position : null,
            byPreset: data.byPreset && typeof data.byPreset === 'object' ? data.byPreset : {},
            floatingVisible: data.floatingVisible !== false,
            appearance: data.appearance === 'day' ? 'day' : 'night',
        };
    } catch (_) {
        return { position: null, byPreset: {}, floatingVisible: true, appearance: 'night' };
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
    if (!value.regexSubgroupCollapsed || typeof value.regexSubgroupCollapsed !== 'object') value.regexSubgroupCollapsed = {};
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
    if (tab === 'regex') {
        try { regex = regexItems(); } catch (_) {}
    }
    return JSON.stringify([
        presetIdentity(),
        entries.map(x => [x.id, x.name, x.enabled, x.groupId]),
        regex.map(x => [x.type, x.id, x.name, x.enabled]),
        tab === 'regex' ? regexGroupFingerprint() : null,
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

// Quick view is a presentation layer: all toggles use the same PromptManager
// persistence as the full Groups tab. Exact-name matching is deliberate.
const quickStudio = createQuickStudio({
    node, button, presetGroupData, promptItems, presetSettings,
    savePreferences, setPromptStates, itemRow, toast, isProtectedPrompt,
    goToTab(id) {
        tab = id;
        filter = '';
        render();
    },
    redraw() { render(); },
});

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
        wrap.dataset.groupId = group.id;
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
            settings.groupCollapsed[group.id] = visible;
            savePreferences();
        });
        const name = node('span', 'group-heading', group.name);
        const count = node('span', 'group-count', String(groupItems.length));
        header.append(name, count);
        wrap.append(header);
        const content = node('div', 'group-body');
        const collapsed = !filter && (settings.groupCollapsed[group.id] ?? (typeof group.collapsed === 'boolean' ? group.collapsed : !group.defaultOpen));
        content.hidden = collapsed;
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

// Read-only bridge to BaiBai Toolkit's custom regex folders.
function getCustomRegexGroups(type) {
    const api = getCurrentPresetAPI(), preset = getCurrentPresetName();
    const key = type === SCRIPT_TYPES.GLOBAL ? 'global'
        : type === SCRIPT_TYPES.SCOPED ? 'scoped:'+(characters?.[this_chid]?.avatar||'none')
        : 'preset:'+(api||'unknown')+':'+(preset||'unknown');
    let state = extension_settings?.baiBaiToolkit?.regexListGroups?.scopes?.[key];
    if ((!state || !Array.isArray(state.groups)) && type === SCRIPT_TYPES.PRESET) {
        try {
            const portable = getPresetManager(api)?.readPresetExtensionField({
                name: preset, path: 'baibaiToolkit.regexGroups',
            });
            if (Number(portable?.version) === 1) state = portable;
        } catch (e) { console.debug('[DW2 Control] Portable regex group unavailable',e); }
    }
    if (!Array.isArray(state?.groups) || !state?.scripts || typeof state.scripts !== 'object') return null;
    const groups = state.groups.filter(x=>x&&x.id)
        .sort((a,b)=>(Number(a.order)||0)-(Number(b.order)||0))
        .map(x=>({id:String(x.id),name:String(x.name||'未命名分组'),collapsed:!!x.collapsed}));
    const groupIds = new Set(groups.map(x=>x.id));
    return {
        key, groups:[...groups,{
            id:'__ungrouped',
            name:String(state.ungrouped?.name||'默认分组'),
            collapsed:!!state.ungrouped?.collapsed,
        }],
        groupFor(id) {
            const assigned = state.scripts[id]?.groupId;
            return groupIds.has(assigned) ? assigned : '__ungrouped';
        },
    };
}
function regexGroupFingerprint() {
    return [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.PRESET, SCRIPT_TYPES.SCOPED].map(type=>{
        const data = getCustomRegexGroups(type);
        if (!data) return null;
        return [data.key,data.groups.map(x=>[x.id,x.name,x.collapsed]),
            regexItems().filter(x=>x.type===type).map(x=>[x.id,data.groupFor(x.id)])];
    });
}

function showRegex() {
    const all = regexItems();
    const needle = filter.toLocaleLowerCase();
    const settings = presetSettings();
    const sources = [
        {type: SCRIPT_TYPES.GLOBAL,id:'global',name:'全局正则'},
        {type: SCRIPT_TYPES.PRESET,id:'preset',name:'预设正则'},
        {type: SCRIPT_TYPES.SCOPED,id:'scoped',name:'局部正则（角色）'},
    ];
    let matched = 0;
    const appendRows = (rows,target)=>{
        if (!rows.length) target.append(empty('这个分组暂无正则。'));
        else rows.forEach(item=>target.append(itemRow(item,false)));
    };
    for (const source of sources) {
        const scripts = all.filter(x=>x.type===source.type && x.name.toLocaleLowerCase().includes(needle));
        if (filter && !scripts.length) continue;
        matched+=scripts.length;
        const custom = getCustomRegexGroups(source.type);
        const expanded = !!filter || settings.regexCollapsed[source.id] === false;
        const section = node('section','group-section regex-group');
        const content = node('div','group-body');
        content.hidden=!expanded;
        const title = button('','group-expand regex-group-expand',()=>{
            const visible=!content.hidden;
            if (visible){content.hidden=true;content.replaceChildren();}
            else {drawContents();content.hidden=false;}
            settings.regexCollapsed[source.id]=visible;
            title.setAttribute('aria-expanded',String(!visible));
            savePreferences();
        });
        title.append(node('span','group-heading',source.name));
        title.append(node('span','group-count',scripts.filter(x=>x.enabled).length+' / '+scripts.length+' 已启用'));
        title.setAttribute('aria-expanded',String(expanded));
        section.append(title,content);
        function drawContents(){
            content.replaceChildren();
            const disallowed= source.type===SCRIPT_TYPES.SCOPED
                ? !isScopedScriptsAllowed(characters?.[this_chid])
                : source.type===SCRIPT_TYPES.PRESET
                    ? !isPresetScriptsAllowed(getCurrentPresetAPI(),getCurrentPresetName())
                    : false;
            if(disallowed)content.append(node('p','help regex-permission','此来源尚未在 TT 授权执行；ON 只表示单条启用，不代表已生效。'));
            if(!custom) {appendRows(scripts,content);return;}
            for(const group of custom.groups){
                const members=scripts.filter(x=>custom.groupFor(x.id)===group.id);
                if(filter&&!members.length)continue;
                const prefKey=custom.key+'/'+group.id;
                const collapsed=!filter&&(settings.regexSubgroupCollapsed[prefKey] ?? group.collapsed);
                const wrap=node('div','regex-subgroup');
                const body=node('div','regex-subgroup-body');
                body.hidden=collapsed;
                const head=button('','regex-subgroup-header',()=>{
                    const wasOpen=!body.hidden;
                    if(wasOpen){body.hidden=true;body.replaceChildren();}
                    else {appendRows(members,body);body.hidden=false;}
                    settings.regexSubgroupCollapsed[prefKey]=wasOpen;
                    head.setAttribute('aria-expanded',String(!wasOpen));
                    savePreferences();
                });
                head.append(node('span','regex-subgroup-name',group.name));
                head.append(node('span','regex-subgroup-count',String(members.length)));
                head.setAttribute('aria-expanded',String(!collapsed));
                wrap.append(head,body);
                if(!collapsed)appendRows(members,body);
                content.append(wrap);
            }
        }
        if(expanded)drawContents();
        listArea.append(section);
    }
    if(filter&&!matched)listArea.append(empty('未找到匹配的正则。'));
}

function render() {
    if (!root || !listArea || !open) return;
    sourceStatus.textContent = (getCurrentPresetName() || '未选择预设') + ' · ' + promptItems().length + ' 条';
    tabBar.querySelectorAll('button').forEach(b => {
        b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    const hideSearch = tab === 'modes' || tab === 'quick';
    searchField.hidden = hideSearch;
    searchField.parentElement.hidden = hideSearch;
    if (searchField.value !== filter) searchField.value = filter;
    listArea.replaceChildren();
    if (tab === 'quick') quickStudio.render(listArea);
    else if (tab === 'modes') showModes();
    else if (tab === 'regex') showRegex();
    else if (tab === 'all') showGroups();
    else showPrompts(tab === 'favs');
    lastSignature = currentSignature();
}

function refreshIfChanged() {
    if (!open || working || !root || document.activeElement === searchField ||
        document.activeElement?.classList.contains(NS + '-mode-select')) return;
    const signature = currentSignature();
    if (signature !== lastSignature) render();
}

function launcherMetrics() {
    // 44px is large enough to tap easily and less intrusive than the old 52px.
    const size = launcher?.offsetWidth || 44;
    const edge = 0; // Flush to the viewport, like a true docked bubble.
    const top = innerWidth <= 650 ? 70 : 14;
    const bottom = innerWidth <= 650 ? 26 : 12;
    return { size, edge, top, bottom };
}
function boundLauncher(x, y) {
    const m = launcherMetrics();
    return {
        x: Math.max(m.edge, Math.min(x, innerWidth - m.size - m.edge)),
        y: Math.max(m.top, Math.min(y, innerHeight - m.size - m.bottom)),
    };
}
function dockSideForX(x, size = launcherMetrics().size) {
    // Edges are dockable; the center third of the display stays freely draggable.
    const band = Math.min(112, innerWidth * .29);
    if (x <= band) return 'left';
    if (innerWidth - x - size <= band) return 'right';
    return null;
}
const PEEK_VISIBLE = .58;
const PEEK_DELAY_MS = 650;
// Stored docking coordinates remain fully visible. The partial offscreen
// position is presentation-only, so drag and resize remain deterministic.
function launcherPeekShift() {
    return Math.round(launcherMetrics().size * (1 - PEEK_VISIBLE));
}
function revealLauncher() {
    if (peekTimer !== null) clearTimeout(peekTimer);
    peekTimer = null;
    launcher.classList.remove('is-peeking');
    if (prefs.position?.side === 'left') launcher.style.left = '0px';
    else if (prefs.position?.side === 'right') launcher.style.left = (innerWidth - launcherMetrics().size) + 'px';
}
function scheduleLauncherPeek() {
    if (peekTimer !== null) clearTimeout(peekTimer);
    peekTimer = null;
    if (!launcher || !prefs.position?.side || open || drag || !prefs.floatingVisible) return;
    peekTimer = setTimeout(() => {
        peekTimer = null;
        if (!launcher || open || drag || !prefs.position?.side || !prefs.floatingVisible) return;
        const offset = launcherPeekShift();
        launcher.classList.add('is-peeking');
        launcher.style.left = (prefs.position.side === 'left'
            ? -offset : innerWidth - launcherMetrics().size + offset) + 'px';
    }, PEEK_DELAY_MS);
}
function placeLauncher() {
    const m = launcherMetrics(), stored = prefs.position;
    const x = stored?.side === 'left' ? 0
        : stored?.side === 'right' ? innerWidth - m.size
        : stored?.x ?? (innerWidth - m.size);
    const y = stored?.y ?? (innerHeight * .56);
    const pos = boundLauncher(x,y);
    const detected = stored?.side || dockSideForX(pos.x,m.size);
    if (detected) pos.x = detected === 'left' ? 0 : innerWidth - m.size;
    launcher.classList.remove('is-peeking');
    launcher.style.left = pos.x + 'px';
    launcher.style.top = pos.y + 'px';
    if (!stored || stored.x !== pos.x || stored.y !== pos.y || stored.side !== detected) {
        prefs.position = { x:pos.x, y:pos.y, side:detected };
        savePreferences();
    }
    scheduleLauncherPeek();
    return pos;
}
function snapLauncherIfNearEdge() {
    const m = launcherMetrics();
    const side = dockSideForX(launcher.offsetLeft,m.size);
    if (!side) return false;
    const x = side === 'left' ? 0 : innerWidth - m.size;
    launcher.classList.add('is-snapping');
    launcher.classList.remove('is-peeking');
    launcher.style.left = x + 'px';
    prefs.position = { x, y:launcher.offsetTop, side };
    savePreferences();
    return true;
}

function placePanel() {
    if (!open) return;
    const rect = launcher.getBoundingClientRect();
    const w = panel.offsetWidth, h = panel.offsetHeight;
    // iOS's safe-area env can be zero in standalone WebViews. Keep a real
    // 70px top inset in portrait mobile so the status bar is never overlapped.
    const topGuard = innerWidth <= 650 ? 70 : 16;
    const bottomGuard = innerWidth <= 650 ? 26 : 16;
    const side = 10;
    let left = rect.left + rect.width - w;
    let top = rect.top - h - 12;
    if (top < topGuard) top = rect.bottom + 12;
    left = Math.max(side, Math.min(left, Math.max(side, innerWidth - w - side)));
    top = Math.max(topGuard, Math.min(top, Math.max(topGuard, innerHeight - h - bottomGuard)));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
}

function applyAppearance() {
    root.dataset.appearance = prefs.appearance;
    // Line icons, not OS emoji. The previous yellow sun looked out of place
    // alongside the minimal bookshelf frosted-glass controls.
    const icon = prefs.appearance === 'day'
        ? '<path d="M20.8 14.4A8.2 8.2 0 0 1 9.6 3.2a8.2 8.2 0 1 0 11.2 11.2Z"/>'
        : '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2.1M12 19.9V22M4.93 4.93l1.5 1.5m11.14 11.14 1.5 1.5M2 12h2.1M19.9 12H22M4.93 19.07l1.5-1.5M17.57 6.43l1.5-1.5"/>';
    themeButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon + '</svg>';
    themeButton.title = prefs.appearance === 'day' ? '切换夜间模式' : '切换日间模式';
    themeButton.setAttribute('aria-label', themeButton.title);
    themeButton.setAttribute('aria-pressed', String(prefs.appearance === 'day'));
}
function changeAppearance(next) {
    prefs.appearance = next === 'day' ? 'day' : 'night';
    applyAppearance();
    savePreferences();
}

async function saveActivePreset() {
    if (working || !saveButton) return;
    // Settings are saved automatically when individual entries are toggled.
    // The user explicitly requested the *native Save/Update Preset* action,
    // which is separate from saving service settings or refreshing this UI.
    if (getCurrentPresetAPI() !== 'openai') {
        toast('当前不是 Chat Completion 预设，不能执行此保存操作。','warning');
        return;
    }
    const nativeSave = document.getElementById('update_oai_preset');
    const activeName = getCurrentPresetName();
    if (!nativeSave || nativeSave.disabled || !activeName || !promptManager?.activeCharacter) {
        toast('TT 原生「更新预设」按钮尚未就绪。请在 TT 预设设置中检查。','warning');
        return;
    }
    const manager = getPresetManager('openai');
    const selected = manager?.getSelectedPresetName?.();
    if (selected && selected !== activeName) {
        toast('当前预设名称与 TT 选中项不同，已取消保存以免写错预设。','warning');
        return;
    }
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
    try {
        // Invoke the exact action bound by TT itself; the native save handler
        // performs /api/presets/save with the correct filtered preset payload.
        // click() does not await that handler, so do NOT claim success here.
        nativeSave.click();
        toast('已调用 TT 原生「更新预设」，请以 TT 的保存结果提示为准。','info');
    } catch (error) {
        toast('无法调用 TT 保存：'+(error.message||error),'error');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = '保存预设';
    }
}

function showPanel(yes) {
    open = yes;
    root.classList.toggle('is-open', yes);
    launcher.setAttribute('aria-expanded', String(yes));
    panel.hidden = !yes;
    if (yes) {
        revealLauncher();
        render();
        requestAnimationFrame(placePanel);
    } else {
        scheduleLauncherPeek();
    }
}

function mountSettingsPanel() {
    if (document.getElementById(SETTINGS_ID)) return;
    const host = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('.extensions_settings');
    if (!host) {
        if (++settingsAttempts <= 50) setTimeout(mountSettingsPanel,400);
        return;
    }
    const section=node('div','settings-block');
    section.id=SETTINGS_ID;
    section.classList.add('inline-drawer');
    const heading=node('div','settings-heading');
    heading.classList.add('inline-drawer-toggle','inline-drawer-header');
    const icon=node('div','settings-chevron');
    icon.classList.add('inline-drawer-icon','fa-solid','fa-circle-chevron-down','down');
    const titleGroup = node('div', 'settings-heading-text');
    titleGroup.append(node('b','settings-title','✧ DW2 · Preset Console'));
    titleGroup.append(node('span','settings-byline','S.A. · DW2'));
    heading.append(titleGroup,icon);
    heading.setAttribute('aria-expanded','false');

    const content=node('div','settings-content');
    content.classList.add('inline-drawer-content');
    content.style.display='none';
    heading.addEventListener('click',event=>{
        event.preventDefault();
        event.stopPropagation();
        const expand=content.style.display==='none';
        content.style.display=expand?'block':'none';
        heading.setAttribute('aria-expanded',String(expand));
        icon.classList.toggle('down',!expand);
    });
    content.append(node('p','settings-hint','预设与正则悬浮控制台 · v'+VERSION));
    const toggleRow=node('label','settings-toggle');
    const checkbox=node('input','settings-checkbox');
    checkbox.type='checkbox';
    checkbox.checked=prefs.floatingVisible;
    checkbox.addEventListener('change',()=>{
        prefs.floatingVisible=checkbox.checked;
        launcher.hidden=!prefs.floatingVisible;
        if(!prefs.floatingVisible)showPanel(false);
        else scheduleLauncherPeek();
        savePreferences();
    });
    toggleRow.append(checkbox,node('span','','显示悬浮按钮'));
    content.append(toggleRow);
    const actions=node('div','settings-actions');
    actions.append(button('打开控制台','settings-action',()=>{
        if (!prefs.floatingVisible) {
            prefs.floatingVisible=true;
            launcher.hidden=false;
            checkbox.checked=true;
            scheduleLauncherPeek();
            savePreferences();
        }
        showPanel(true);
    }));
    const updateButton=button('检查并更新','settings-action',async()=>{
        if(updateInProgress)return;
        updateInProgress=true;
        updateButton.disabled=true;
        updateButton.textContent='检查中…';
        try{
            const id=Object.keys(extensionTypes||{}).find(
                key=>key==='third-party/dw2-preset-console' ||
                    key.endsWith('/dw2-preset-console')
            );
            if(!id)throw new Error('无法识别插件安装目录，请使用管理扩展更新');
            const res=await fetch('/api/extensions/update',{
                method:'POST',
                headers:getRequestHeaders(),
                body:JSON.stringify({
                    extensionName:id.replace(/^third-party/,''),
                    global:extensionTypes[id]==='global',
                }),
            });
            if(!res.ok){
                const message=await res.text();
                throw new Error((message||'HTTP '+res.status).slice(0,220));
            }
            const result=await res.json();
            if(result.isUpToDate)toast('插件已是最新版本','success');
            else toast('代码更新完成，请刷新 TT 酒馆。','success');
        }catch(error){
            toast('检查更新失败：'+(error.message||error),'warning');
        }finally{
            updateInProgress=false;
            updateButton.disabled=false;
            updateButton.textContent='检查并更新';
        }
    });
    actions.append(updateButton);
    actions.append(button('管理扩展','settings-action',()=>{
        void openThirdPartyExtensionMenu();
    }));
    actions.append(button('刷新酒馆','settings-action',() => {
        if (window.confirm('重新加载 TT 酒馆？请先保存尚未保存的预设修改。')) {
            window.location.reload();
        }
    }));
    content.append(actions);
    section.append(heading,content);
    host.append(section);
}

// The host's native "Manage Extensions" popup is created afresh each time.
// Attach one unobtrusive reload control to its native toolbar, without
// replacing or modifying the popup's own Update/Sort handlers.
function mountManagerReloadButton() {
    const toolbar = document.querySelector('.extensions_info > .extensions_toolbar');
    if (!toolbar || toolbar.querySelector('.dw2pc-manager-reload')) return;
    const reload = button('↻ 刷新酒馆', 'manager-reload', () => {
        if (window.confirm('重新加载 TT 酒馆？请先保存尚未保存的预设修改。')) {
            window.location.reload();
        }
    });
    reload.classList.add('menu_button','menu_button_icon');
    toolbar.append(reload);
}
function watchExtensionManager() {
    mountManagerReloadButton();
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const entry of record.addedNodes) {
                if (entry.nodeType !== 1) continue;
                if (entry.matches?.('.extensions_info') ||
                    entry.querySelector?.('.extensions_info') ||
                    entry.matches?.('.extensions_toolbar') ||
                    entry.querySelector?.('.extensions_toolbar')) {
                    mountManagerReloadButton();
                    return;
                }
            }
        }
    });
    observer.observe(document.body,{childList:true,subtree:true});
}

function build() {
    root = node('div', 'root');
    root.id = ROOT_ID;
    root.dataset.appearance = prefs.appearance;
    launcher = button('', 'launcher', e => {
        if (e.detail === 0) showPanel(!open); // keyboard / assistive input
    }, 'DW2 · Control');
    // The old text character ✧ was centered by its font box, not its actual
    // outline. Use a symmetrical 4-point vector centered exactly on (15,15).
    // An inline SVG also avoids font fallback differences on iOS and Android.
    launcher.innerHTML = '<svg viewBox="0 0 30 30" width="29" height="29" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2.8 C17.5 10.1 19.9 12.5 27.2 15 C19.9 17.5 17.5 19.9 15 27.2 C12.5 19.9 10.1 17.5 2.8 15 C10.1 12.5 12.5 10.1 15 2.8 Z"/></svg>';
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
    const headActions = node('div', 'header-actions');
    themeButton = button('', 'theme', () => changeAppearance(prefs.appearance === 'day' ? 'night' : 'day'));
    const closeButton = button('', 'close', () => showPanel(false), '关闭');
    closeButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5"/></svg>';
    closeButton.setAttribute('aria-label', '关闭控制台');
    headActions.append(themeButton, closeButton);
    head.append(headings, headActions);
    applyAppearance();
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
    foot.append(node('span', '', 'DW2 · CONTROL  /  v0.4.6'));
    const footActions = node('div', 'footer-actions');
    footActions.append(button('⟳ 刷新', 'refresh', () => render(), '重新读取当前状态'));
    saveButton = button('保存预设', 'save-preset', () => void saveActivePreset(), '执行 TT 原生「更新预设」操作');
    footActions.append(saveButton);
    foot.append(footActions);
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
        const pos = boundLauncher(drag.left + dx, drag.top + dy);
        launcher.style.left = pos.x + 'px';
        launcher.style.top = pos.y + 'px';
        if (open) placePanel();
    }

    launcher.addEventListener('pointerdown', e => {
        if (e.button !== 0 || drag) return;
        revealLauncher();
        launcher.classList.remove('is-snapping');
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
            prefs.position = { x: launcher.offsetLeft, y: launcher.offsetTop, side: null };
            if (!snapLauncherIfNearEdge()) savePreferences();
        }
        drag = null;
        dragTarget = null;
        if (!didDrag) showPanel(!open);
        else scheduleLauncherPeek();
    });
    launcher.addEventListener('pointercancel', () => {
        if (dragFrame) cancelAnimationFrame(dragFrame);
        dragFrame = 0;
        dragTarget = null;
        drag = null;
        scheduleLauncherPeek();
    });
    launcher.addEventListener('click', e => {
        // Suppress ordinary pointer-generated click; pointerup has handled it.
        if (e.detail !== 0) e.preventDefault();
    });
    placeLauncher();
    launcher.hidden = !prefs.floatingVisible;

    if (typeof ResizeObserver === 'function') {
        // The popover is now content-sized; keep it onscreen when folders expand.
        const panelSizeWatcher = new ResizeObserver(() => {
            if (open) requestAnimationFrame(placePanel);
        });
        panelSizeWatcher.observe(panel);
    }
    window.addEventListener('resize', () => { placeLauncher(); placePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) showPanel(false); });

    const refreshEvents = [
        event_types?.OAI_PRESET_CHANGED_AFTER, event_types?.CHAT_LOADED,
        event_types?.CHARACTER_EDITED, event_types?.CHATCOMPLETION_MODEL_CHANGED,
    ].filter(Boolean);
    refreshEvents.forEach(type => eventSource.on(type, () => setTimeout(refreshIfChanged, 400)));
    setInterval(refreshIfChanged, 1600);
    mountSettingsPanel();
    watchExtensionManager();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
else build();
