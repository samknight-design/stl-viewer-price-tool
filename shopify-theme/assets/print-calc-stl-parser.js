// ============================================================
// stl-parser.js — Parse binary & ASCII STL files
// Returns: { triangles, volumeMm3, volumeMl, dimensions, triangleCount, skippedTriangles }
// ============================================================

/**
 * Parse an STL File object and return mesh data + volume.
 * @param {File} file
 * @param {function} onProgress — called with (loaded, total) bytes
 * @returns {Promise<STLData>}
 */
export async function parseSTLFile(file, onProgress) {
  const buffer = await readFileAsBuffer(file, onProgress);
  return parseSTLBuffer(buffer, file.name);
}

export function parseSTLBuffer(buffer, filename = '') {
  const isAscii = detectAscii(buffer);
  const raw = isAscii
    ? parseAscii(new TextDecoder().decode(buffer))
    : parseBinary(buffer);

  const { positions: triangles, skipped } = dropNonFiniteTriangles(raw);
  const total = raw.length / 9;
  if (skipped > 0 && skipped / total > MAX_SKIPPED_TRIANGLE_FRACTION) {
    throw new Error(
      `This file has damaged geometry (${skipped.toLocaleString()} of ${total.toLocaleString()} ` +
      "triangles have invalid coordinates), so we can't measure it. Please repair the mesh " +
      '(most slicers and Meshmixer can do this) and upload the repaired STL.'
    );
  }

  const { volumeMm3, dimensions } = calcVolumeAndBounds(triangles);

  return {
    filename,
    triangles,           // Flat Float32Array: 9 floats/triangle (v1xyz,v2xyz,v3xyz)
    volumeMm3,
    volumeMl: volumeMm3 / 1000,   // cm³ = mL
    dimensions,          // { x, y, z } in mm
    triangleCount: triangles.length / 9,
    skippedTriangles: skipped,
    isAscii,
  };
}

// ---- Non-finite vertices -----------------------------------------------
// Some real exports contain triangles with NaN (or infinite) coordinates —
// 18 of ~3,400 files in the DM Stash library, typically a few hundred bad
// triangles in a mesh of millions. One NaN poisons the whole volume sum, and
// a NaN volume then prices PLA as NaN and drops primer through to its
// maximum tier (every NaN comparison fails). So those triangles are removed
// before measuring, and before the viewer sees them (a NaN vertex also
// breaks three.js's bounding sphere). Losing a handful of triangles moves the
// volume negligibly; losing more than this fraction means the mesh itself is
// broken and any price would be a guess, so the file is rejected instead.
//
// Mirrored in supabase/functions/shopify-relay/stl.ts — keep the threshold
// and the skip rule identical, or the relay's price check will disagree with
// the price the customer was shown.
const MAX_SKIPPED_TRIANGLE_FRACTION = 0.01;

function dropNonFiniteTriangles(positions) {
  let skipped = 0;
  for (let i = 0; i < positions.length; i += 9) {
    if (!triangleIsFinite(positions, i)) skipped++;
  }
  if (skipped === 0) return { positions, skipped };

  const kept = new Float32Array(positions.length - skipped * 9);
  let idx = 0;
  for (let i = 0; i < positions.length; i += 9) {
    if (!triangleIsFinite(positions, i)) continue;
    kept.set(positions.subarray(i, i + 9), idx);
    idx += 9;
  }
  return { positions: kept, skipped };
}

function triangleIsFinite(positions, i) {
  for (let k = i; k < i + 9; k++) {
    if (!Number.isFinite(positions[k])) return false;
  }
  return true;
}

// ---- ASCII detection ---------------------------------------------------
function detectAscii(buffer) {
  // Read first 256 bytes as text
  const chunk = new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
  if (!text.trimStart().toLowerCase().startsWith('solid')) return false;
  // Binary STL can also start with "solid" in the 80-byte header, so
  // look for ASCII facet keywords within the first 1 KB.
  const preview = new TextDecoder('utf-8', { fatal: false }).decode(
    new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength))
  );
  return /facet\s+normal|endloop|endfacet/i.test(preview);
}

// ---- Binary STL parser -------------------------------------------------
// Parses straight into a flat Float32Array (9 floats/triangle) rather than
// nested JS arrays (`[[x,y,z],[x,y,z],[x,y,z]]`). The nested form costs many
// times the raw file size in memory — V8 pays a per-array object overhead
// four times over for every triangle — so a real-world multi-million-
// triangle STL (tens of MB on disk) could balloon to gigabytes and take the
// browser tab out with an out-of-memory crash, especially with several such
// files loaded in the same session. A typed array stores exactly the 36
// bytes/triangle it needs and fails fast with a catchable RangeError if a
// file is genuinely too large, instead of silently exhausting memory.
function parseBinary(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 84) throw new Error('Not a valid STL file (too small)');

  const numTri = view.getUint32(80, true);
  const expected = 84 + numTri * 50;
  if (buffer.byteLength < expected) {
    throw new Error(`STL truncated: expected ${expected} bytes, got ${buffer.byteLength}`);
  }

  const positions = new Float32Array(numTri * 9);
  let o = 84, idx = 0;
  for (let i = 0; i < numTri; i++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      positions[idx++] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count
  }
  return positions;
}

// ---- ASCII STL parser --------------------------------------------------
function parseAscii(text) {
  const positions = [];
  // Any token, not just numeric characters: a vertex written as `nan` or
  // `-inf` must still count as a vertex (and come out non-finite, to be
  // skipped above). Matching digits only dropped that line, which shifted
  // every later vertex into the wrong triangle.
  const vertexRe = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = vertexRe.exec(text)) !== null) {
    positions.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return Float32Array.from(positions);
}

// ---- Volume & bounding box via divergence theorem ---------------------
function calcVolumeAndBounds(positions) {
  let vol = 0;
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 9) {
    const v1x = positions[i],   v1y = positions[i+1], v1z = positions[i+2];
    const v2x = positions[i+3], v2y = positions[i+4], v2z = positions[i+5];
    const v3x = positions[i+6], v3y = positions[i+7], v3z = positions[i+8];

    // Signed volume of tetrahedron from origin
    vol +=
      v1x * (v2y * v3z - v2z * v3y) +
      v1y * (v2z * v3x - v2x * v3z) +
      v1z * (v2x * v3y - v2y * v3x);

    if (v1x < mnX) mnX = v1x; if (v1x > mxX) mxX = v1x;
    if (v1y < mnY) mnY = v1y; if (v1y > mxY) mxY = v1y;
    if (v1z < mnZ) mnZ = v1z; if (v1z > mxZ) mxZ = v1z;
    if (v2x < mnX) mnX = v2x; if (v2x > mxX) mxX = v2x;
    if (v2y < mnY) mnY = v2y; if (v2y > mxY) mxY = v2y;
    if (v2z < mnZ) mnZ = v2z; if (v2z > mxZ) mxZ = v2z;
    if (v3x < mnX) mnX = v3x; if (v3x > mxX) mxX = v3x;
    if (v3y < mnY) mnY = v3y; if (v3y > mxY) mxY = v3y;
    if (v3z < mnZ) mnZ = v3z; if (v3z > mxZ) mxZ = v3z;
  }

  return {
    volumeMm3: Math.abs(vol) / 6,
    dimensions: { x: mxX - mnX, y: mxY - mnY, z: mxZ - mnZ },
  };
}

// ---- File reader helper ------------------------------------------------
function readFileAsBuffer(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    if (onProgress) reader.onprogress = e => onProgress(e.loaded, e.total);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Build a Float32Array suitable for THREE.BufferGeometry from parsed
 * triangles (already a flat Float32Array). Optionally decimates for viewer
 * performance (keeps every Nth triangle). Returns the input array unchanged
 * (no copy) when no decimation is needed.
 */
export function trianglesToPositions(triangles, maxTriangles = 200_000) {
  const triCount = triangles.length / 9;
  if (triCount <= maxTriangles) return triangles;

  const step = Math.ceil(triCount / maxTriangles);
  const keepCount = Math.ceil(triCount / step);
  const positions = new Float32Array(keepCount * 9);
  let idx = 0;

  for (let t = 0; t < triCount; t += step) {
    const o = t * 9;
    for (let k = 0; k < 9; k++) positions[idx++] = triangles[o + k];
  }

  return positions.subarray(0, idx);
}
