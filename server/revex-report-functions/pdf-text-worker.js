'use strict';

const { parentPort } = require('node:worker_threads');
const { PDFParse } = require('pdf-parse');

if (!parentPort) throw new Error('REVEX PDF parser must run in an isolated worker thread.');

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error('Isolated PDF parser received an invalid execution boundary.');
  return parsed;
}

function errorDetail(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 120),
    message: String(error?.message || error || 'Unknown parser failure.').slice(0, 2000),
    stack: String(error?.stack || '').slice(0, 8000)
  };
}

parentPort.once('message', async message => {
  let parser = null;
  try {
    if (!(message?.bytes instanceof Uint8Array) || !message.bytes.byteLength)
      throw new Error('Isolated PDF parser received no owned byte payload.');
    const maxPages = boundedInteger(message.maxPages, 1, 64);
    const maxTextChars = boundedInteger(message.maxTextChars, 1, 250000);
    parser = new PDFParse({ data: message.bytes, isEvalSupported: false, stopAtErrors: true });
    const result = await parser.getText({ first: maxPages });
    const text = String(result?.text || '').slice(0, maxTextChars);
    await parser.destroy();
    parser = null;
    parentPort.postMessage({ ok: true, text });
  } catch (error) {
    if (parser) {
      try { await parser.destroy(); } catch (_) {}
    }
    parentPort.postMessage({ ok: false, error: errorDetail(error) });
  } finally {
    parentPort.close();
  }
});
