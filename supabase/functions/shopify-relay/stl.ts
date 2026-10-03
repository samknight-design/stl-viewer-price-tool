// supabase/functions/shopify-relay/stl.ts
//
// Server-side STL measurement — the geometry half of server-side pricing.
//
// This is a deliberate port of the browser's js/stl-parser.js, with one
// structural difference: it never materialises the triangle array.
//
// The browser keeps every triangle because the viewer has to draw them. We
// only ever need volume and the bounding box, both of which are running
// accumulations, so triangles are consumed from the network stream and
// discarded 50 bytes at a time. That matters here and not in the browser: an
// Edge Function gets 256 MB, and holding a large STL the way the browser does
// (measured at ~8x the file size on a 17 MB file) would OOM the relay on a
// file the bucket happily accepts. Streaming keeps the high-water mark at
// roughly one chunk, so file size stops being the binding constraint.
//
// Float parity with the browser is load-bearing: both sides read float32s and
// accumulate in float64, so the same file yields an identical volume on both.
// Do not "improve" this to read float64 — it would silently drift the server's
// price away from the one the customer was shown.

export interface StlMeasurement {
  volumeMm3: number;
  volumeMl: number;
  dimensions: { x: number; y: number; z: number };
  triangleCount: number;
  isAscii: boolean;
  bytesRead: number;
}

export class StlTooLargeError extends Error {}
export class InvalidStlError extends Error {}

/** The stream stopped delivering bytes and never finished.
 *
 *  This is not hypothetical. AF-20261003-CHFO/Model-3/King Charming.stl is an
 *  incomplete upload: its header declares 307,560 triangles (implying exactly
 *  15,378,084 bytes) and storage METADATA agrees, but storage can only serve
 *  2.4 MB before it stalls at ~40 KB/s and never completes. With no deadline,
 *  measuring it simply waited — the edge function was killed at its 150s idle
 *  limit having sent no response at all, which is how a single bad file turned
 *  into "add to cart does nothing". A truncated file must fail fast and loudly;
 *  the truncation check at the end of the read never runs if the read never
 *  ends. */
export class StlStalledError extends Error {}

export interface MeasureLimits {
  /** Hard ceiling on bytes read. */
  maxBytes?: number;
  /** Give up if no bytes at all arrive for this long. */
  stallMs?: number;
  /** Give up if the whole read exceeds this, however steady the trickle. */
  totalMs?: number;
}

const DEFAULT_STALL_MS = 15_000;
const DEFAULT_TOTAL_MS = 90_000;

/** Races a read against the stall timeout and the overall deadline, so a
 *  stream that stops (or crawls) can never hold the worker open. */
async function readWithDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  stallMs: number,
  deadlineAt: number,
): Promise<ReadableStreamReadResult<T>> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new StlStalledError("exceeded the overall measurement deadline");
  }
  const wait = Math.min(stallMs, remaining);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StlStalledError(`no data for ${wait}ms`)),
          wait,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Running volume + bounding-box accumulation, shared by both parsers. */
class Accumulator {
  vol = 0;
  triangleCount = 0;
  mnX = Infinity;
  mnY = Infinity;
  mnZ = Infinity;
  mxX = -Infinity;
  mxY = -Infinity;
  mxZ = -Infinity;

  addTriangle(
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
    v3x: number, v3y: number, v3z: number,
  ): void {
    // Signed volume of the tetrahedron from the origin (divergence theorem).
    // Identical expression to calcVolumeAndBounds in js/stl-parser.js.
    this.vol +=
      v1x * (v2y * v3z - v2z * v3y) +
      v1y * (v2z * v3x - v2x * v3z) +
      v1z * (v2x * v3y - v2y * v3x);

    if (v1x < this.mnX) this.mnX = v1x;
    if (v1x > this.mxX) this.mxX = v1x;
    if (v1y < this.mnY) this.mnY = v1y;
    if (v1y > this.mxY) this.mxY = v1y;
    if (v1z < this.mnZ) this.mnZ = v1z;
    if (v1z > this.mxZ) this.mxZ = v1z;
    if (v2x < this.mnX) this.mnX = v2x;
    if (v2x > this.mxX) this.mxX = v2x;
    if (v2y < this.mnY) this.mnY = v2y;
    if (v2y > this.mxY) this.mxY = v2y;
    if (v2z < this.mnZ) this.mnZ = v2z;
    if (v2z > this.mxZ) this.mxZ = v2z;
    if (v3x < this.mnX) this.mnX = v3x;
    if (v3x > this.mxX) this.mxX = v3x;
    if (v3y < this.mnY) this.mnY = v3y;
    if (v3y > this.mxY) this.mxY = v3y;
    if (v3z < this.mnZ) this.mnZ = v3z;
    if (v3z > this.mxZ) this.mxZ = v3z;

    this.triangleCount++;
  }

  finish(isAscii: boolean, bytesRead: number): StlMeasurement {
    const volumeMm3 = Math.abs(this.vol) / 6;
    // An empty mesh leaves the bounds at +/-Infinity; report zeros rather than
    // NaN dimensions, which would otherwise sail into the tier lookup and
    // compare as "fits any plate".
    const empty = this.triangleCount === 0;
    return {
      volumeMm3,
      volumeMl: volumeMm3 / 1000,
      dimensions: empty
        ? { x: 0, y: 0, z: 0 }
        : {
          x: this.mxX - this.mnX,
          y: this.mxY - this.mnY,
          z: this.mxZ - this.mnZ,
        },
      triangleCount: this.triangleCount,
      isAscii,
      bytesRead,
    };
  }
}

/** Mirrors detectAscii() in js/stl-parser.js: a binary STL may also begin with
 *  the word "solid" in its 80-byte header, so the decision needs the facet
 *  keywords, not just the prefix. */
export function detectAscii(head: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const first = decoder.decode(head.subarray(0, Math.min(256, head.length)));
  if (!first.trimStart().toLowerCase().startsWith("solid")) return false;
  const preview = decoder.decode(head.subarray(0, Math.min(1024, head.length)));
  return /facet\s+normal|endloop|endfacet/i.test(preview);
}

const VERTEX_RE = /vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/;
const RECORD_BYTES = 50; // 12 normal + 36 vertices + 2 attribute bytes
const HEADER_BYTES = 84; // 80 header + 4 triangle count
const DETECT_BYTES = 1024;

/**
 * Measure an STL arriving as a byte stream.
 *
 * maxBytes is a hard ceiling: the read stops and the call throws
 * StlTooLargeError rather than reading past it, so a hostile or accidental
 * upload cannot pin the function's memory or run out its wall clock. The
 * caller decides what to do with a file over the ceiling — we route it to
 * manual review rather than pricing it blind.
 */
export async function measureStlStream(
  stream: ReadableStream<Uint8Array>,
  limits: number | MeasureLimits = {},
): Promise<StlMeasurement> {
  // The bare-number form is the original signature, kept so callers that only
  // care about the size ceiling read naturally.
  const opts: MeasureLimits = typeof limits === "number"
    ? { maxBytes: limits }
    : limits;
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const deadlineAt = Date.now() + (opts.totalMs ?? DEFAULT_TOTAL_MS);

  const reader = stream.getReader();
  const acc = new Accumulator();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  let bytesRead = 0;
  let head: Uint8Array | null = null; // held back until the format is known
  let mode: "unknown" | "ascii" | "binary" = "unknown";

  // Binary state
  let carry = new Uint8Array(0); // bytes not yet consumed as whole records
  let headerSkipped = false;
  let declaredTriangles = 0;

  // ASCII state
  let textCarry = "";
  let pending: number[] = []; // vertices seen but not yet a full triangle

  function consumeAsciiText(text: string): void {
    textCarry += text;
    // Keep the final (possibly partial) line back for the next chunk.
    const lastBreak = textCarry.lastIndexOf("\n");
    if (lastBreak === -1) return;
    const complete = textCarry.slice(0, lastBreak);
    textCarry = textCarry.slice(lastBreak + 1);
    for (const line of complete.split("\n")) {
      const m = VERTEX_RE.exec(line);
      if (!m) continue;
      pending.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
      if (pending.length === 9) {
        acc.addTriangle(
          pending[0], pending[1], pending[2],
          pending[3], pending[4], pending[5],
          pending[6], pending[7], pending[8],
        );
        pending = [];
      }
    }
  }

  function consumeBinary(chunk: Uint8Array): void {
    if (carry.length) {
      const merged = new Uint8Array(carry.length + chunk.length);
      merged.set(carry, 0);
      merged.set(chunk, carry.length);
      carry = merged;
    } else {
      // Copy, because the reader may reuse the chunk's backing buffer.
      carry = chunk.slice();
    }

    let offset = 0;
    if (!headerSkipped) {
      if (carry.length < HEADER_BYTES) return; // wait for the full header
      const headerView = new DataView(
        carry.buffer,
        carry.byteOffset,
        carry.byteLength,
      );
      declaredTriangles = headerView.getUint32(80, true);
      offset = HEADER_BYTES;
      headerSkipped = true;
    }

    const view = new DataView(carry.buffer, carry.byteOffset, carry.byteLength);
    while (carry.length - offset >= RECORD_BYTES) {
      const o = offset + 12; // skip the normal
      acc.addTriangle(
        view.getFloat32(o, true),
        view.getFloat32(o + 4, true),
        view.getFloat32(o + 8, true),
        view.getFloat32(o + 12, true),
        view.getFloat32(o + 16, true),
        view.getFloat32(o + 20, true),
        view.getFloat32(o + 24, true),
        view.getFloat32(o + 28, true),
        view.getFloat32(o + 32, true),
      );
      offset += RECORD_BYTES;
    }
    // Copy the remainder out so the consumed bytes can be collected.
    carry = carry.slice(offset);
  }

  function appendHead(value: Uint8Array): void {
    if (!head) {
      head = value.slice();
      return;
    }
    const merged = new Uint8Array(head.length + value.length);
    merged.set(head, 0);
    merged.set(value, head.length);
    head = merged;
  }

  /** Returns the decided format rather than assigning `mode` itself: an
   *  assignment inside a closure defeats TypeScript's narrowing, and the
   *  checks after the read loop then look unreachable to the compiler. */
  function decideFormat(headBytes: Uint8Array): "ascii" | "binary" {
    const decided = detectAscii(headBytes) ? "ascii" : "binary";
    if (decided === "ascii") {
      consumeAsciiText(decoder.decode(headBytes, { stream: true }));
    } else {
      consumeBinary(headBytes);
    }
    return decided;
  }

  try {
    for (;;) {
      const { done, value } = await readWithDeadline(reader, stallMs, deadlineAt);
      if (done) break;
      if (!value || value.length === 0) continue;

      bytesRead += value.length;
      if (bytesRead > maxBytes) {
        throw new StlTooLargeError(
          `STL exceeds the ${maxBytes}-byte measurement ceiling`,
        );
      }

      if (mode === "unknown") {
        appendHead(value);
        if (head!.length < DETECT_BYTES) continue; // not enough to decide yet
        mode = decideFormat(head!);
        head = null;
        continue;
      }

      if (mode === "ascii") {
        consumeAsciiText(decoder.decode(value, { stream: true }));
      } else {
        consumeBinary(value);
      }
    }

    // A file shorter than DETECT_BYTES never tripped the decision above.
    if (mode === "unknown") {
      if (!head) throw new InvalidStlError("Empty file");
      mode = decideFormat(head);
      head = null;
    }

    if (mode === "ascii") {
      // Flush the decoder and whatever line had no trailing newline.
      consumeAsciiText(decoder.decode() + "\n");
    } else {
      if (!headerSkipped) {
        throw new InvalidStlError("Not a valid STL file (too small)");
      }
      // The browser treats a short binary file as fatal rather than pricing a
      // partial mesh; match that, or a truncated upload would quietly price as
      // a smaller (cheaper) model than the customer intends to print.
      if (declaredTriangles > 0 && acc.triangleCount !== declaredTriangles) {
        throw new InvalidStlError(
          `STL truncated: header declares ${declaredTriangles} triangles, read ${acc.triangleCount}`,
        );
      }
    }

    return acc.finish(mode === "ascii", bytesRead);
  } finally {
    // Cancel rather than release: on the throw paths above this is what stops
    // us draining a huge file we have already rejected.
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
}

/** Convenience wrapper for tests and small in-memory inputs. */
export function measureStlBuffer(
  buffer: ArrayBuffer | Uint8Array,
  maxBytes?: number | MeasureLimits,
): Promise<StlMeasurement> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return measureStlStream(stream, maxBytes ?? {});
}
