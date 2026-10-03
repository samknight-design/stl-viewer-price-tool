// supabase/functions/shopify-relay/stl.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import {
  detectAscii,
  InvalidStlError,
  measureStlBuffer,
  measureStlStream,
  StlStalledError,
  StlTooLargeError,
} from "./stl.ts";

/** Twelve outward-wound triangles for an a x b x c box at the origin. */
function boxTriangles(a: number, b: number, c: number): number[][] {
  const p000 = [0, 0, 0], p100 = [a, 0, 0], p110 = [a, b, 0], p010 = [0, b, 0];
  const p001 = [0, 0, c], p101 = [a, 0, c], p111 = [a, b, c], p011 = [0, b, c];
  return [
    [p000, p110, p100], [p000, p010, p110], // z = 0
    [p001, p101, p111], [p001, p111, p011], // z = c
    [p000, p100, p101], [p000, p101, p001], // y = 0
    [p010, p011, p111], [p010, p111, p110], // y = b
    [p000, p001, p011], [p000, p011, p010], // x = 0
    [p100, p110, p111], [p100, p111, p101], // x = a
  ].map((tri) => tri.flat());
}

function binaryStl(triangles: number[][], header = "test cube"): Uint8Array {
  const buf = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode(header).subarray(0, 80), 0);
  view.setUint32(80, triangles.length, true);
  let o = 84;
  for (const tri of triangles) {
    o += 12; // normal left as zeros; the parser skips it
    for (const v of tri) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    o += 2; // attribute byte count
  }
  return bytes;
}

function asciiStl(triangles: number[][]): Uint8Array {
  const lines = ["solid test"];
  for (const t of triangles) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (let i = 0; i < 9; i += 3) {
      lines.push(`      vertex ${t[i]} ${t[i + 1]} ${t[i + 2]}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid test");
  return new TextEncoder().encode(lines.join("\n"));
}

/** Feeds bytes through in fixed-size pieces, so chunk boundaries land in the
 *  middle of records / lines — the case a naive parser gets wrong. */
function chunkedStream(bytes: Uint8Array, chunkSize: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

Deno.test("binary STL: volume and bounding box of a known box", async () => {
  const m = await measureStlBuffer(binaryStl(boxTriangles(10, 20, 30)));
  assertEquals(m.isAscii, false);
  assertEquals(m.triangleCount, 12);
  // 10 x 20 x 30 mm = 6000 mm3 = 6 mL
  assertEquals(Math.round(m.volumeMm3), 6000);
  assertEquals(Number(m.volumeMl.toFixed(6)), 6);
  assertEquals(m.dimensions, { x: 10, y: 20, z: 30 });
});

Deno.test("ASCII STL: same box measures the same", async () => {
  const m = await measureStlBuffer(asciiStl(boxTriangles(10, 20, 30)));
  assertEquals(m.isAscii, true);
  assertEquals(m.triangleCount, 12);
  assertEquals(Math.round(m.volumeMm3), 6000);
  assertEquals(m.dimensions, { x: 10, y: 20, z: 30 });
});

Deno.test("detectAscii: a binary file whose header starts with 'solid'", () => {
  const bytes = binaryStl(boxTriangles(1, 1, 1), "solid but actually binary");
  assertEquals(detectAscii(bytes), false);
});

Deno.test("binary STL survives chunk boundaries mid-record", async () => {
  const bytes = binaryStl(boxTriangles(10, 20, 30));
  // 7 is deliberately coprime with both the 84-byte header and the 50-byte
  // record, so nearly every chunk lands mid-record.
  for (const size of [7, 13, 50, 83, 97]) {
    const m = await measureStlStream(chunkedStream(bytes, size));
    assertEquals(m.triangleCount, 12, `chunk size ${size}`);
    assertEquals(Math.round(m.volumeMm3), 6000, `chunk size ${size}`);
    assertEquals(m.dimensions, { x: 10, y: 20, z: 30 }, `chunk size ${size}`);
  }
});

Deno.test("ASCII STL survives chunk boundaries mid-line", async () => {
  const bytes = asciiStl(boxTriangles(10, 20, 30));
  for (const size of [5, 17, 64]) {
    const m = await measureStlStream(chunkedStream(bytes, size));
    assertEquals(m.triangleCount, 12, `chunk size ${size}`);
    assertEquals(Math.round(m.volumeMm3), 6000, `chunk size ${size}`);
  }
});

Deno.test("truncated binary STL is rejected, not priced short", async () => {
  const full = binaryStl(boxTriangles(10, 20, 30));
  // Drop the last two triangles: a cheaper, smaller-looking mesh.
  const truncated = full.subarray(0, full.length - 100);
  await assertRejects(
    () => measureStlBuffer(truncated),
    InvalidStlError,
  );
});

Deno.test("a file over the ceiling is refused rather than measured", async () => {
  const bytes = binaryStl(boxTriangles(10, 20, 30));
  await assertRejects(
    () => measureStlStream(chunkedStream(bytes, 64), 100),
    StlTooLargeError,
  );
});

Deno.test("an empty mesh reports zero dimensions, not Infinity", async () => {
  const m = await measureStlBuffer(binaryStl([]));
  assertEquals(m.triangleCount, 0);
  assertEquals(m.volumeMm3, 0);
  assertEquals(m.dimensions, { x: 0, y: 0, z: 0 });
});

Deno.test("a stalled stream fails fast instead of hanging the worker", async () => {
  // The King Charming case: a truncated upload whose metadata claims the full
  // size. Storage delivers part of it and then stops forever. Before the
  // deadline existed this waited until the platform killed the function, which
  // returned no response at all and made add-to-cart silently do nothing.
  const bytes = binaryStl(boxTriangles(10, 20, 30));
  const partial = bytes.subarray(0, 600);
  const stalling = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(partial);
      // ...and then never close and never enqueue again.
    },
  });

  const started = Date.now();
  await assertRejects(
    () => measureStlStream(stalling, { stallMs: 150, totalMs: 2_000 }),
    StlStalledError,
  );
  // Must give up on its own, nowhere near any platform timeout.
  const elapsed = Date.now() - started;
  assertEquals(elapsed < 1_500, true, `gave up after ${elapsed}ms`);
});

Deno.test("a slow-but-steady trickle still hits the overall deadline", async () => {
  // Defeats a stall timeout by dribbling one byte at a time — the 40 KB/s
  // behaviour the corrupt file actually showed.
  const bytes = binaryStl(boxTriangles(10, 20, 30));
  let i = 0;
  const trickle = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 5));
      if (i < bytes.length) controller.enqueue(bytes.subarray(i, ++i));
      // Never closes: there is always another byte "coming".
    },
  });

  await assertRejects(
    () => measureStlStream(trickle, { stallMs: 1_000, totalMs: 300 }),
    StlStalledError,
  );
});

Deno.test("a file too small to be an STL is rejected", async () => {
  await assertRejects(
    () => measureStlBuffer(new Uint8Array([1, 2, 3, 4])),
    InvalidStlError,
  );
});
