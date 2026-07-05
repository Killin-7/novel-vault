import fs from "fs";
import path from "path";

let _store = null;
let _dataDir = null;

export function initDb(dataDir) {
  _dataDir = dataDir;
  // 如果已初始化且 dataDir 相同，复用；否则重建
  if (_store && _store._dir === dataDir) return _store;
  _store = new DataStore(dataDir);
  return _store;
}
export function closeDb() { if (_store) { _store.close(); _store = null; } }
/** 获取数据库实例，如果尚未初始化则使用 index.js 传入的 dataDir 自动初始化 */
export function getDb() {
  if (!_store) {
    if (!_dataDir) throw new Error("数据库未初始化：index.js 的 onload 尚未执行");
    _store = new DataStore(_dataDir);
  }
  return _store;
}

class DataStore {
  constructor(dataDir) { this._dir = dataDir; this._file = path.join(dataDir, "novel-vault.json"); this._data = this._load(); }
  _load() { try { if (fs.existsSync(this._file)) return this._ensureStructure(JSON.parse(fs.readFileSync(this._file, "utf-8"))); } catch(e){} return this._emptyData(); }
  _ensureStructure(d) {
    const def = this._emptyData();
    for (const k of Object.keys(def)) {
      if (d[k] === undefined) d[k] = def[k];
    }
    const arrayKeys = ["novels","volumes","chapters","characters","character_states","plot_points","events","chapter_events","settings","chapter_settings","atomic_facts","skill_memories","foreshadow_relations"];
    for (const k of arrayKeys) {
      if (!Array.isArray(d[k])) d[k] = [];
    }
    if (!d.parse_cache || typeof d.parse_cache !== "object" || Array.isArray(d.parse_cache)) d.parse_cache = {};
    if (typeof d._nextId !== "number") d._nextId = 1;
    return d;
  }
  _emptyData() { return {novels:[],volumes:[],chapters:[],characters:[],character_states:[],plot_points:[],events:[],chapter_events:[],settings:[],chapter_settings:[],parse_cache:{},atomic_facts:[],skill_memories:[],foreshadow_relations:[],_nextId:1}; }
  _nextId() { return this._data._nextId++; }
  _save() { fs.mkdirSync(this._dir,{recursive:true}); fs.writeFileSync(this._file,JSON.stringify(this._data,null,2),"utf-8"); }
  transaction(fn) { return (...args) => { const snap=JSON.stringify(this._data); try{const r=fn(...args);this._save();return r;}catch(e){this._data=JSON.parse(snap);throw e;} }; }
  close() { this._save(); this._data=null; }
  _all(t) { return this._data[t]; }
  _find(t,p) { return this._data[t].find(p); }
  _filter(t,p) { return this._data[t].filter(p); }
  _insert(t,row) { if(!row.id)row.id=this._nextId(); const n=new Date().toISOString().replace("T"," ").slice(0,19); if(!row.created_at)row.created_at=n; if(row.updated_at===undefined)row.updated_at=n; this._data[t].push(row); this._save(); return {changes:1,lastInsertRowid:row.id}; }
  _update(t,id,upd) { const row=this._data[t].find(r=>r.id===id); if(!row)return{changes:0}; const n=new Date().toISOString().replace("T"," ").slice(0,19); Object.assign(row,upd,{updated_at:n}); this._save(); return {changes:1,lastInsertRowid:id}; }
  _upsert(t,keys,row) { const ex=this._find(t,r=>keys.every(k=>r[k]===row[k])); if(ex){const n=new Date().toISOString().replace("T"," ").slice(0,19);Object.assign(ex,row,{id:ex.id,created_at:ex.created_at,updated_at:n});this._save();return{changes:1,lastInsertRowid:ex.id};} return this._insert(t,row); }
  // ─── 缓存层 (A3) ───
  cacheGet(filePath) { const entry = this._data.parse_cache[filePath]; if (!entry) return null; return entry.data; }
  cacheSet(filePath, data) { const n = new Date().toISOString().replace("T"," ").slice(0,19); this._data.parse_cache[filePath] = { hash: "", updated_at: n, data }; this._save(); }
  cacheClear(filePath) { if (filePath) { delete this._data.parse_cache[filePath]; } else { this._data.parse_cache = {}; } this._save(); }
}

export function listNovels(s=_store){return s._all("novels").map(n=>({...n,chapter_count:s._filter("chapters",c=>c.novel_id===n.id).length,unresolved_count:s._filter("plot_points",p=>p.novel_id===n.id&&p.status==="active").length,last_archived:s._filter("chapters",c=>c.novel_id===n.id&&c.status==="archived").map(c=>c.archived_at).sort().reverse()[0]||null})).sort((a,b)=>(b.updated_at||"").localeCompare(a.updated_at||""));}
export function getNovelBySlug(slug,s=_store){return s._find("novels",n=>n.slug===slug)||null;}
export function getNovelById(id,s=_store){return s._find("novels",n=>n.id===id)||null;}
export function upsertNovel(f,s=_store){return s._upsert("novels",["slug"],f);}
export function getChapterByNumber(nid,num,s=_store){return s._find("chapters",c=>c.novel_id===nid&&c.chapter_number===num)||null;}
export function getChapterById(id,s=_store){return s._find("chapters",c=>c.id===id)||null;}
export function listChapters(nid,s=_store){return s._filter("chapters",c=>c.novel_id===nid).sort((a,b)=>a.chapter_number-b.chapter_number);}
export function getCharacterByName(nid,name,s=_store){return s._find("characters",c=>c.novel_id===nid&&c.name===name)||null;}
export function upsertCharacter(f,s=_store){return s._upsert("characters",["novel_id","name"],f);}
export function listCharactersByNovel(nid,s=_store){return s._filter("characters",c=>c.novel_id===nid);}
export function upsertCharacterState(f,s=_store){return s._upsert("character_states",["character_id","chapter_id"],f);}
export function getCharacterArc(cid,s=_store){const st=s._filter("character_states",cs=>cs.character_id===cid);const chs=s._all("chapters");return st.map(cs=>{const ch=chs.find(c=>c.id===cs.chapter_id);return{...cs,chapter_number:ch?.chapter_number,chapter_title:ch?.title};}).sort((a,b)=>(a.chapter_number||0)-(b.chapter_number||0));}
export function listPlotPoints(nid,status,s=_store){let p=s._filter("plot_points",p=>p.novel_id===nid);if(status)p=p.filter(p=>p.status===status);const chs=s._all("chapters");return p.map(p=>({...p,planted_chapter_num:chs.find(c=>c.id===p.planted_chapter_id)?.chapter_number,resolved_chapter_num:chs.find(c=>c.id===p.resolved_chapter_id)?.chapter_number})).sort((a,b)=>(b.importance||0)-(a.importance||0));}
export function getUnresolvedForeshadows(nid,s=_store){return listPlotPoints(nid,"active",s);}
export function upsertPlotPoint(f,s=_store){const ex=s._find("plot_points",p=>p.novel_id===f.novel_id&&p.title===f.title);if(ex)return s._update("plot_points",ex.id,f);return s._insert("plot_points",f);}
export function getEventByTitle(nid,title,s=_store){return s._find("events",e=>e.novel_id===nid&&e.title===title)||null;}
export function upsertEvent(f,s=_store){return s._upsert("events",["novel_id","title"],f);}
export function linkChapterEvent(chId,evId,inv,s=_store){const ex=s._find("chapter_events",ce=>ce.chapter_id===chId&&ce.event_id===evId);if(!ex)return s._insert("chapter_events",{chapter_id:chId,event_id:evId,characters_involved:inv?JSON.stringify(inv):null});return{changes:0};}
export function upsertSetting(f,s=_store){return s._upsert("settings",["novel_id","title"],f);}
export function listSettingsByNovel(nid,s=_store){return s._filter("settings",s=>s.novel_id===nid);}
export function searchByKeyword(kw,nid,s=_store){const k=kw.toLowerCase();const r=[];const add=(t,title,nId)=>{if(nid&&nId!==nid)return;const n=getNovelById(nId,s);r.push({result_type:t,title,novel_id:nId,novel_title:n?.title||""});};for(const c of s._all("characters")){if((c.name+c.aliases+c.description).toLowerCase().includes(k))add("character",c.name,c.novel_id);}for(const e of s._all("events")){if((e.title+e.description).toLowerCase().includes(k))add("event",e.title,e.novel_id);}for(const p of s._all("plot_points")){if((p.title+p.description).toLowerCase().includes(k))add("plot_point",p.title,p.novel_id);}return r.slice(0,50);}
export function exportNovelSnapshot(nid,s=_store){const novel=getNovelById(nid,s);if(!novel)return null;return{novel,volumes:s._filter("volumes",v=>v.novel_id===nid),chapters:listChapters(nid,s),characters:listCharactersByNovel(nid,s),character_states:s._filter("character_states",cs=>{const ch=getChapterById(cs.chapter_id,s);const chr=s._find("characters",c=>c.id===cs.character_id);return ch&&chr&&chr.novel_id===nid;}),plot_points:listPlotPoints(nid,null,s),events:s._filter("events",e=>e.novel_id===nid),settings:listSettingsByNovel(nid,s)};}

// ═══ A3: 缓存层 ═══
export function getCache(filePath,s=_store){return s.cacheGet(filePath);}
export function setCache(filePath,data,s=_store){s.cacheSet(filePath,data);}
export function clearCache(filePath,s=_store){s.cacheClear(filePath);}

// ═══ A4: AtomicFact 细粒度事实 ═══
export function insertAtomicFacts(novelId,chapter,facts,s=_store){const results=[];for(const f of facts){results.push(s._insert("atomic_facts",{novel_id:novelId,chapter,content:f.content,tags:Array.isArray(f.tags)?f.tags.join(","):(f.tags||"")}));}return results;}
export function listAtomicFacts(novelId,s=_store){return s._filter("atomic_facts",f=>f.novel_id===novelId).sort((a,b)=>a.chapter-b.chapter);}
export function searchAtomicFacts(novelId,query,s=_store){const k=query.toLowerCase();const tags=k.split(/[,，\s]+/).filter(t=>t);return s._filter("atomic_facts",f=>{if(f.novel_id!==novelId)return false;const text=(f.content+f.tags).toLowerCase();return tags.some(t=>text.includes(t));});}

// ═══ A1: 写作规则库 ═══
export function insertSkillMemory(f,s=_store){return s._insert("skill_memories",f);}
export function listSkillMemories(novelId,s=_store){return s._filter("skill_memories",sm=>sm.novel_id===novelId);}
export function querySkillsByCharacter(novelId,characterName,scope,s=_store){let r=s._filter("skill_memories",sm=>sm.novel_id===novelId&&sm.character_name===characterName);if(scope)r=r.filter(sm=>sm.scope===scope);return r.sort((a,b)=>(b.confidence||0)-(a.confidence||0));}
export function updateSkillConfidence(id,delta,s=_store){const row=s._find("skill_memories",sm=>sm.id===id);if(!row)return{changes:0};const newConf=Math.min(1,Math.max(0,(row.confidence||0.5)+delta));return s._update("skill_memories",id,{confidence:newConf});}

// ═══ A2: 伏笔关系表 ═══
export function insertForeshadowRelation(f,s=_store){return s._insert("foreshadow_relations",f);}
export function listForeshadowRelations(novelId,s=_store){return s._filter("foreshadow_relations",r=>r.novel_id===novelId);}
export function getForeshadowRelations(novelId,fid,s=_store){const outgoing=s._filter("foreshadow_relations",r=>r.novel_id===novelId&&r.source_id===fid);const incoming=s._filter("foreshadow_relations",r=>r.novel_id===novelId&&r.target_id===fid);return{outgoing:outgoing.map(r=>({target_id:r.target_id,type:r.relation_type,condition:r.condition||""})),incoming:incoming.map(r=>({source_id:r.source_id,type:r.relation_type,condition:r.condition||""}))};}
