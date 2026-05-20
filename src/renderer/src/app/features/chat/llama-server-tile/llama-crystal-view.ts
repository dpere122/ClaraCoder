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
  Group,
  HemisphereLight,
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

/** White status disc with a subtle center cross for the Model Status viewport. */
function createStatusCircleModel(T: ThreeModule): {
  root: Group;
  pulseMaterials: MeshStandardMaterial[];
} {
  const root = new T.Group();

  const circleMat = new T.MeshStandardMaterial({
    color: new T.Color(1, 1, 1),
    metalness: 0.04,
    roughness: 0.42,
    emissive: new T.Color(0.94, 0.96, 0.98),
    emissiveIntensity: 0.1,
  });
  circleMat.userData['emissiveScale'] = 1;

  const crossMat = new T.MeshStandardMaterial({
    color: new T.Color(0.82, 0.84, 0.88),
    metalness: 0,
    roughness: 0.55,
    emissive: new T.Color(0.72, 0.74, 0.78),
    emissiveIntensity: 0.03,
  });
  crossMat.userData['emissiveScale'] = 0.55;

  const disc = new T.Mesh(new T.CircleGeometry(0.52, 64), circleMat);
  root.add(disc);

  const crossDepth = 0.012;
  const crossThickness = 0.038;
  const crossArm = 0.2;
  const barV = new T.Mesh(new T.BoxGeometry(crossThickness, crossArm, crossDepth), crossMat);
  const barH = new T.Mesh(new T.BoxGeometry(crossArm, crossThickness, crossDepth), crossMat);
  barV.position.z = crossDepth * 0.55;
  barH.position.z = crossDepth * 0.55;
  root.add(barV, barH);

  return { root, pulseMaterials: [circleMat, crossMat] };
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
  private baseModelScale = 1;
  private modelScale = 1;
  private clock: Clock | null = null;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private shakeClearTimer: ReturnType<typeof setTimeout> | null = null;

  private spinSpeed = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private baseModelY = 0;
  /** Smoothed emissive intensity for status-driven glow. */
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
      const { root, pulseMaterials } = createStatusCircleModel(T);
      this.modelRoot = root;
      this.scene.add(this.modelRoot);

      const box = new T.Box3().setFromObject(this.modelRoot);
      const center = box.getCenter(new T.Vector3());
      const size = box.getSize(new T.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      this.modelRoot.position.sub(center);
      this.baseModelY = this.modelRoot.position.y;
      this.baseModelScale = 1;
      this.modelScale = 1;
      const dist = maxDim * 2.6;
      this.camera.position.set(0, 0, dist);
      this.camera.near = Math.max(0.001, dist / 200);
      this.camera.far = dist * 20;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(0, 0, 0);

      this.pulseMaterials = pulseMaterials;
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
        this.modelRoot.rotation.z = 0;
      } else {
        this.modelRoot.rotation.z += this.spinSpeed * dt;
      }
      const targetScale = this.embedLoaded() ? 1.1 : 1;
      this.modelScale += (targetScale - this.modelScale) * expSmoothingAlpha(dt, 0.24);
      this.modelRoot.scale.setScalar(this.baseModelScale * this.modelScale);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private disposeModel(): void {
    const T = this.three;
    if (!this.modelRoot) {
      this.pulseMaterials = [];
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
    this.baseModelScale = 1;
    this.modelScale = 1;
  }
}
