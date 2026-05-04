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
  Clock,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  crystalVisualTargets,
  expSmoothingAlpha,
  type LlamaCrystalAggregate,
} from './llama-connection-display';

type ThreeModule = typeof import('three');

/** Procedural lowercase “t”: long stem, crossbar in the upper third, short ascender above the bar (not a cap “T”). */
function createGlowingCross(T: ThreeModule): {
  root: import('three').Group;
  tintMaterials: MeshStandardMaterial[];
} {
  const root = new T.Group();

  const stemGeom = new T.BoxGeometry(0.26, 1.34, 0.26);
  const beamGeom = new T.BoxGeometry(0.68, 0.22, 0.26);
  const stem = new T.Mesh(stemGeom);
  stem.position.set(0, -0.19, 0);
  const beam = new T.Mesh(beamGeom);
  beam.position.set(0, 0.22, 0);

  const coreMat = new T.MeshStandardMaterial({
    color: new T.Color(1, 1, 1),
    metalness: 0.06,
    roughness: 0.28,
    emissive: new T.Color(1, 1, 1),
    emissiveIntensity: 0.55,
  });
  stem.material = coreMat;
  beam.material = coreMat;

  const glowMat = new T.MeshStandardMaterial({
    color: new T.Color(1, 1, 1),
    metalness: 0,
    roughness: 1,
    emissive: new T.Color(1, 1, 1),
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: T.DoubleSide,
  });
  glowMat.userData['emissiveScale'] = 1.12;

  const glowStem = new T.Mesh(stemGeom.clone());
  glowStem.position.copy(stem.position);
  glowStem.scale.setScalar(1.14);
  glowStem.material = glowMat;

  const glowBeam = new T.Mesh(beamGeom.clone());
  glowBeam.position.copy(beam.position);
  glowBeam.scale.setScalar(1.14);
  glowBeam.material = glowMat;

  root.add(glowStem, glowBeam, stem, beam);
  root.scale.setScalar(2);

  const tintMaterials: MeshStandardMaterial[] = [coreMat, glowMat];
  return { root, tintMaterials };
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
  /** Single thin gold ring behind the cross; billboards + spins, not parented to ``modelRoot``. */
  private embedHaloMesh: Mesh | null = null;
  private embedHaloMat: MeshBasicMaterial | null = null;
  private haloMaxDim = 1;
  private haloOpacity = 0;
  private haloScratchDir: Vector3 | null = null;
  private haloSpinQuat: Quaternion | null = null;
  private haloSpinAngle = 0;
  private tintMaterials: MeshStandardMaterial[] = [];
  private clock: Clock | null = null;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private shakeClearTimer: ReturnType<typeof setTimeout> | null = null;

  private spinSpeed = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private baseModelY = 0;
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
    this.disposeEmbedHalo();
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
      const { root, tintMaterials } = createGlowingCross(T);
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

      this.haloMaxDim = maxDim;
      this.haloScratchDir = new T.Vector3();
      this.haloSpinQuat = new T.Quaternion();

      const rMid = maxDim * 0.515;
      const halfStripe = maxDim * 0.012;
      const ringInner = rMid - halfStripe;
      const ringOuter = rMid + halfStripe;
      const haloGeom = new T.RingGeometry(ringInner, ringOuter, 96);
      const gold = new T.Color(1, 0.9, 0.45);
      const haloMat = new T.MeshBasicMaterial({
        color: gold,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: T.AdditiveBlending,
        side: T.DoubleSide,
        toneMapped: false,
      });
      const haloMesh = new T.Mesh(haloGeom, haloMat);
      haloMesh.renderOrder = -1;
      this.scene.add(haloMesh);
      this.embedHaloMesh = haloMesh;
      this.embedHaloMat = haloMat;

      this.tintMaterials = tintMaterials;
      for (const mat of this.tintMaterials) {
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
      this.disposeEmbedHalo();
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

    for (const mat of this.tintMaterials) {
      const emScale =
        typeof mat.userData['emissiveScale'] === 'number' ? (mat.userData['emissiveScale'] as number) : 1;
      mat.color.setRGB(1, 1, 1);
      mat.emissive.setRGB(1, 1, 1);
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

    const halo = this.embedHaloMesh;
    const haloMat = this.embedHaloMat;
    const scratch = this.haloScratchDir;
    const spinQ = this.haloSpinQuat;
    if (halo && haloMat && scratch && spinQ && this.modelRoot && this.camera) {
      const embedOn = this.embedLoaded();
      const targetHaloOp = embedOn ? 0.92 : 0;
      this.haloOpacity += (targetHaloOp - this.haloOpacity) * expSmoothingAlpha(dt, 0.32);
      haloMat.opacity = this.haloOpacity;
      halo.visible = this.haloOpacity > 0.004;
      if (halo.visible) {
        this.camera.getWorldDirection(scratch);
        const depth = this.haloMaxDim * 0.26;
        halo.position.copy(this.modelRoot.position).addScaledVector(scratch, depth);
        if (embedOn) {
          this.haloSpinAngle += this.spinSpeed * dt;
          spinQ.setFromAxisAngle(scratch, this.haloSpinAngle);
          halo.quaternion.copy(this.camera.quaternion).premultiply(spinQ);
        } else {
          halo.quaternion.copy(this.camera.quaternion);
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  private disposeModel(): void {
    const T = this.three;
    if (!this.modelRoot) {
      this.tintMaterials = [];
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
    this.tintMaterials = [];
  }

  private disposeEmbedHalo(): void {
    const mesh = this.embedHaloMesh;
    const mat = this.embedHaloMat;
    if (mesh && this.scene) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    if (mat) {
      mat.dispose();
    }
    this.embedHaloMesh = null;
    this.embedHaloMat = null;
    this.haloScratchDir = null;
    this.haloSpinQuat = null;
  }
}
