/**
 * DW2 Quick Studio / v0.4.15
 * Compact real-state controls: two style selectors and two existing native
 * groups. This module never alters actual prompt content or BaiBai metadata.
 */
export function createQuickStudio(deps) {
    const { node, button, presetGroupData, promptItems, presetSettings,
        savePreferences, setPromptStates, itemRow, toast, isProtectedPrompt,
        goToTab, redraw } = deps;
    let filter = '';
    const open = { writing: false, viewpoint: false };
    const folderSpecs = [
        { id:'writing', needle:'写作指导｜字数·段落·节奏·浓度',
          name:'写作指导', subtitle:'字数 · 段落 · 节奏 · 情感基调' },
        { id:'viewpoint', needle:'视角与落点｜沉浸镜头·小说叙事',
          name:'视角与落点', subtitle:'镜头 · 落点 · 对话 · 人称' },
    ];
    // The two selectors operate on DIFFERENT physical folders.
    const styleSources = [
        { id: 'zhi', name: '文风 1 · 织界·原生', description: '织界｜通用文风库' },
        { id: 'puppy', name: '文风 2 · 织界·文学', description: '通用文学库' },
    ];
    function groupBy(phrase) {
        const groups = presetGroupData().groups || [];
        const clean = value => String(value || '').replace(/[\s｜|·・—_-]/g, '');
        const matches = groups.filter(g => {
            const name = clean(g.name);
            if (phrase === 'zhi') return name.includes('织界') && name.includes('通用文风库');
            if (phrase === 'puppy') return name.includes('通用文学库') && !name.includes('织界');
            if (phrase.startsWith('写作指导')) return name.includes('写作指导');
            if (phrase.startsWith('视角与落点')) return name.includes('视角与落点');
            return false;
        });
        return matches.length === 1 ? matches[0] : null;
    }
    function getStyles(items, sourceId = 'zhi') {
        const group = groupBy(sourceId);
        return group ? items.filter(item => item.groupId === group.id
            && !item.marker && !item.system && !isProtectedPrompt(item)
            && !/──|↓|↑|文风选择|自定义文风区|仅单开不配其他|^😈\s*♫|^★/.test(item.name))
            : [];
    }
    function stylesFor(items) {
        return Object.fromEntries(styleSources.map(s => [s.id, getStyles(items, s.id)]));
    }
    function activeSlots(libraries, prefs = presetSettings()) {
        const old = Array.isArray(prefs.styleSlots) ? prefs.styleSlots : [];
        const slots = styleSources.map((source, index) => {
            const list = libraries[source.id] || [];
            const chosen = list.find(x => x.id === old[index] && x.enabled);
            return chosen?.id || list.find(x => x.enabled)?.id || '';
        });
        if (JSON.stringify(prefs.styleSlots) !== JSON.stringify(slots)) {
            prefs.styleSlots = slots;
            savePreferences();
        }
        return slots;
    }
    async function setSlot(index, nextId) {
        const source = styleSources[index];
        const library = getStyles(promptItems(), source.id);
        const prefs = presetSettings();
        const previous = activeSlots(stylesFor(promptItems()), prefs);
        if (nextId && !library.some(x => x.id === nextId)) {
            toast('所选文风不属于' + source.description + '，请刷新。', 'warning');
            redraw(); return;
        }
        const changes = library.filter(x => x.enabled && x.id !== nextId)
            .map(x => ({ id: x.id, enabled: false }));
        const next = library.find(x => x.id === nextId);
        if (next && !next.enabled) changes.push({ id: next.id, enabled: true });
        prefs.styleSlots = [...previous];
        prefs.styleSlots[index] = nextId;
        savePreferences();
        try {
            if (changes.length && !await setPromptStates(changes)) {
                prefs.styleSlots = previous; savePreferences(); redraw();
            } else if (!changes.length) redraw();
        } catch (error) {
            prefs.styleSlots = previous; savePreferences();
            toast('文风切换失败：' + (error.message || error), 'error');
            redraw();
        }
    }

    function showGroupInAll(group) {
        if(!group)return;
        presetSettings().groupCollapsed[group.id]=false;
        savePreferences();
        goToTab('all');
        requestAnimationFrame(()=>{
            const target=Array.from(document.querySelectorAll('#dw2-preset-console [data-group-id]'))
                .find(el=>el.dataset.groupId===group.id);
            target?.scrollIntoView({block:'nearest',behavior:'smooth'});
        });
    }
    function styleLabel(name) {
        return String(name).replace(/^😈\s*/,'').replace(/^[🎵🎶🍧📀💌♥︎\s]+/u,'').trim();
    }
    function addOptions(select, styles, selectedId) {
        const query = filter.toLocaleLowerCase();
        select.replaceChildren();
        const none = node('option', '', '暂不选择');
        none.value = '';
        select.append(none);
        for (const item of styles) {
            if (query && !item.name.toLocaleLowerCase().includes(query)
                && item.id !== selectedId) continue;
            const option = node('option', '', styleLabel(item.name));
            option.value = item.id;
            select.append(option);
        }
        select.value = selectedId || '';
    }
    function styleSelectors(container, items) {
        const box = node('section', 'q-card');
        box.append(node('div', 'q-title', '文风选择'));
        const libraries = stylesFor(items);
        const slots = activeSlots(libraries);
        const meta = styleSources.map(source => {
            const options = libraries[source.id];
            return source.name + ' ' + options.length + ' 可选 · ' +
                options.filter(x => x.enabled).length + ' 启用';
        });
        box.append(node('div', 'q-meta', meta.join('  ｜  ')));
        const search = node('input', 'q-search');
        search.type = 'search';
        search.placeholder = '搜索两个文风库…';
        search.value = filter;
        const selects = [];
        const fields = node('div', 'q-style-fields');
        styleSources.forEach((source, index) => {
            const group = groupBy(source.id);
            const row = node('div', 'q-field');
            const label = node('label', 'q-label', source.name);
            const select = node('select', 'q-select');
            select.setAttribute('aria-label', source.name);
            select.disabled = !group;
            addOptions(select, libraries[source.id], slots[index]);
            select.addEventListener('change', () => void setSlot(index, select.value));
            selects.push(select);
            row.append(label, select);
            fields.append(row);
            if (!group) box.append(node('p', 'q-warning',
                '未找到「' + source.description + '」；请检查当前预设的分组。'));
        });
        search.addEventListener('input', () => {
            filter = search.value.trim();
            const fresh = stylesFor(promptItems());
            const selected = activeSlots(fresh);
            selects.forEach((select, index) =>
                addOptions(select, fresh[styleSources[index].id], selected[index]));
        });
        box.append(search, fields);
        styleSources.forEach(source => {
            const group = groupBy(source.id);
            const enabled = libraries[source.id].filter(x => x.enabled).length;
            if (enabled > 1) box.append(node('p', 'q-warning',
                '「' + source.description + '」已有 ' + enabled +
                ' 条文风开启，切换该槽会关闭本库的其他文风。'));
            if (group) box.append(button(source.description + ' ↗',
                'q-jump', () => showGroupInAll(group)));
        });
        container.append(box);
    }

    function nativeGroup(container,items,def) {
        const group=groupBy(def.needle);
        const outer=node('section','q-card');
        if(!group) {
            outer.append(node('div','q-title',def.name),
                node('p','q-warning','当前预设未找到这个分组。'));
            container.append(outer);return;
        }
        const members=items.filter(x=>x.groupId===group.id);
        const isOpen=open[def.id]!==false;
        const header=button('','q-native-head',()=>{
            open[def.id]=!isOpen;redraw();
        });
        header.append(node('span','q-native-name',def.name));
        header.append(node('span','q-native-count',
            members.filter(x=>x.enabled).length+'/'+members.length));
        header.setAttribute('aria-expanded',String(isOpen));
        outer.append(header);
        if(isOpen) {
            const body=node('div','q-native-rows');
            members.forEach(item=>body.append(itemRow(item,true)));
            outer.append(body);
            outer.append(button('原始分组 ↗','q-jump',()=>showGroupInAll(group)));
        }
        container.append(outer);
    }
    function render(listArea) {
        const items=promptItems();
        if(!items.length) {
            listArea.append(node('div','q-warning','预设管理器还没有就绪，请选择当前预设后刷新。'));
            return;
        }
        if(!groupBy('zhi') && !groupBy('puppy') && !folderSpecs.some(s=>groupBy(s.needle))) {
            listArea.append(node('div','q-warning','暂未读到快捷页需要的文风／写作指导分组。请检查当前预设自带分组或资源库分组是否已加载。'));
            listArea.append(button('打开全部','q-jump',()=>goToTab('all')));
            return;
        }
        const intro=node('div','q-intro');
        intro.append(node('span','q-intro-name','常用设置'));
        intro.append(node('span','q-intro-meta','QUICK STUDIO'));
        listArea.append(intro);
        styleSelectors(listArea,items);
        folderSpecs.forEach(def=>nativeGroup(listArea,items,def));
    }
    return {render,setSlot,getStyles,activeSlots};
}
