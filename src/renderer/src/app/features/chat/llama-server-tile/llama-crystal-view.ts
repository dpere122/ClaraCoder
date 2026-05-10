import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import type {
  Bone,
  Clock,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import {
  crystalVisualTargets,
  expSmoothingAlpha,
  type LlamaCrystalAggregate,
} from './llama-connection-display';

type ThreeModule = typeof import('three');

/** Procedural stylized status circle model for the status viewport. */
function createStatusCircleModel(T: ThreeModule): {
  root: import('three').Group;
  pulseMaterials: MeshStandardMaterial[];
  growthMeshes: import('three').Mesh[];
  growthBones: import('three').Bone[];
} {
  const root = new T.Group();
  const skinMat = new T.MeshStandardMaterial({
    color: new T.Color(0.48, 0.67, 0.42),
    metalness: 0.03,
    roughness: 0.78,
  });
  const tunicMat = new T.MeshStandardMaterial({
    color: new T.Color(0.25, 0.12, 0.39),
    metalness: 0.16,
    roughness: 0.5,
  });
  const hairMat = new T.MeshStandardMaterial({
    color: new T.Color(0.49, 0.23, 0.71),
    metalness: 0.06,
    roughness: 0.45,
    emissive: new T.Color(0.13, 0.06, 0.24),
    emissiveIntensity: 0.18,
  });
  const bootMat = new T.MeshStandardMaterial({
    color: new T.Color(0.14, 0.09, 0.18),
    metalness: 0.2,
    roughness: 0.62,
  });
  const tuskMat = new T.MeshStandardMaterial({
    color: new T.Color(0.93, 0.87, 0.74),
    metalness: 0.03,
    roughness: 0.6,
  });
  const eyeGlowMat = new T.MeshStandardMaterial({
    color: new T.Color(0.95, 0.8, 1),
    metalness: 0,
    roughness: 0.2,
    emissive: new T.Color(0.88, 0.48, 1),
    emissiveIntensity: 0.64,
  });
  eyeGlowMat.userData['emissiveScale'] = 1.18;
  const chestMat = new T.MeshStandardMaterial({
    color: new T.Color(0.57, 0.24, 0.79),
    metalness: 0.1,
    roughness: 0.38,
    emissive: new T.Color(0.16, 0.08, 0.25),
    emissiveIntensity: 0.24,
  });
  chestMat.userData['emissiveScale'] = 1.14;

  const torso = new T.Mesh(new T.CapsuleGeometry(0.2, 0.5, 8, 14), tunicMat);
  torso.position.set(0, -0.03, 0);
  torso.scale.set(1.26, 1.08, 0.92);
  root.add(torso);

  const upperTorso = new T.Mesh(new T.SphereGeometry(0.26, 24, 16), tunicMat);
  upperTorso.position.set(0, 0.14, 0.01);
  upperTorso.scale.set(1.08, 0.85, 0.9);
  root.add(upperTorso);

  const waist = new T.Mesh(new T.CylinderGeometry(0.2, 0.18, 0.18, 16), tunicMat);
  waist.position.set(0, -0.36, 0);
  root.add(waist);

  const hips = new T.Mesh(new T.SphereGeometry(0.29, 24, 16), tunicMat);
  hips.position.set(0, -0.57, 0.01);
  hips.scale.set(1.08, 0.64, 0.98);
  root.add(hips);

  const hipSkirt = new T.Mesh(new T.TorusGeometry(0.23, 0.05, 10, 36), hairMat);
  hipSkirt.position.set(0, -0.49, 0);
  hipSkirt.rotation.x = Math.PI / 2;
  root.add(hipSkirt);

  const neck = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 0.1, 12), skinMat);
  neck.position.set(0, 0.36, 0.01);
  root.add(neck);

  const head = new T.Mesh(new T.SphereGeometry(0.25, 24, 16), skinMat);
  head.position.set(0, 0.62, 0.02);
  root.add(head);

  const hairCap = new T.Mesh(new T.SphereGeometry(0.265, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
  hairCap.position.copy(head.position);
  root.add(hairCap);

  const ponytail = new T.Mesh(new T.CylinderGeometry(0.07, 0.03, 0.26, 14), hairMat);
  ponytail.position.set(0, 0.46, -0.2);
  ponytail.rotation.x = -0.4;
  root.add(ponytail);
  const sideBraidL = new T.Mesh(new T.CylinderGeometry(0.03, 0.02, 0.24, 10), hairMat);
  sideBraidL.position.set(-0.17, 0.46, 0.11);
  sideBraidL.rotation.z = 0.22;
  const sideBraidR = sideBraidL.clone();
  sideBraidR.position.x = 0.17;
  sideBraidR.rotation.z = -0.22;
  root.add(sideBraidL, sideBraidR);

  const eyeL = new T.Mesh(new T.SphereGeometry(0.03, 10, 8), eyeGlowMat);
  eyeL.position.set(-0.075, 0.64, 0.24);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.075;
  root.add(eyeL, eyeR);

  const tuskL = new T.Mesh(new T.ConeGeometry(0.03, 0.11, 10), tuskMat);
  tuskL.position.set(-0.065, 0.5, 0.23);
  tuskL.rotation.z = 0.36;
  tuskL.rotation.x = Math.PI;
  const tuskR = tuskL.clone();
  tuskR.position.x = 0.065;
  tuskR.rotation.z = -0.36;
  root.add(tuskL, tuskR);

  const earL = new T.Mesh(new T.ConeGeometry(0.045, 0.2, 10), skinMat);
  earL.position.set(-0.24, 0.62, -0.01);
  earL.rotation.z = 0.95;
  const earR = earL.clone();
  earR.position.x = 0.24;
  earR.rotation.z = -0.95;
  root.add(earL, earR);

  const shoulderL = new T.Mesh(new T.SphereGeometry(0.11, 14, 10), tunicMat);
  shoulderL.position.set(-0.34, 0.14, 0.01);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = 0.34;
  root.add(shoulderL, shoulderR);

  const armGeom = new T.CylinderGeometry(0.055, 0.05, 0.4, 12);
  const armL = new T.Mesh(armGeom, skinMat);
  armL.position.set(-0.36, -0.15, 0.01);
  armL.rotation.z = 0.18;
  const armR = armL.clone();
  armR.position.x = 0.36;
  armR.rotation.z = -0.18;
  root.add(armL, armR);

  const bracerGeom = new T.CylinderGeometry(0.06, 0.06, 0.11, 12);
  const bracerL = new T.Mesh(bracerGeom, hairMat);
  bracerL.position.set(-0.4, -0.31, 0.02);
  bracerL.rotation.z = 0.18;
  const bracerR = bracerL.clone();
  bracerR.position.x = 0.4;
  bracerR.rotation.z = -0.18;
  root.add(bracerL, bracerR);

  const handGeom = new T.SphereGeometry(0.055, 12, 10);
  const handL = new T.Mesh(handGeom, skinMat);
  handL.position.set(-0.43, -0.38, 0.03);
  const handR = handL.clone();
  handR.position.x = 0.43;
  root.add(handL, handR);

  const legGeom = new T.CapsuleGeometry(0.075, 0.34, 8, 12);
  const legL = new T.Mesh(legGeom, skinMat);
  legL.position.set(-0.14, -0.86, 0.01);
  legL.scale.set(1.0, 1.1, 0.95);
  const legR = legL.clone();
  legR.position.x = 0.14;
  root.add(legL, legR);

  const bootGeom = new T.BoxGeometry(0.16, 0.16, 0.27);
  const bootL = new T.Mesh(bootGeom, bootMat);
  bootL.position.set(-0.14, -1.13, 0.06);
  bootL.scale.set(1.06, 0.95, 1.16);
  const bootR = bootL.clone();
  bootR.position.x = 0.14;
  root.add(bootL, bootR);

  const belt = new T.Mesh(new T.TorusGeometry(0.22, 0.03, 10, 32), chestMat);
  belt.position.set(0, -0.4, 0);
  belt.rotation.x = Math.PI / 2;
  root.add(belt);

  const chestL = new T.Mesh(new T.SphereGeometry(0.12, 16, 12), chestMat);
  chestL.position.set(-0.11, 0.04, 0.18);
  chestL.scale.set(1, 0.86, 0.84);
  const chestR = chestL.clone();
  chestR.position.x = 0.11;
  root.add(chestL, chestR);

  const rune = new T.Mesh(new T.SphereGeometry(0.05, 12, 10), eyeGlowMat);
  rune.position.set(0, -0.03, 0.2);
  rune.scale.set(1, 1.2, 0.55);
  root.add(rune);

  root.scale.setScalar(1.38);
  root.rotation.y = 0.2;

  const pulseMaterials: MeshStandardMaterial[] = [eyeGlowMat, hairMat, chestMat];
  const growthMeshes = [chestL, chestR];
  return { root, pulseMaterials, growthMeshes, growthBones: [] };
}

async function loadLegacyIndicator(T: ThreeModule): Promise<{
  root: import('three').Object3D;
  pulseMaterials: MeshStandardMaterial[];
  growthMeshes: import('three').Mesh[];
  growthBones: import('three').Bone[];
}> {
  const { IndicatorLoader } = await import('three/examples/jsm/loaders/IndicatorLoader.js');
  const loader = new IndicatorLoader();
  const modelUrl = new URL('', window.location.href).toString();
  const loaded = await loader.loadAsync(modelUrl);
  const root = loaded.scene || loaded.scenes?.[0];
  if (!root) {
    throw new Error('status indicator has no scene');
  }

  const pulseMaterials = new Set<MeshStandardMaterial>();
  const growthMeshes: import('three').Mesh[] = [];
  const growthBones: import('three').Bone[] = [];
  const chestMeshRx = /(breast|boob|bust|chest)/i;
  const chestBoneRx = /(breast|boob|bust|chest|spine_?0?2|spine_?0?3)/i;

  root.traverse((obj) => {
    if (obj instanceof T.Mesh) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m instanceof T.MeshStandardMaterial) {
          if (m.emissiveIntensity > 0 || m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0) {
            m.userData['emissiveScale'] = typeof m.userData['emissiveScale'] === 'number' ? m.userData['emissiveScale'] : 1.08;
            pulseMaterials.add(m);
          }
        }
      }
      if (obj.name && chestMeshRx.test(obj.name)) {
        growthMeshes.push(obj);
      }
    }
    if (obj instanceof T.Bone && obj.name && chestBoneRx.test(obj.name)) {
      growthBones.push(obj);
    }
  });

  root.rotation.y = 0.2;
  return {
    root,
    pulseMaterials: [...pulseMaterials],
    growthMeshes,
    growthBones,
  };
}

@Component({
  selector: 'app-llama-crystal-view',
  templateUrl: './llama-crystal-view.html',
  styleUrl: './llama-crystal-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LlamaCrystalView implements AfterViewInit, OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);

  readonly aggregate = input<LlamaCrystalAggregate>('off');
  readonly recentOutput = input(false);
  /** Active chat turn: assistant / tools still streaming for the open conversation. */
  readonly llmStreamActive = input(false);
  /** Increment to retrigger a brief host shake (harness feedback pulse). */
  readonly shakeNonce = input(0);
  /** Managed embedding server is configured and passed health ``ok``. */
  readonly embedLoaded = input(false);

  protected readonly loadError = signal(false);
  protected readonly shakeHost = signal(false);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private readonly hostRef = viewChild<ElementRef<HTMLDivElement>>('host');

  private three: ThreeModule | null = null;
  private renderer: WebGLRenderer | null = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private modelRoot: Object3D | null = null;
  private pulseMaterials: MeshStandardMaterial[] = [];
  private growthMeshes: Mesh[] = [];
  private growthBones: Bone[] = [];
  private readonly growthMeshBaseScale = new Map<Mesh, { x: number; y: number; z: number }>();
  private readonly growthBoneBaseScale = new Map<Bone, { x: number; y: number; z: number }>();
  private clock: Clock | null = null;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private shakeClearTimer: ReturnType<typeof setTimeout> | null = null;

  private spinSpeed = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private baseModelY = 0;
  private chestGrowthScale = 1;
  /** Smoothed emissive intensity (color stays pure white). */
  private curEi = 0.5;

  constructor() {
    effect((onCleanup) => {
      const n = this.shakeNonce();
      if (n <= 0) {
        return;
      }
      if (this.shakeClearTimer != null) {
        clearTimeout(this.shakeClearTimer);
        this.shakeClearTimer = null;
      }
      this.shakeHost.set(true);
      this.cdr.markForCheck();
      this.shakeClearTimer = window.setTimeout(() => {
        this.shakeHost.set(false);
        this.shakeClearTimer = null;
        this.cdr.markForCheck();
      }, 320);
      onCleanup(() => {
        if (this.shakeClearTimer != null) {
          clearTimeout(this.shakeClearTimer);
          this.shakeClearTimer = null;
        }
      });
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const host = this.hostRef()?.nativeElement;
    if (!canvas || !host) {
      return;
    }
    void this.initThree(canvas, host);
  }

  ngOnDestroy(): void {
    this.disposed = true;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeModel();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.clock = null;
    this.three = null;
  }

  private async initThree(canvas: HTMLCanvasElement, host: HTMLDivElement): Promise<void> {
    let T: ThreeModule;
    try {
      T = await import('three');
    } catch {
      if (!this.disposed) {
        this.loadError.set(true);
        this.cdr.markForCheck();
      }
      return;
    }

    if (this.disposed) {
      return;
    }

    this.three = T;
    this.clock = new T.Clock();

    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);

    this.scene = new T.Scene();
    this.scene.background = null;

    this.camera = new T.PerspectiveCamera(42, w / h, 0.01, 80);
    this.camera.position.set(0.35, 0.55, 1.85);

    this.renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.88;

    const hemi: HemisphereLight = new T.HemisphereLight(0xffffff, 0x223344, 0.48);
    this.scene.add(hemi);
    const dir: DirectionalLight = new T.DirectionalLight(0xffffff, 0.32);
    dir.position.set(2, 4, 3);
    this.scene.add(dir);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed || !this.renderer || !this.camera) {
        return;
      }
      const rw = Math.max(1, host.clientWidth);
      const rh = Math.max(1, host.clientHeight);
      this.camera.aspect = rw / rh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(rw, rh, false);
    });
    this.resizeObserver.observe(host);

    try {
      if (this.disposed) {
        return;
      }
      let loaded:
        | {
            root: Object3D;
            pulseMaterials: MeshStandardMaterial[];
            growthMeshes: Mesh[];
            growthBones: Bone[];
          }
        | null = null;
      try {
        loaded = await loadLegacyIndicator(T);
      } catch {
        loaded = null;
      }
      const { root, pulseMaterials, growthMeshes, growthBones } = loaded ?? createStatusCircleModel(T);
      this.modelRoot = root;
      this.scene.add(this.modelRoot);

      const box = new T.Box3().setFromObject(this.modelRoot);
      const center = box.getCenter(new T.Vector3());
      const size = box.getSize(new T.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      this.modelRoot.position.sub(center);
      this.baseModelY = this.modelRoot.position.y;
      const dist = maxDim * 2.35;
      this.camera.position.set(maxDim * 0.35, maxDim * 0.5, dist);
      this.camera.near = Math.max(0.001, dist / 200);
      this.camera.far = dist * 20;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(0, maxDim * 0.05, 0);

      this.pulseMaterials = pulseMaterials;
      this.growthMeshes = growthMeshes;
      this.growthBones = growthBones;
      this.chestGrowthScale = 1;
      this.growthMeshBaseScale.clear();
      for (const mesh of this.growthMeshes) {
        this.growthMeshBaseScale.set(mesh, {
          x: mesh.scale.x,
          y: mesh.scale.y,
          z: mesh.scale.z,
        });
      }
      this.growthBoneBaseScale.clear();
      for (const bone of this.growthBones) {
        this.growthBoneBaseScale.set(bone, {
          x: bone.scale.x,
          y: bone.scale.y,
          z: bone.scale.z,
        });
      }
      for (const mat of this.pulseMaterials) {
        mat.emissive = mat.emissive.clone();
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.02);
      }

      const t0 = crystalVisualTargets(this.aggregate());
      this.curEi = t0.emissiveIntensity;
    } catch {
      if (!this.disposed) {
        this.loadError.set(true);
        this.cdr.markForCheck();
      }
      this.disposeModel();
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer = null;
      }
      this.scene = null;
      this.camera = null;
      return;
    }

    if (!this.disposed) {
      this.loadError.set(false);
      this.cdr.markForCheck();
    }
    this.clock.start();
    this.rafId = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    const T = this.three;
    if (this.disposed || !T || !this.renderer || !this.scene || !this.camera || !this.clock) {
      return;
    }
    this.rafId = requestAnimationFrame(() => this.tick());

    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = performance.now();
    const agg = this.aggregate();
    const targets = crystalVisualTargets(agg);
    const pulse =
      agg === 'loading' || agg === 'modelDownload' || agg === 'feedbackPositive' || agg === 'feedbackNegative'
        ? Math.sin(t * 0.003) * targets.loadingPulseAmplitude
        : 0;
    const targetEi = targets.emissiveIntensity + pulse;

    const emAlpha = expSmoothingAlpha(dt, 0.38);
    this.curEi += (targetEi - this.curEi) * emAlpha;

    for (const mat of this.pulseMaterials) {
      const emScale =
        typeof mat.userData['emissiveScale'] === 'number' ? (mat.userData['emissiveScale'] as number) : 1;
      mat.emissiveIntensity = this.curEi * emScale;
    }

    const llm = this.llmStreamActive();
    const serveOut = this.recentOutput();
    const dl = agg === 'modelDownload';
    const modelLoaded = agg === 'ok' || agg === 'feedbackPositive' || agg === 'feedbackNegative';
    const loadedSpin = modelLoaded ? 0.52 : 0;
    const targetSpin = (dl ? 3.35 : 0) + loadedSpin + (serveOut ? 0.36 : 0) + (llm ? 0.62 : 0);
    this.spinSpeed += (targetSpin - this.spinSpeed) * expSmoothingAlpha(dt, 0.28);

    let targetBob = 0;
    if (dl) {
      targetBob = 0.06;
    } else if (llm) {
      targetBob = 0.1;
    } else if (serveOut) {
      targetBob = 0.032;
    }
    this.bobAmp += (targetBob - this.bobAmp) * expSmoothingAlpha(dt, 0.24);
    const bobSpeed = dl ? 3.2 : llm ? 4.4 : serveOut ? 2.7 : 0;
    this.bobPhase += dt * bobSpeed;

    if (this.modelRoot) {
      this.modelRoot.position.y = this.baseModelY + Math.sin(this.bobPhase) * this.bobAmp;
      if (this.embedLoaded()) {
        this.modelRoot.rotation.y = 0;
      } else {
        this.modelRoot.rotation.y += this.spinSpeed * dt;
      }
    }

    const targetChestScale = this.embedLoaded() ? 1.42 : 1;
    this.chestGrowthScale += (targetChestScale - this.chestGrowthScale) * expSmoothingAlpha(dt, 0.24);
    for (const mesh of this.growthMeshes) {
      const base = this.growthMeshBaseScale.get(mesh);
      if (!base) {
        continue;
      }
      mesh.scale.set(
        base.x * this.chestGrowthScale,
        base.y * this.chestGrowthScale,
        base.z * this.chestGrowthScale,
      );
    }
    for (const bone of this.growthBones) {
      const base = this.growthBoneBaseScale.get(bone);
      if (!base) {
        continue;
      }
      bone.scale.set(base.x * this.chestGrowthScale, base.y, base.z * this.chestGrowthScale);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private disposeModel(): void {
    const T = this.three;
    if (!this.modelRoot) {
      this.pulseMaterials = [];
      this.growthMeshes = [];
      this.growthBones = [];
      this.growthMeshBaseScale.clear();
      this.growthBoneBaseScale.clear();
      return;
    }
    this.scene?.remove(this.modelRoot);
    const seenMats = new Set<unknown>();
    this.modelRoot.traverse((obj: Object3D) => {
      if (T && obj instanceof T.Mesh) {
        obj.geometry?.dispose();
        const mats = obj.material;
        const list = Array.isArray(mats) ? mats : [mats];
        for (const m of list) {
          if (!seenMats.has(m)) {
            seenMats.add(m);
            m.dispose();
          }
        }
      }
    });
    this.modelRoot = null;
    this.pulseMaterials = [];
    this.growthMeshes = [];
    this.growthBones = [];
    this.growthMeshBaseScale.clear();
    this.growthBoneBaseScale.clear();
    this.chestGrowthScale = 1;
  }
}
