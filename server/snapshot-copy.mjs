import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import copyFrom from './vendor/pg-copy-streams/copy-from.js';

// Freeze the same JSON representation synchronously, before database awaits.
// Keep modest strings instead of one huge string plus pg's full parameter buffer.
export function encodeSnapshot(snapshot, stringify, chunkSize = 256 * 1024) {
  const chunks = [];
  let parts = [], length = 0, bytes = 0;
  const flush = () => {
    if (!parts.length) return;
    const chunk = parts.join('');
    chunks.push(chunk); bytes += Buffer.byteLength(chunk);
    parts = []; length = 0;
  };
  const add = text => {
    if (length && length + text.length > chunkSize) flush();
    parts.push(text); length += text.length;
    if (length >= chunkSize) flush();
  };
  add('{');
  let first = true;
  for (const key of Object.keys(snapshot)) {
    const value = snapshot[key];
    if (Array.isArray(value) && typeof value.toJSON !== 'function') {
      add((first ? '' : ',') + JSON.stringify(key) + ':['); first = false;
      for (let i = 0; i < value.length; i++) add((i ? ',' : '') + (stringify(value[i]) ?? 'null'));
      add(']');
    } else {
      const encoded = stringify(value);
      if (encoded === undefined) continue;
      add((first ? '' : ',') + JSON.stringify(key) + ':' + encoded); first = false;
    }
  }
  add('}'); flush();
  return { chunks, bytes };
}

export const escapeCopyText = text => String(text).replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');

// Caller owns BEGIN/TRUNCATE/COMMIT. A failed COPY must be rolled back by caller.
export async function writeSnapshotCopy(client, stateKey, encoded) {
  function* row() {
    yield escapeCopyText(stateKey) + '\t';
    for (const chunk of encoded.chunks) yield escapeCopyText(chunk);
    yield '\n';
  }
  const stream = client.query(copyFrom('COPY phone_cloud_state (state_key, data) FROM STDIN'));
  await pipeline(Readable.from(row(), { objectMode: false }), stream);
  if (stream.rowCount !== 1) throw new Error('snapshot_copy_row_count');
}
