// ============================================================
// stl-parser.js — Parse binary & ASCII STL files
// Returns: { triangles, volumeMm3, volumeMl, dimensions, triangleCount }
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
  const triangles = isAscii
    ? parseAscii(new TextDecoder().decode(buffer))
    : parseBinary(buffer);

  const { volumeMm3, dimensions } = calcVolumeAndBounds(triangles);

  return {
    filename,
    triangles,           // Array<[[x,y,z],[x,y,z],[x,y,z]]>
    volumeMm3,
    volumeMl: volumeMm3 / 1000,   // cm³ = mL
    dimensions,          // { x, y, z } in mm
    triangleCount: triangles.length,
    isAscii,
  };
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
function parseBinary(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 84) throw new Error('Not a valid STL file (too small)');

  const numTri = view.getUint32(80, true);
  const expected = 84 + numTri * 50;
  if (buffer.byteLength < expected) {
    throw new Error(`STL truncated: expected ${expected} bytes, got ${buffer.byteLength}`);
  }

  const triangles = new Array(numTri);
  let o = 84;
  for (let i = 0; i < numTri; i++) {
    o += 12; // skip normal
    triangles[i] = [
      [view.getFloat32(o,    true), view.getFloat32(o+4,  true), view.getFloat32(o+8,  true)],
      [view.getFloat32(o+12, true), view.getFloat32(o+16, true), view.getFloat32(o+20, true)],
      [view.getFloat32(o+24, true), view.getFloat32(o+28, true), view.getFloat32(o+32, true)],
    ];
    o += 36 + 2; // 3 vertices + attribute bytes
  }
  return triangles;
}

// ---- ASCII STL parser --------------------------------------------------
function parseAscii(text) {
  const triangles = [];
  const vertexRe = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
  let vertices = [];
  let m;
  while ((m = vertexRe.exec(text)) !== null) {
    vertices.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    if (vertices.length === 3) {
      triangles.push([...vertices]);
      vertices = [];
    }
  }
  return triangles;
}

// ---- Volume & bounding box via divergence theorem ---------------------
function calcVolumeAndBounds(triangles) {
  let vol = 0;
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;

  for (const [v1, v2, v3] of triangles) {
    // Signed volume of tetrahedron from origin
    vol +=
      v1[0] * (v2[1] * v3[2] - v2[2] * v3[1]) +
      v1[1] * (v2[2] * v3[0] - v2[0] * v3[2]) +
      v1[2] * (v2[0] * v3[1] - v2[1] * v3[0]);

    for (const v of [v1, v2, v3]) {
      if (v[0] < mnX) mnX = v[0]; if (v[0] > mxX) mxX = v[0];
      if (v[1] < mnY) mnY = v[1]; if (v[1] > mxY) mxY = v[1];
      if (v[2] < mnZ) mnZ = v[2]; if (v[2] > mxZ) mxZ = v[2];
    }
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
 * Build a Float32Array suitable for THREE.BufferGeometry from parsed triangles.
 * Optionally decimates for viewer performance (keeps every Nth triangle).
 */
export function trianglesToPositions(triangles, maxTriangles = 200_000) {
  const step = triangles.length > maxTriangles
    ? Math.ceil(triangles.length / maxTriangles)
    : 1;

  const count = Math.ceil(triangles.length / step);
  const positions = new Float32Array(count * 9);
  let idx = 0;

  for (let i = 0; i < triangles.length; i += step) {
    const [v1, v2, v3] = triangles[i];
    positions[idx++] = v1[0]; positions[idx++] = v1[1]; positions[idx++] = v1[2];
    positions[idx++] = v2[0]; positions[idx++] = v2[1]; positions[idx++] = v2[2];
    positions[idx++] = v3[0]; positions[idx++] = v3[1]; positions[idx++] = v3[2];
  }

  return positions.subarray(0, idx);
}
