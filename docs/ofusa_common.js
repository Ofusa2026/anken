/**
 * ofusa_common.js - OFUSA書類作成システム 共通モジュール
 * ver.20260415.01
 */

// ===== Supabase =====
const SB_URL='https://ehwlgbwpycglmopiqyty.supabase.co';
const SB_KEY='sb_publishable_3ptyILIpGIcNA5sUBhFMbA_n0VxpY2u';
async function sb(path,opts={}){
  const r=await fetch(SB_URL+'/rest/v1/'+path,{headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json',...(opts.headers||{})},...opts});
  const t=await r.text();
  if(!r.ok){const e=t?JSON.parse(t):{};throw new Error(e.message||e.hint||('HTTP '+r.status));}
  return t?JSON.parse(t):null;
}

// ===== ユーティリティ =====
const esc=s=>s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
const v=id=>document.getElementById(id)?.value||'';
const fmt=n=>n?Number(String(n).replace(/,/g,'')).toLocaleString('ja-JP'):'';
const f=id=>{const raw=v(id);const val=esc(raw).replace(/\n/g,'<br>');const label=id.replace(/^es_/,'es.').replace(/^f_/,'');return val?`<span class="f">${val}</span>`:`<span class="f" style="color:#aaa;font-size:0.85em;font-family:monospace;">${label}</span>`;};
const ff=id=>{const raw=v(id);const label=id.replace(/^es_/,'es.').replace(/^f_/,'');if(raw){const num=Number(String(raw).replace(/,/g,''));return`<span class="f">${isNaN(num)?esc(raw):num.toLocaleString('ja-JP')}</span>`;}return`<span class="f" style="color:#aaa;font-size:0.85em;font-family:monospace;">${label}</span>`;};

// ===== チェックボックス =====
window.cbState=window.cbState||{};
let _cbSeq=0;
function resetCbSeq(){_cbSeq=0;}
const cb=(on,id)=>{const state=id&&window.cbState[id]!==undefined?window.cbState[id]:on;return`<span class="cb-click" onclick="toggleCb('${id||''}')" data-cbid="${id||''}">${state?'■':'□'}</span>`;};
function toggleCb(id){if(!id)return;window.cbState[id]=!window.cbState[id];document.querySelectorAll(`[data-cbid="${id}"]`).forEach(el=>{el.textContent=window.cbState[id]?'■':'□';});}

// ===== 印刷・トースト =====
function doPrint(){window.print();}
function showToast(msg){const t=document.createElement('div');t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:white;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.3);font-family:sans-serif;';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000);}

// ===== 文字サイズ =====
let _fontSize=8.5,_editMode=false,_editLock=false;
function _applyFontSize(){let st=document.getElementById('_fontSizeStyle');if(!st){st=document.createElement('style');st.id='_fontSizeStyle';document.head.appendChild(st);}st.textContent=`.doc{font-size:${_fontSize}pt!important;}.doc .id{font-size:${(_fontSize*7.5/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:9pt"]{font-size:${(_fontSize*9/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:8pt"]{font-size:${(_fontSize*8/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:8.5pt"]{font-size:${_fontSize}pt!important;}.doc [style*="font-size:7.5pt"]{font-size:${(_fontSize*7.5/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:7pt"]{font-size:${(_fontSize*7/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:6.5pt"]{font-size:${(_fontSize*6.5/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:6pt"]{font-size:${(_fontSize*6/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:15pt"]{font-size:${(_fontSize*15/8.5).toFixed(2)}pt!important;}.doc [style*="font-size:10pt"]{font-size:${(_fontSize*10/8.5).toFixed(2)}pt!important;}`;}
function changeFontSize(delta){if(_editMode){const sel=window.getSelection();if(sel&&!sel.isCollapsed){const range=sel.getRangeAt(0);const newSize=delta===0?8.5:Math.round(Math.max(5,Math.min(14,_fontSize+delta))*2)/2;const span=document.createElement('span');span.style.fontSize=newSize+'pt';try{range.surroundContents(span);sel.removeAllRanges();}catch(e){const frag=range.extractContents();span.appendChild(frag);range.insertNode(span);}}const lbl=document.getElementById('fontSizeLabel');if(lbl)lbl.textContent=(delta===0?8.5:Math.round(Math.max(5,Math.min(14,_fontSize+delta))*2)/2)+'pt';return;}if(delta===0){_fontSize=8.5;}else{_fontSize=Math.round(Math.max(5,Math.min(14,_fontSize+delta))*2)/2;}_applyFontSize();const lbl=document.getElementById('fontSizeLabel');if(lbl)lbl.textContent=_fontSize+'pt';}

// ===== 直接編集モード =====
function toggleEditMode(){_editMode=!_editMode;const btn=document.getElementById('editModeBtn');const area=document.getElementById('pageArea');if(_editMode){_editLock=true;if(btn){btn.textContent='✏️ 編集中（クリックで終了）';btn.classList.add('edit-mode-on');}if(area)area.classList.add('edit-mode');enableDocEditing(true);}else{_editLock=false;if(btn){btn.textContent='✏️ 直接編集';btn.classList.remove('edit-mode-on');}if(area)area.classList.remove('edit-mode');enableDocEditing(false);if(typeof p==='function')p();}}
function enableDocEditing(on){const area=document.getElementById('pageArea');if(!area)return;area.querySelectorAll('.doc').forEach(doc=>{if(on){doc.setAttribute('contenteditable','true');doc.classList.add('doc-editable');doc.querySelectorAll('.cb-click').forEach(cb=>cb.setAttribute('contenteditable','false'));}else{doc.removeAttribute('contenteditable');doc.classList.remove('doc-editable');}});}

// ===== ページナビ =====
function scrollToPage(n){const area=document.getElementById('pageArea');if(!area)return;const docs=area.querySelectorAll('.doc');if(docs[n-1])docs[n-1].scrollIntoView({behavior:'smooth',block:'start'});document.querySelectorAll('.pn-btn-page').forEach((b,i)=>b.classList.toggle('active',i===n-1));}
function setupPageTracker(){const area=document.getElementById('pageArea');if(!area)return;area.addEventListener('scroll',()=>{const docs=area.querySelectorAll('.doc');const areaTop=area.getBoundingClientRect().top;let active=0;docs.forEach((d,i)=>{if(d.getBoundingClientRect().top-areaTop<100)active=i;});document.querySelectorAll('.pn-btn-page').forEach((b,i)=>b.classList.toggle('active',i===active));});}

// ===== 案件選択 =====
let _allCases=[],_companyFolderMap={},_orgFolderMap={};
async function initCaseSelect(){
  const sel=document.getElementById('caseSelect');if(!sel)return;
  sel.innerHTML='<option value="">読込中...</option>';
  try{
    const [cosRes,sosRes]=await Promise.all([
      sb('companies?select=id,name,folder_no,support_org_name&limit=2000'),
      sb('support_orgs?select=name,folder_no&limit=500')
    ]);
    _companyFolderMap={};window._companyNameFolderMap={};window._allCompanies=[];
    (cosRes||[]).forEach(c=>{const n=parseInt(c.folder_no)||99999;_companyFolderMap[c.id]=n;if(!window._companyNameFolderMap[c.name]||n<window._companyNameFolderMap[c.name])window._companyNameFolderMap[c.name]=n;window._allCompanies.push({name:c.name,folderNo:n,orgName:c.support_org_name||''});});
    _orgFolderMap={};(sosRes||[]).forEach(s=>{_orgFolderMap[s.name||'']=parseInt(s.folder_no)||99999;});
    let all=[],offset=0,pageSize=1000;
    while(true){const chunk=await sb('cases?select=id,name,applicant,company,company_id,org,emp_set_idx,applicant_field,applicant_field_en&status=not.in.(完了,審査完了)&order=created_at.desc&limit='+pageSize+'&offset='+offset);if(!chunk||!chunk.length)break;all=all.concat(chunk);if(chunk.length<pageSize)break;offset+=pageSize;}
    _allCases=all;buildFilterOptions();filterCases();
  }catch(e){console.warn('案件取得エラー:',e);if(sel)sel.innerHTML='<option value="">取得エラー</option>';}
}
function _sortOrgs(arr){return[...arr].sort((a,b)=>{const fa=_orgFolderMap[a]||99999,fb=_orgFolderMap[b]||99999;return fa!==fb?fa-fb:a.localeCompare(b,'ja');});}
function buildFilterOptions(){const orgSel=document.getElementById('filterOrg');if(!orgSel)return;const orgs=_sortOrgs([...new Set(_allCases.map(r=>r.org||'').filter(Boolean))]);const prevOrg=orgSel.value;orgSel.innerHTML='<option value="">── すべて ──</option>';orgs.forEach(o=>{const el=document.createElement('option');el.value=o;const fn=_orgFolderMap[o];el.textContent=(fn&&fn<99999?fn+'. ':'')+o;orgSel.appendChild(el);});if(prevOrg)orgSel.value=prevOrg;rebuildCompanyList(orgSel.value);}
function rebuildCompanyList(orgV){const coSel=document.getElementById('filterCompany');if(!coSel)return;const prevCo=coSel.value;const allCos=window._allCompanies||[];const filtered=orgV?allCos.filter(c=>c.orgName===orgV):allCos;const seen={},unique=[];filtered.forEach(c=>{if(!seen[c.name]){seen[c.name]=true;unique.push(c);}});unique.sort((a,b)=>a.folderNo!==b.folderNo?a.folderNo-b.folderNo:a.name.localeCompare(b.name,'ja'));coSel.innerHTML='<option value="">── すべて ──</option>';unique.forEach(c=>{const el=document.createElement('option');el.value=c.name;el.textContent=(c.folderNo<99999?c.folderNo+'. ':'')+c.name;coSel.appendChild(el);});if(unique.some(c=>c.name===prevCo))coSel.value=prevCo;}
function filterCases(){const orgV=(document.getElementById('filterOrg')||{}).value||'';const coV=(document.getElementById('filterCompany')||{}).value||'';const txtV=((document.getElementById('filterText')||{}).value||'').trim().toLowerCase();rebuildCompanyList(orgV);const words=txtV?txtV.split(/\s+/).filter(Boolean):[];let filtered=_allCases.filter(r=>{if(orgV&&(r.org||'')!==orgV)return false;if(coV&&(r.company||'')!==coV)return false;if(words.length){const hay=((r.name||'')+' '+(r.applicant||'')+' '+(r.company||'')+' '+(r.org||'')).toLowerCase();if(!words.every(w=>hay.includes(w)))return false;}return true;});const sel=document.getElementById('caseSelect');const cnt=document.getElementById('caseCount');const MAX=200;if(filtered.length>MAX&&!coV&&!words.length){sel.innerHTML='<option value="">← 登録支援機関・所属機関で絞り込むか、名前を入力してください</option>';sel.disabled=true;if(cnt)cnt.textContent='('+filtered.length+'件・絞り込んでください)';return;}sel.disabled=false;const prev=sel.value;sel.innerHTML='<option value="">── 選択 ──</option>';const frag=document.createDocumentFragment();filtered.forEach(r=>{const o=document.createElement('option');o.value=JSON.stringify({caseId:r.id,companyId:r.company_id,companyName:r.company||'',empSetIdx:r.emp_set_idx,applicantField:r.applicant_field||'',applicantFieldEn:r.applicant_field_en||''});o.textContent=(r.applicant||r.name||'(名前なし)')+'　('+(r.company||'')+')';frag.appendChild(o);});sel.appendChild(frag);if(cnt)cnt.textContent='('+filtered.length+'件)';if(prev)sel.value=prev;}
