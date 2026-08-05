// ============================================================
// viewer.js — Three.js 3D model viewer + thumbnail generator
// - mergeVertices for smooth solid surfaces (no topology look)
// - Auto-orient: detects Z-up (slicer format) → rotates to Y-up
// - Multiple viewer themes: Resin, Clay, Studio
// ============================================================

import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { mergeVertices }  from 'three/addons/utils/BufferGeometryUtils.js';
import { trianglesToPositions } from './print-calc-stl-parser.js';

// ---- Viewer Themes ---------------------------------------------------
// Each theme drives background, model colour, specular response, and lighting.
// Clay uses near-full ambient (intensity 1.8) to eliminate support shadow artefacts.

export const VIEWER_THEMES = {
  resin: {
    name: 'Resin',
    bg:        0x0c0b09,
    model:     0xd0c8bc,
    specular:  0x5a4030,
    shininess: 28,
    grid_a:    0x2e2820,
    grid_b:    0x1a130c,
    lights: [
      { type: 'hemi', sky: 0xfff4e0, ground: 0x2a1a08, intensity: 1.1 },
      { type: 'dir',  color: 0xfff0d8, intensity: 0.60, pos: [2,  4,  3] },
      { type: 'dir',  color: 0x8099c0, intensity: 0.35, pos: [-3,-1, -2] },
      { type: 'dir',  color: 0xfff4e0, intensity: 0.35, pos: [-1, 3, -1] },
      { type: 'dir',  color: 0xfff4e0, intensity: 0.20, pos: [0, -2,  2] }, // bottom fill
      { type: 'dir',  color: 0xe87a0a, intensity: 0.08, pos: [0, -5, -3] }, // ember rim
    ],
  },
  clay: {
    name: 'Clay',
    bg:        0x1a1a2a,
    model:     0xf0e8de,
    specular:  0x908070,
    shininess: 6,          // very matte — near-zero specular glare
    grid_a:    0x252535,
    grid_b:    0x151522,
    lights: [
      { type: 'hemi', sky: 0xffffff, ground: 0x9999cc, intensity: 1.8 }, // high ambient = no support shadows
      { type: 'dir',  color: 0xfff8f4, intensity: 0.18, pos: [1,  3,  2] },
      { type: 'dir',  color: 0xc8d8ff, intensity: 0.14, pos: [-2, 1, -2] },
      { type: 'dir',  color: 0xffffff, intensity: 0.12, pos: [0, -2,  2] },
    ],
  },
  studio: {
    name: 'Studio',
    bg:        0x080810,
    model:     0x90a8c0,
    specular:  0x203050,
    shininess: 60,
    grid_a:    0x12121c,
    grid_b:    0x0c0c14,
    lights: [
      { type: 'hemi', sky: 0x304060, ground: 0x040408, intensity: 0.55 },
      { type: 'dir',  color: 0xb8d4ff, intensity: 1.20, pos: [3,  5,  2] },
      { type: 'dir',  color: 0x402080, intensity: 0.18, pos: [-3, 0, -3] },
      { type: 'dir',  color: 0x00b8ff, intensity: 0.30, pos: [-1,-2, -4] },
    ],
  },
};

// ---- Scene builder ----------------------------------------------------

function buildScene(theme) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.bg);

  for (const l of theme.lights) {
    if (l.type === 'hemi') {
      scene.add(new THREE.HemisphereLight(l.sky, l.ground, l.intensity));
    } else if (l.type === 'dir') {
      const light = new THREE.DirectionalLight(l.color, l.intensity);
      light.position.set(...l.pos);
      scene.add(light);
    }
  }

  return scene;
}

// ---- Geometry helpers -------------------------------------------------

/**
 * Auto-orient geometry: most slicers export Z-up; Three.js uses Y-up.
 * Detects if Z is the dominant "height" axis and rotates accordingly.
 */
function autoOrient(geo) {
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);

  if (size.z >= size.x && size.z >= size.y) {
    // Standard slicer Z-up export → rotate to Y-up
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    geo.computeBoundingBox();
  } else if (size.x > size.z && size.x > size.y) {
    // X-up → rotate so X becomes Y
    geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    geo.computeBoundingBox();
  }
  // Y-up already → no rotation needed
}

/**
 * Build a smooth, solid mesh from a Float32Array of positions.
 * mergeVertices() connects the unshared STL vertices so that
 * computeVertexNormals() can average across triangle edges —
 * producing a smooth solid surface instead of a faceted topology look.
 */
function buildMesh(positions, theme) {
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  // Merge coincident vertices (STL has 3 independent verts per triangle)
  try {
    geo = mergeVertices(geo, 0.05);
  } catch (e) {
    console.warn('mergeVertices failed, using flat shading:', e);
  }
  geo.computeVertexNormals();

  // Auto-orient BEFORE centering so bounding-box is correct after rotation
  autoOrient(geo);

  // Centre at origin
  geo.computeBoundingBox();
  const centre = new THREE.Vector3();
  geo.boundingBox.getCenter(centre);
  geo.translate(-centre.x, -centre.y, -centre.z);
  geo.computeBoundingBox();

  const mat = new THREE.MeshPhongMaterial({
    color:       theme.model,
    specular:    theme.specular,
    shininess:   theme.shininess,
    side:        THREE.DoubleSide,
    transparent: false,
    opacity:     1.0,
  });

  return new THREE.Mesh(geo, mat);
}

/**
 * Position camera so the whole model is visible and nicely framed.
 *
 * Uses the bounding SPHERE (not a single bounding-box axis) to compute
 * distance — a model wide in two axes at once (a flat base, a disc) has
 * a diagonal on-screen footprint from this oblique angle bigger than any
 * single axis, so a single-axis heuristic under-frames it and clips the
 * edges. Fitting the sphere guarantees full coverage regardless of the
 * model's proportions or orientation.
 */
function fitCamera(camera, mesh, controls) {
  const box    = new THREE.Box3().setFromObject(mesh);
  const size   = new THREE.Vector3(); box.getSize(size);
  const sphere = new THREE.Sphere();  box.getBoundingSphere(sphere);
  const radius = sphere.radius;
  const maxDim = Math.max(size.x, size.y, size.z);

  const vFovRad = THREE.MathUtils.degToRad(camera.fov / 2);
  const hFovRad = Math.atan(Math.tan(vFovRad) * camera.aspect);
  const distV   = radius / Math.sin(vFovRad);
  const distH   = radius / Math.sin(hFovRad);
  const dist    = Math.max(distV, distH) * 1.15; // small margin so nothing touches the frame edge

  // Aim at the SAME point the distance was fitted around (the bounding
  // sphere's centre). Aiming anywhere else re-introduces asymmetric
  // clipping: the frustum is sized exactly to the sphere from this
  // look-at point, so any offset eats into that margin on one side.
  const dir = new THREE.Vector3(0.6, 0.45, 0.9).normalize();
  camera.position.set(
    sphere.center.x + dir.x * dist,
    sphere.center.y + dir.y * dist,
    sphere.center.z + dir.z * dist,
  );
  camera.lookAt(sphere.center);
  camera.near = Math.max(maxDim * 0.001, dist * 0.01);
  camera.far  = dist + maxDim * 300;
  camera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(sphere.center);
    controls.minDistance = maxDim * 0.2;
    controls.maxDistance = maxDim * 12;
    controls.update();
  }
}

// ---- Grid helper ------------------------------------------------------

function addGrid(scene, mesh, theme) {
  const box  = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3(); box.getSize(size);
  const span = Math.max(size.x, size.z) * 3.5;
  const grid = new THREE.GridHelper(span, 10, theme.grid_a, theme.grid_b);
  grid.position.y = box.min.y - 0.2;
  scene.add(grid);
  return grid;
}

// ---- Thumbnail (offscreen render) ------------------------------------

/**
 * Generate a static PNG thumbnail using the Resin theme.
 * Returns data-URL or null on failure.
 * Renders at 2× pixel ratio for crisp thumbnails on high-DPI displays.
 */
export function generateThumbnail(triangles, size = 380) {
  const theme = VIEWER_THEMES.resin;
  try {
    const canvas  = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(size, size);
    renderer.setPixelRatio(2);
    renderer.setClearColor(theme.bg);

    const scene  = buildScene(theme);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.001, 1e8);

    // No decimation cap here at all: this is a single offscreen render,
    // not a continuously-rendered scene, so triangle count doesn't cost
    // per-frame like it does in the interactive viewer. Any cap here
    // re-triggers the same bug at a higher threshold — STL facets aren't
    // spatially ordered, so naive "keep every Nth triangle" decimation
    // scatters holes across the whole surface once a model exceeds it
    // (support-heavy and highly detailed prints routinely do).
    const positions = trianglesToPositions(triangles, Infinity);
    const mesh      = buildMesh(positions, theme);
    scene.add(mesh);
    addGrid(scene, mesh, theme);
    fitCamera(camera, mesh, null);

    renderer.render(scene, camera);
    const dataURL = canvas.toDataURL('image/png');

    mesh.geometry.dispose();
    mesh.material.dispose();
    renderer.dispose();

    return dataURL;
  } catch (e) {
    console.warn('Thumbnail generation failed:', e);
    return null;
  }
}

// ---- Interactive viewer ----------------------------------------------

export class STLViewer {
  constructor(canvas, options = {}) {
    this._canvas   = canvas;
    this._opts     = { autoRotate: true, ...options };
    this._mesh     = null;
    this._grid     = null;
    this._rafId    = null;
    this._disposed = false;
    this._theme    = VIEWER_THEMES.resin;
    this._init();
  }

  _init() {
    const w = this._canvas.clientWidth  || 700;
    const h = this._canvas.clientHeight || 450;

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this._scene  = buildScene(this._theme);
    this._camera = new THREE.PerspectiveCamera(36, w / h, 0.001, 1e8);

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping   = true;
    this._controls.dampingFactor   = 0.06;
    this._controls.autoRotate      = this._opts.autoRotate;
    this._controls.autoRotateSpeed = 1.2;
    this._controls.mouseButtons    = {
      LEFT:   THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT:  THREE.MOUSE.PAN,
    };

    this._animate();
  }

  load(triangles) {
    if (this._mesh) {
      this._scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
    }
    if (this._grid) this._scene.remove(this._grid);

    // Higher poly limit for interactive viewer
    const positions = trianglesToPositions(triangles, 400_000);
    this._mesh      = buildMesh(positions, this._theme);
    this._scene.add(this._mesh);
    this._grid      = addGrid(this._scene, this._mesh, this._theme);

    fitCamera(this._camera, this._mesh, this._controls);
    return this;
  }

  /** Switch to a named theme ('resin' | 'clay' | 'studio'). */
  setTheme(name) {
    const theme = VIEWER_THEMES[name];
    if (!theme || theme === this._theme) return;
    this._theme = theme;

    // Update scene background
    this._scene.background = new THREE.Color(theme.bg);

    // Remove old lights, add new ones
    const toRemove = [];
    this._scene.traverse(obj => { if (obj.isLight) toRemove.push(obj); });
    toRemove.forEach(l => this._scene.remove(l));
    for (const l of theme.lights) {
      if (l.type === 'hemi') {
        this._scene.add(new THREE.HemisphereLight(l.sky, l.ground, l.intensity));
      } else if (l.type === 'dir') {
        const light = new THREE.DirectionalLight(l.color, l.intensity);
        light.position.set(...l.pos);
        this._scene.add(light);
      }
    }

    // Update mesh material colours
    if (this._mesh) {
      this._mesh.material.color.setHex(theme.model);
      this._mesh.material.specular.setHex(theme.specular);
      this._mesh.material.shininess  = theme.shininess;
      this._mesh.material.needsUpdate = true;
    }

    // Swap grid colours
    if (this._grid) {
      this._scene.remove(this._grid);
      this._grid = this._mesh ? addGrid(this._scene, this._mesh, theme) : null;
    }
  }

  setAutoRotate(val) { this._controls.autoRotate = val; }

  resize(w, h) {
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._rafId);
    if (this._mesh) {
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
    }
    this._renderer.dispose();
  }

  _animate() {
    if (this._disposed) return;
    this._rafId = requestAnimationFrame(() => this._animate());
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }
}
