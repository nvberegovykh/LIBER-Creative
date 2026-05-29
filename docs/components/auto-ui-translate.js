(function(){
  if (window.LiberAutoUiTranslator) return;

  const CACHE_KEY = 'liber_ui_translate_cache_v2';
  const SOURCE_ATTR = 'data-i18n-source';
  const ATTR_SOURCE_PREFIX = 'data-i18n-source-';
  const MAX_TRANSLATABLE_TEXT_LENGTH = 2400;
  const SPLIT_CHUNK_LENGTH = 320;
  let cache = null;
  let saveTimer = 0;
  const inFlightByLang = new Map();
  const nodeIds = new WeakMap();
  const latestLangByNode = new Map();
  let nodeIdSeq = 1;

  function normalizeLang(lang){
    const code = String(lang || 'en').trim().toLowerCase();
    return code || 'en';
  }

  // ── Static bundle lookup ──────────────────────────────────────────────────
  // window.LiberI18nBundle is loaded from /components/i18n-bundle.js
  // Shape: { lang: { normalizedSource: translation } }
  function normalizeSource(s){
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function lookupBundle(lang, source){
    const b = window.LiberI18nBundle;
    if (!b) return null;
    const langMap = b[lang];
    if (!langMap) return null;
    const norm = normalizeSource(source);
    const hit = langMap[norm];
    return (hit && hit !== norm) ? hit : null;
  }

  // ── localStorage cache ────────────────────────────────────────────────────
  function loadCache(){
    if (cache) return cache;
    try{
      const raw = localStorage.getItem(CACHE_KEY);
      cache = raw ? (JSON.parse(raw) || {}) : {};
    }catch(_){
      cache = {};
    }
    return cache;
  }

  function saveCacheSoon(){
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(()=>{
      saveTimer = 0;
      try{
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache || {}));
      }catch(_){ }
    }, 120);
  }

  function getCacheKey(lang, text){
    return `${lang}::${text}`;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function shouldSkipElement(el){
    if (!(el instanceof Element)) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (['script','style','code','pre','noscript','svg','path','option','optgroup'].includes(tag)) return true;
    if (el.matches('[data-no-auto-translate],[contenteditable="true"]')) return true;
    if (el.closest('[data-no-auto-translate],.message,.post-item,#global-feed,#space-feed,.messages,.chat-app,.code-block,[contenteditable="true"]')) return true;
    if (el.hasAttribute('data-i18n')) return true;
    return false;
  }

  function isTranslatableLeaf(el){
    if (shouldSkipElement(el)) return false;
    if (el.childElementCount > 0) return false;
    const text = String(el.getAttribute(SOURCE_ATTR) || el.textContent || '').trim();
    if (!text) return false;
    if (text.length < 2 || text.length > MAX_TRANSLATABLE_TEXT_LENGTH) return false;
    if (/^[\d\s.,:;!?()+\-/%#@&]+$/.test(text)) return false;
    return true;
  }

  function collectLeafNodes(root){
    const out = [];
    const base = (root instanceof Element || root instanceof Document) ? root : document.body;
    if (!base) return out;
    base.querySelectorAll('*').forEach((el)=>{
      if (!isTranslatableLeaf(el)) return;
      if (!el.getAttribute(SOURCE_ATTR)){
        const src = String(el.textContent || '').trim();
        if (src) el.setAttribute(SOURCE_ATTR, src);
      }
      const source = String(el.getAttribute(SOURCE_ATTR) || '').trim();
      if (!source) return;
      out.push({ el, source });
    });
    return out;
  }

  function getNodeId(node){
    if (!node || !(node instanceof Element || node instanceof Document)) return 'doc';
    let id = nodeIds.get(node);
    if (!id){
      id = `n${nodeIdSeq++}`;
      nodeIds.set(node, id);
    }
    return id;
  }

  function shouldTranslateAttr(el, attr){
    if (shouldSkipElement(el)) return false;
    if (el.closest('select')) return false;
    const raw = String(el.getAttribute(attr) || '').trim();
    if (!raw) return false;
    if (raw.length < 2 || raw.length > MAX_TRANSLATABLE_TEXT_LENGTH) return false;
    if (/^[\d\s.,:;!?()+\-/%#@&]+$/.test(raw)) return false;
    return true;
  }

  function collectAttributeNodes(root){
    const out = [];
    const base = (root instanceof Element || root instanceof Document) ? root : document.body;
    if (!base) return out;
    const attrs = ['placeholder','title','aria-label'];
    base.querySelectorAll('*').forEach((el)=>{
      attrs.forEach((attr)=>{
        if (!shouldTranslateAttr(el, attr)) return;
        const sourceAttr = `${ATTR_SOURCE_PREFIX}${attr}`;
        if (!el.getAttribute(sourceAttr)){
          const src = String(el.getAttribute(attr) || '').trim();
          if (src) el.setAttribute(sourceAttr, src);
        }
        const source = String(el.getAttribute(sourceAttr) || '').trim();
        if (!source) return;
        out.push({ el, source, attr });
      });
    });
    return out;
  }

  function restoreProtectedSources(root){
    try{
      const base = (root instanceof Element || root instanceof Document) ? root : document.body;
      if (!base) return;
      base.querySelectorAll(`[${SOURCE_ATTR}]`).forEach((el)=>{
        const tag = String(el.tagName || '').toLowerCase();
        if (tag !== 'option' && tag !== 'optgroup') return;
        const source = String(el.getAttribute(SOURCE_ATTR) || '').trim();
        if (source) el.textContent = source;
      });
    }catch(_){ }
  }

  // ── LLM fallback ──────────────────────────────────────────────────────────
  function extractJsonObject(text){
    const raw = String(text || '').trim();
    if (!raw) return null;
    try{ return JSON.parse(raw); }catch(_){ }
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]){
      try{ return JSON.parse(fenced[1]); }catch(_){ }
    }
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj && obj[0]){
      try{ return JSON.parse(obj[0]); }catch(_){ }
    }
    return null;
  }

  function getTranslatorEndpoints(){
    const projectId = String(window.firebaseService?.app?.options?.projectId || '').trim();
    if (!projectId) return [];
    const pref = String(localStorage.getItem('liber_functions_region') || '').trim();
    const regions = Object.keys(window.firebaseService?.functionsByRegion || {});
    const order = Array.from(new Set([pref, ...regions, 'europe-west1', 'us-central1'].filter(Boolean)));
    return order.map((r)=> `https://${r}-${projectId}.cloudfunctions.net/openaiProxy/v1/chat/completions`);
  }

  async function translateBatch(texts, targetLang){
    const list = Array.isArray(texts) ? texts.map((t)=> String(t || '').trim()).filter(Boolean) : [];
    if (!list.length) return {};
    const endpoints = getTranslatorEndpoints();
    if (!endpoints.length) return {};

    const splitLongText = (text, maxLen = SPLIT_CHUNK_LENGTH)=>{
      const raw = String(text || '');
      if (raw.length <= maxLen) return [raw];
      const out = [];
      let rest = raw;
      while (rest.length > maxLen){
        const scan = rest.slice(0, maxLen + 1);
        const minBreak = Math.floor(maxLen * 0.55);
        let cut = -1;
        const preferredBreaks = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', '];
        preferredBreaks.forEach((marker)=>{
          const idx = scan.lastIndexOf(marker);
          if (idx >= minBreak) cut = Math.max(cut, idx + marker.length);
        });
        if (cut < 0){
          const ws = scan.lastIndexOf(' ');
          if (ws >= Math.floor(maxLen * 0.5)) cut = ws + 1;
        }
        if (cut < 0) cut = maxLen;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest) out.push(rest);
      return out.filter((s)=> String(s || '').length > 0);
    };

    const expanded = [];
    const plan = list.map((source)=>{
      const parts = splitLongText(source, SPLIT_CHUNK_LENGTH);
      const start = expanded.length;
      expanded.push(...parts);
      return { source, start, count: parts.length };
    });

    for (const endpoint of endpoints){
      try{
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0.1,
            messages: [
              {
                role: 'system',
                content: `You are a native professional UI translator. Translate each string into ${targetLang}. Keep meaning, tone, punctuation and concise UI style. Output strict JSON only with this shape: {"translations":["..."]}. No explanations.`
              },
              {
                role: 'user',
                content: JSON.stringify({ texts: expanded })
              }
            ]
          })
        });
        if (!resp.ok) continue;
        const data = await resp.json().catch(()=> ({}));
        const content = String(data?.choices?.[0]?.message?.content || '').trim();
        const parsed = extractJsonObject(content);
        const translations = Array.isArray(parsed?.translations) ? parsed.translations : null;
        if (!translations || translations.length !== expanded.length) continue;
        const out = {};
        plan.forEach(({ source, start, count })=>{
          const parts = translations.slice(start, start + count).map((x)=> String(x || ''));
          const joined = parts.join('');
          out[source] = joined || source;
        });
        return out;
      }catch(_){ }
    }
    return {};
  }

  // ── Main translate routine ────────────────────────────────────────────────
  async function translateRoot(root, lang){
    const targetRoot = root || document.body;
    const code = normalizeLang(lang);
    const nodeId = getNodeId(targetRoot);
    const runKey = `${code}::${nodeId}`;
    latestLangByNode.set(nodeId, code);

    const existing = inFlightByLang.get(runKey);
    if (existing){
      existing.pending = true;
      return existing.promise;
    }

    const entry = { pending: false, promise: null };
    inFlightByLang.set(runKey, entry);

    // Resolve a translation for a source string using all 3 layers:
    // 1. static bundle (instant, no network)
    // 2. localStorage cache (instant, persisted from prior LLM calls)
    // 3. LLM (async, stored back into cache)
    function resolveStatic(source){
      return lookupBundle(code, source) || null;
    }

    const applyFromStore = (nodes, attrNodes, store, onlySources = null)=>{
      const allow = onlySources instanceof Set ? onlySources : null;
      if (latestLangByNode.get(nodeId) !== code) return false;
      nodes.forEach(({ el, source })=>{
        if (allow && !allow.has(source)) return;
        // prefer bundle hit over cache
        const next = resolveStatic(source)
          || String(store[getCacheKey(code, source)] || source).trim()
          || source;
        if (el && next && el.textContent !== next) el.textContent = next;
      });
      attrNodes.forEach(({ el, source, attr })=>{
        if (allow && !allow.has(source)) return;
        const next = resolveStatic(source)
          || String(store[getCacheKey(code, source)] || source).trim()
          || source;
        if (el && attr && next && el.getAttribute(attr) !== next) el.setAttribute(attr, next);
      });
      return true;
    };

    entry.promise = (async ()=>{
      do{
        entry.pending = false;
        restoreProtectedSources(targetRoot);
        const nodes = collectLeafNodes(targetRoot);
        const attrNodes = collectAttributeNodes(targetRoot);
        if (!nodes.length && !attrNodes.length) continue;
        const store = loadCache();

        if (code === 'en'){
          if (latestLangByNode.get(nodeId) !== code) continue;
          nodes.forEach(({ el, source })=>{ if (el && source && el.textContent !== source) el.textContent = source; });
          attrNodes.forEach(({ el, source, attr })=>{ if (el && source && attr && el.getAttribute(attr) !== source) el.setAttribute(attr, source); });
          continue;
        }

        const uniq = [];
        const seen = new Set();
        nodes.forEach(({ source })=>{
          if (seen.has(source)) return;
          seen.add(source);
          uniq.push(source);
        });
        attrNodes.forEach(({ source })=>{
          if (seen.has(source)) return;
          seen.add(source);
          uniq.push(source);
        });

        // Apply bundle + cache immediately — zero network latency for known strings.
        if (!applyFromStore(nodes, attrNodes, store)) continue;

        // Only call LLM for strings not in bundle AND not in cache.
        const missing = uniq.filter((s)=>{
          if (resolveStatic(s)) return false;          // bundle hit → skip
          if (store[getCacheKey(code, s)]) return false; // cache hit → skip
          return true;
        });

        const chunkSize = 20;
        for (let i = 0; i < missing.length; i += chunkSize){
          if (latestLangByNode.get(nodeId) !== code) break;
          const chunk = missing.slice(i, i + chunkSize);
          const translated = await translateBatch(chunk, code);
          chunk.forEach((src)=>{
            const next = String(translated[src] || src).trim() || src;
            store[getCacheKey(code, src)] = next;
          });
          saveCacheSoon();
          applyFromStore(nodes, attrNodes, store, new Set(chunk));
        }
      } while (entry.pending && latestLangByNode.get(nodeId) === code);
    })().finally(()=>{
      inFlightByLang.delete(runKey);
    });

    return entry.promise;
  }

  window.LiberAutoUiTranslator = {
    translateRoot,
    clearCache: function(){
      cache = {};
      try{ localStorage.removeItem(CACHE_KEY); }catch(_){ }
    }
  };
})();
