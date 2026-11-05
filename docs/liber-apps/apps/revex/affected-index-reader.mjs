import { JSONParser, TokenType as T } from './vendor/streamparser-json-0.0.26/index.js';

// A document-index projection only. The immutable input File remains the report
// authority and is never rewritten, serialized, or replaced by this result.
export const LIMITS = Object.freeze({ chunkBytes: 65536, tokenChars: 65536, depth: 32,
  keysPerObject: 256, views: 5000, changedIds: 2000000, projectionChars: 32 * 1024 * 1024 });
const TOP = ['schema','revision','sourceRevision','source','exportedAt','changedElementCount','hadDeletion'];
const VIEW = ['id','uniqueId','name','viewType','levelId','levelUniqueId','levelName','levelElevation',
  'reason','pdf','fileName','changedElementIds'];
const messages = {
  invalid: 'The affected-plan index is malformed or incomplete. The preserved revision was not published.',
  limits: 'The affected-plan index exceeds safe document-reader limits. The preserved revision was not published.',
  canceled: 'The affected-plan index read was canceled. The preserved revision can be retried.',
  revision: 'The affected-plan index does not belong to this revision. Nothing was published.'
};
export function indexError(code = 'invalid') {
  return Object.assign(new Error(messages[code] || messages.invalid), { code: `revex/index-${code}` });
}
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const idValue = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value);
const isScalar = value => value === null || ['string','number','boolean'].includes(typeof value);

export async function projectAffectedIndex(file, { expectedRevision, assertCurrent = () => {}, onProgress = async () => {} } = {}) {
  const result = { views: [] }, frames = [], seenViews = new Set(), seenPdfs = new Set();
  const stats = { inputBytes: 0, chunks: 0, views: 0, changedIds: 0, retainedChars: 0, maxDepth: 0, maxChunkBytes: 0 };
  let rootComplete = false, sawViews = false, progressAt = 0;
  const parser = new JSONParser({ paths: [...TOP.map(key => `$.${key}`), ...VIEW.map(key => `$.views.*.${key}`)],
    keepStack: false, emitPartialTokens: true, stringBufferSize: LIMITS.chunkBytes, numberBufferSize: 64 });
  // Revit IDs are 64-bit. Preserve integer lexemes which JS cannot represent;
  // do not round them before Docs/history indexes receive them.
  parser.tokenizer.parseNumber = text => {
    if (text.length > LIMITS.tokenChars) throw indexError('limits');
    const number = Number(text);
    if (!Number.isFinite(number)) throw indexError();
    return /^-?\d+$/.test(text) && !Number.isSafeInteger(number) ? text : number;
  };
  const completeValue = () => { const frame = frames.at(-1); if (frame) { frame.expectKey = frame.kind === 'object'; frame.index++; } };
  const account = value => {
    stats.retainedChars += typeof value === 'string' ? value.length : 16;
    if (stats.retainedChars > LIMITS.projectionChars) throw indexError('limits');
  };
  const checkView = row => {
    if (!row || !Array.isArray(row.changedElementIds) || !(row.pdf || row.fileName) || !(row.uniqueId || row.id !== undefined || row.name)) throw indexError();
    for (const key of VIEW.filter(key => key !== 'changedElementIds')) if (own(row,key) && !isScalar(row[key])) throw indexError();
    for (const key of ['pdf','fileName','name','uniqueId','reason','viewType','levelName','levelUniqueId'])
      if (own(row,key) && row[key] !== null && typeof row[key] !== 'string') throw indexError();
    if (typeof (row.pdf || row.fileName) !== 'string' || !(row.pdf || row.fileName).trim()) throw indexError();
    const identity = String(row.uniqueId || row.id || row.name), path = (row.pdf || row.fileName).replaceAll('\\','/').toLowerCase();
    if (seenViews.has(identity) || seenPdfs.has(path)) throw indexError();
    seenViews.add(identity); seenPdfs.add(path);
  };
  // This monitor owns only bounded container/key metadata and schema shape.
  // JSON syntax, Unicode escapes, numbers and truncation remain the library's job.
  parser.onToken = ({ token, value, partial }) => {
    if (typeof value === 'string' && value.length > LIMITS.tokenChars) throw indexError('limits');
    if (partial) return;
    const frame = frames.at(-1);
    if (token === T.STRING && frame?.kind === 'object' && frame.expectKey) {
      if (frame.keys.has(value)) throw indexError();
      frame.keys.add(value);
      if (frame.keys.size > LIMITS.keysPerObject) throw indexError('limits');
      frame.key = value; frame.expectKey = false; return;
    }
    if (token === T.COLON || token === T.COMMA) return;
    if (token === T.RIGHT_BRACE || token === T.RIGHT_BRACKET) {
      if (!frame) throw indexError();
      if (frame.path.length === 2 && frame.path[0] === 'views') checkView(result.views[frame.path[1]]);
      frames.pop(); completeValue();
      if (!frames.length) rootComplete = true;
      return;
    }
    const path = !frame ? [] : [...frame.path, frame.kind === 'object' ? frame.key : frame.index];
    if (!path.length && token !== T.LEFT_BRACE) throw indexError();
    if (path.length === 1 && path[0] === 'views') {
      if (token !== T.LEFT_BRACKET) throw indexError();
      sawViews = true;
    }
    if (path.length === 2 && path[0] === 'views') {
      if (token !== T.LEFT_BRACE || path[1] >= LIMITS.views) throw indexError(token === T.LEFT_BRACE ? 'limits' : 'invalid');
      result.views[path[1]] = {};
      stats.views++;
    }
    if (path.length === 3 && path[0] === 'views') {
      const key = path[2];
      if (['changedElementIds','changedRegions','unlocatedChangedElementIds'].includes(key) && token !== T.LEFT_BRACKET) throw indexError();
      if (VIEW.includes(key) && key !== 'changedElementIds' && (token === T.LEFT_BRACKET || token === T.LEFT_BRACE)) throw indexError();
    }
    if (path.length === 4 && path[0] === 'views' && path[2] === 'changedElementIds') {
      if (!idValue(value) || (token !== T.NUMBER && token !== T.STRING)) throw indexError();
      if (++stats.changedIds > LIMITS.changedIds) throw indexError('limits');
      account(value);
    }
    if (token === T.LEFT_BRACE || token === T.LEFT_BRACKET) {
      frames.push({ kind: token === T.LEFT_BRACE ? 'object' : 'array', path, key: null, index: 0,
        expectKey: token === T.LEFT_BRACE, keys: new Set() });
      stats.maxDepth = Math.max(stats.maxDepth,frames.length);
      if (frames.length > LIMITS.depth) throw indexError('limits');
    } else completeValue();
  };
  parser.onValue = ({ value, key, stack }) => {
    if (stack.length === 1) {
      if (!isScalar(value)) throw indexError();
      result[key] = value; account(value);
    } else if (stack.length === 3 && stack[1].key === 'views') {
      const row = result.views[stack[2].key];
      if (!row) throw indexError();
      row[key] = value;
      if (key !== 'changedElementIds') account(value);
    }
  };
  try {
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.slice !== 'function') throw indexError();
    const decoder = new TextDecoder('utf-8',{ fatal: true });
    for (let offset = 0; offset < file.size; offset += LIMITS.chunkBytes) {
      assertCurrent();
      const bytes = new Uint8Array(await file.slice(offset,Math.min(file.size,offset + LIMITS.chunkBytes)).arrayBuffer());
      assertCurrent();
      if (bytes.byteLength !== Math.min(LIMITS.chunkBytes,file.size-offset)) throw indexError();
      stats.inputBytes += bytes.byteLength; stats.chunks++; stats.maxChunkBytes = Math.max(stats.maxChunkBytes,bytes.byteLength);
      parser.write(decoder.decode(bytes,{ stream: true }));
      if (stats.inputBytes-progressAt >= 1024 * 1024) { await onProgress({ bytes: stats.inputBytes, total: file.size }); assertCurrent(); progressAt = stats.inputBytes; }
    }
    const tail = decoder.decode(); if (tail) parser.write(tail);
    if (!parser.isEnded) parser.end();
    assertCurrent();
    if (!parser.isEnded || !rootComplete || frames.length || !sawViews || stats.views !== result.views.length ||
      !['liber.revex.affected-plan-views.v1','liber.revex.affected-plan-views.v2'].includes(result.schema) ||
      !Number.isSafeInteger(result.changedElementCount) || result.changedElementCount < 0 || typeof result.hadDeletion !== 'boolean') throw indexError();
    const compatibilityEmpty = result.schema.endsWith('.v1') && result.views.length === 0 && result.revision === null &&
      ['compatibility-empty-for-pre-0.8.4-import','compatibility-empty-for-pre-0.8.4-retry'].includes(result.source);
    if (!compatibilityEmpty && (typeof result.revision !== 'string' || !result.revision || result.revision !== expectedRevision ||
      (result.sourceRevision !== undefined && result.sourceRevision !== expectedRevision))) throw indexError('revision');
    result.documentProjection = { schema: 'liber.revex.affected-document-projection.v1', originalEvidencePreserved: true };
    return { index: result, stats };
  } catch (error) {
    // The parser's original errors can include JSON fragments. Never return them
    // to UI, logs, native bridge, telemetry or worker error events.
    throw error?.code?.startsWith('revex/index-') ? error : indexError();
  }
}
