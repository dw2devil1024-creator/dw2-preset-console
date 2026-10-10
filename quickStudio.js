/**
 * DW2 Quick Studio / v0.4.2
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
    const groupBy = phrase => presetGroupData().groups.find(g=>g.name.includes(phrase));

    function getStyles(items) {
        const group = groupBy('通用文风库');
        return group
            ? items.filter(item => item.groupId === group.id && !item.marker
                && !item.system && !isProtectedPrompt(item)
                && !/──|↓|↑|最多选两文风|自定义文风区|仅单开不配其他|^😈\s*♫/.test(item.name))
            : [];
    }
    function activeSlots(styles, prefs = presetSettings()) {
        const valid = new Set(styles.map(x=>x.id));
        const old = Array.isArray(prefs.styleSlots) ? prefs.styleSlots : [];
        const slots=[0,1].map(i=>valid.has(old[i]) && styles.some(x=>x.id===old[i]&&x.enabled) ? old[i] : '');
        const seen=new Set(slots.filter(Boolean));
        for(const style of styles) {
            if (!style.enabled || seen.has(style.id)) continue;
            const empty = slots.indexOf('');
            if (empty<0) break;
            slots[empty]=style.id;seen.add(style.id);
        }
        if(JSON.stringify(prefs.styleSlots)!==JSON.stringify(slots)) {
            prefs.styleSlots=slots;savePreferences();
        }
        return slots;
    }
    async function setSlot(slotIndex,nextId) {
        const styles=getStyles(promptItems()), prefs=presetSettings();
        const prev=activeSlots(styles,prefs), previousId=prev[slotIndex];
        const other=prev[1-slotIndex];
        if(nextId&&!styles.some(x=>x.id===nextId)) {
            toast('选中的文风已不存在，请先刷新。','warning');redraw();return;
        }
        if(nextId && nextId===other) {
            toast('这个文风已在另一个框里，请换一个。','warning');redraw();return;
        }
        if(previousId===nextId)return;
        const changes=[];
        const old=styles.find(x=>x.id===previousId);
        const next=styles.find(x=>x.id===nextId);
        if(old?.enabled && previousId!==other)changes.push({id:old.id,enabled:false});
        if(next && !next.enabled)changes.push({id:next.id,enabled:true});
        prefs.styleSlots=[...prev];
        prefs.styleSlots[slotIndex]=nextId;
        savePreferences();
        try {
            if(changes.length && !await setPromptStates(changes)) {
                prefs.styleSlots=prev;savePreferences();redraw();
            } else if(!changes.length) redraw();
        } catch(e) {
            prefs.styleSlots=prev;savePreferences();
            toast('文风切换失败：'+(e.message||e),'error');redraw();
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
    function addOptions(select,styles,slots,index) {
        const q=filter.toLocaleLowerCase();
        select.replaceChildren();
        const none=node('option','','暂不选择');none.value='';select.append(none);
        for(const item of styles) {
            if(q && !item.name.toLocaleLowerCase().includes(q) && !slots.includes(item.id))continue;
            const option=node('option','',styleLabel(item.name));
            option.value=item.id;
            option.disabled=item.id===slots[1-index];
            select.append(option);
        }
        select.value=slots[index]||'';
    }
    function styleSelectors(container,items) {
        const group=groupBy('通用文风库');
        const box=node('section','q-card');
        box.append(node('div','q-title','文风选择'));
        
        if(!group) {
            box.append(node('p','q-warning','未读取到通用文风库，请从「全部」检查。'));
            container.append(box);return;
        }
        const styles=getStyles(items), slots=activeSlots(styles);
        const enabledCount=styles.filter(x=>x.enabled).length;
        box.append(node('div','q-meta',styles.length+' 可选  ·  '+enabledCount+' 启用'));
        const search=node('input','q-search');search.type='search';
        search.placeholder='搜索文风…';
        search.value=filter;
        const selectBoxes=[];
        const fields=node('div','q-style-fields');
        for(let idx=0;idx<2;idx++) {
            const row=node('div','q-field');
            const label=node('label','q-label','文风 '+(idx+1));
            const select=node('select','q-select');
            select.setAttribute('aria-label','选择第 '+(idx+1)+' 个文风');
            addOptions(select,styles,slots,idx);
            select.addEventListener('change',()=>void setSlot(idx,select.value));
            selectBoxes.push(select);
            row.append(label,select);fields.append(row);
        }
        search.addEventListener('input',()=>{
            filter=search.value.trim();
            const current=getStyles(promptItems()), selections=activeSlots(current);
            selectBoxes.forEach((s,i)=>addOptions(s,current,selections,i));
        });
        box.append(search,fields);
        if(enabledCount>2)box.append(node('p','q-warning',
            '当前有 '+enabledCount+' 个文风开启，超过双槽数量。插件会保留额外文风，请在原分组核对。'));
        box.append(button('全部文风 ↗','q-jump',()=>showGroupInAll(group)));
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
        if(!groupBy('通用文风库') && !folderSpecs.some(s=>groupBy(s.needle))) {
            listArea.append(node('div','q-warning','当前预设没有匹配《织界》快捷设置，原始分组不会受到影响。'));
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
