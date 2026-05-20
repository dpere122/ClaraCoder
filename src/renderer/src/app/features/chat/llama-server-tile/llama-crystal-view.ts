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
import {
  applyFractalMultiplyAnimation,
  createHyperbolicOctahedronFractalAssembly,
  type HyperbolicOctahedronFractalAssembly,
  HYPERBOLIC_OCTAHEDRON_FRACTAL_NAME,
} from './hyperbolic-octahedron-fractal';

type ThreeModule = typeof import('three');

@Component({
  selector: 'app-llama-crystal-view',
  templateUrl: './llama-crystal-view.html',
  styleUrl: './llama-crystal-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LlamaCrystalView implements AfterViewInit, OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);

  /** Accessible label for the status fractal (Endless Design Lab style). */
  protected readonly fractalName = HYPERBOLIC_OCTAHEDRON_FRACTAL_NAME;

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
  /** Fraction of the viewport the fractal should fill (width/height). */
  private readonly viewFill = 0.96;
  private disposed = false;
  private shakeClearTimer: ReturnType<typeof setTimeout> | null = null;

  private spinSpeed = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private baseModelY = 0;
  private fractalAssembly: HyperbolicOctahedronFractalAssembly | null = null;
  /** 0 = single idle unit, 1 = full multiplied cluster. */
  private fractalMultiplyProgress = 0;
  private fractalMultiplyTarget = 0;
  /** Smoothed base / emissive colors and intensity from aggregate state. */
  private cur = { r: 0.78, g: 0.8, b: 0.82, er: 0.04, eg: 0.055, eb: 0.07, ei: 0.06 };

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

    effect(() => {
      this.fractalMultiplyTarget = this.isModelLoaded(this.aggregate()) ? 1 : 0;
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

    this.camera = new T.PerspectiveCamera(32, w / h, 0.01, 80);

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
    this.renderer.toneMappingExposure = 1.08;

    const hemi: HemisphereLight = new T.HemisphereLight(0xf2f0ec, 0x4a4e58, 0.52);
    this.scene.add(hemi);
    const key: DirectionalLight = new T.DirectionalLight(0xffffff, 0.58);
    key.position.set(0.6, 2.8, 1.6);
    this.scene.add(key);
    const fill: DirectionalLight = new T.DirectionalLight(0xe4e8f0, 0.48);
    fill.position.set(-1.4, -1.2, 1.8);
    this.scene.add(fill);
    const rim: DirectionalLight = new T.DirectionalLight(0xf8f8fa, 0.32);
    rim.position.set(0.2, 0.4, -2.2);
    this.scene.add(rim);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed || !this.renderer || !this.camera) {
        return;
      }
      const rw = Math.max(1, host.clientWidth);
      const rh = Math.max(1, host.clientHeight);
      this.camera.aspect = rw / rh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(rw, rh, false);
      this.frameModelInView();
    });
    this.resizeObserver.observe(host);

    try {
      if (this.disposed) {
        return;
      }
      this.mountFractalAssembly();

      const t0 = crystalVisualTargets(this.aggregate());
      this.cur = {
        r: t0.baseRgb[0],
        g: t0.baseRgb[1],
        b: t0.baseRgb[2],
        er: t0.emissiveRgb[0],
        eg: t0.emissiveRgb[1],
        eb: t0.emissiveRgb[2],
        ei: t0.emissiveIntensity,
      };
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

    const colorAlpha = expSmoothingAlpha(dt, 0.42);
    const emAlpha = expSmoothingAlpha(dt, 0.38);
    this.cur.r += (targets.baseRgb[0] - this.cur.r) * colorAlpha;
    this.cur.g += (targets.baseRgb[1] - this.cur.g) * colorAlpha;
    this.cur.b += (targets.baseRgb[2] - this.cur.b) * colorAlpha;
    this.cur.er += (targets.emissiveRgb[0] - this.cur.er) * emAlpha;
    this.cur.eg += (targets.emissiveRgb[1] - this.cur.eg) * emAlpha;
    this.cur.eb += (targets.emissiveRgb[2] - this.cur.eb) * emAlpha;
    this.cur.ei += (targetEi - this.cur.ei) * emAlpha;

    for (const mat of this.pulseMaterials) {
      const emScale =
        typeof mat.userData['emissiveScale'] === 'number' ? (mat.userData['emissiveScale'] as number) : 1;
      mat.color.setRGB(this.cur.r, this.cur.g, this.cur.b);
      mat.emissive.setRGB(this.cur.er, this.cur.eg, this.cur.eb);
      mat.emissiveIntensity = Math.max(this.cur.ei * emScale, 0.09);
    }

    const llm = this.llmStreamActive();
    const serveOut = this.recentOutput();
    const dl = agg === 'modelDownload';
    const modelLoaded = this.isModelLoaded(agg);
    const loadedSpin = modelLoaded ? 0.68 : 0;
    const embedSpin = this.embedLoaded() ? 0.42 : 0;
    const targetSpin = (dl ? 3.35 : 0) + loadedSpin + embedSpin + (serveOut ? 0.36 : 0) + (llm ? 0.62 : 0);
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
        this.modelRoot.rotation.y += this.spinSpeed * dt * 0.5;
        this.modelRoot.rotation.z *= 0.96;
      } else {
        this.modelRoot.rotation.y += this.spinSpeed * dt * 0.72;
        this.modelRoot.rotation.z += this.spinSpeed * dt;
      }
      const targetScale = this.embedLoaded() ? 1.14 : 1;
      this.modelScale += (targetScale - this.modelScale) * expSmoothingAlpha(dt, 0.24);
      this.modelRoot.scale.setScalar(this.baseModelScale * this.modelScale);
    }

    if (this.fractalAssembly) {
      const expanding = this.fractalMultiplyTarget > this.fractalMultiplyProgress;
      const progressAlpha = expSmoothingAlpha(dt, expanding ? 0.48 : 0.62);
      this.fractalMultiplyProgress +=
        (this.fractalMultiplyTarget - this.fractalMultiplyProgress) * progressAlpha;
      applyFractalMultiplyAnimation(
        this.fractalAssembly.idleUnit,
        this.fractalAssembly.units,
        this.fractalMultiplyProgress,
      );
      if (Math.abs(this.fractalMultiplyTarget - this.fractalMultiplyProgress) > 0.004) {
        this.frameModelInView();
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  private isModelLoaded(agg: LlamaCrystalAggregate): boolean {
    return agg === 'ok' || agg === 'feedbackPositive' || agg === 'feedbackNegative';
  }

  private mountFractalAssembly(): void {
    const T = this.three;
    if (!T || !this.scene || this.disposed) {
      return;
    }

    const prevRotationY = this.modelRoot?.rotation.y ?? 0;
    const prevRotationZ = this.modelRoot?.rotation.z ?? 0;
    this.disposeModel();

    const assembly = createHyperbolicOctahedronFractalAssembly(T);
    this.fractalAssembly = assembly;
    this.modelRoot = assembly.root;
    this.scene.add(this.modelRoot);

    const box = new T.Box3().setFromObject(this.modelRoot);
    const center = box.getCenter(new T.Vector3());
    this.modelRoot.position.sub(center);
    this.baseModelY = this.modelRoot.position.y;
    this.baseModelScale = 1;
    this.modelScale = 1;
    this.modelRoot.rotation.y = prevRotationY;
    this.modelRoot.rotation.z = prevRotationZ;

    this.fractalMultiplyTarget = this.isModelLoaded(this.aggregate()) ? 1 : 0;
    this.fractalMultiplyProgress = this.fractalMultiplyTarget;
    applyFractalMultiplyAnimation(
      assembly.idleUnit,
      assembly.units,
      this.fractalMultiplyProgress,
    );
    this.frameModelInView();

    this.pulseMaterials = assembly.pulseMaterials;
    for (const mat of this.pulseMaterials) {
      mat.emissive = mat.emissive.clone();
      mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.02);
    }
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
      if (T && (obj instanceof T.Mesh || obj instanceof T.InstancedMesh)) {
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
    this.fractalAssembly = null;
    this.pulseMaterials = [];
    this.baseModelScale = 1;
    this.modelScale = 1;
    this.fractalMultiplyProgress = 0;
    this.fractalMultiplyTarget = 0;
  }

  /** Frame camera so the fractal fills most of the status viewport. */
  private frameModelInView(): void {
    const T = this.three;
    if (!T || !this.camera || !this.modelRoot) {
      return;
    }
    const box = new T.Box3().setFromObject(this.modelRoot);
    const size = box.getSize(new T.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const distV = maxDim / (2 * Math.tan(fovRad / 2));
    const distH = maxDim / (2 * Math.tan(fovRad / 2) * this.camera.aspect);
    const dist = Math.max(distV, distH) / this.viewFill;
    this.camera.position.set(0, maxDim * 0.04, dist);
    this.camera.near = Math.max(0.001, dist / 200);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(0, 0, 0);
  }
}
