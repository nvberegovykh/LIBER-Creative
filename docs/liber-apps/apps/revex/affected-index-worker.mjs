import { projectAffectedIndex, indexError } from './affected-index-reader.mjs?v=20260914r192-morning1';

let started = false, acknowledge = null;
self.onmessage = async event => {
  if (event.data?.type === 'continue') { acknowledge?.(); acknowledge = null; return; }
  if (started || event.data?.type !== 'read') return;
  started = true;
  try {
    const result = await projectAffectedIndex(event.data.file, {
      expectedRevision: event.data.expectedRevision,
      onProgress: progress => new Promise(resolve => {
        acknowledge = resolve;
        self.postMessage({ type: 'progress', ...progress });
      })
    });
    self.postMessage({ type: 'complete', ...result });
  } catch (error) {
    const safe = error?.code?.startsWith('revex/index-') ? error : indexError();
    self.postMessage({ type: 'failed', code: safe.code, message: safe.message });
  }
};
