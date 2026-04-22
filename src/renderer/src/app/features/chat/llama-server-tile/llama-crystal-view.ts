import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import type { Clock, DirectionalLight, HemisphereLight, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import {
  crystalVisualTargets,
  expSmoothingAlpha,
  type LlamaCrystalAggregate,
} from './llama-connection-display';

const GLTF_URL = 'assets/crystal-model/scene.gltf';

type ThreeModule = typeof import('three');

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

  protected readonly loadError = signal(false);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private readonly hostRef = viewChild<ElementRef<HTMLDivElement>>('host');

  private three: ThreeModule | null = null;
  private renderer: WebGLRenderer | null = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private modelRoot: Object3D | null = null;
  private tintMaterials: MeshStandardMaterial[] = [];
  private clock: Clock | null = null;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  private spinSpeed = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private baseModelY = 0;
  private cur = { r: 0.78, g: 0.8, b: 0.82, er: 0.04, eg: 0.055, eb: 0.07, ei: 0.06 };

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
    let GLTFLoader: (typeof import('three/examples/jsm/loaders/GLTFLoader.js'))['GLTFLoader'];
    try {
      T = await import('three');
      ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
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
      const gltf = await new GLTFLoader().loadAsync(GLTF_URL);
      if (this.disposed) {
        gltf.scene.traverse((o: Object3D) => {
          if (o instanceof T.Mesh) {
            o.geometry?.dispose();
            const mats = o.material;
            const list = Array.isArray(mats) ? mats : [mats];
            for (const m of list) {
              m.dispose();
            }
          }
        });
        return;
      }
      this.modelRoot = gltf.scene;
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

      this.tintMaterials = [];
      this.modelRoot.traverse((obj: Object3D) => {
        if (obj instanceof T.Mesh && obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) {
            if (mat instanceof T.MeshStandardMaterial) {
              mat.emissive = mat.emissive.clone();
              mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.02);
              this.tintMaterials.push(mat);
            }
          }
        }
      });

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
    const pulse = agg === 'loading' ? Math.sin(t * 0.003) * targets.loadingPulseAmplitude : 0;
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

    for (const mat of this.tintMaterials) {
      mat.color.setRGB(this.cur.r, this.cur.g, this.cur.b);
      mat.emissive.setRGB(this.cur.er, this.cur.eg, this.cur.eb);
      mat.emissiveIntensity = this.cur.ei;
    }

    const llm = this.llmStreamActive();
    const serveOut = this.recentOutput();
    const targetSpin = (serveOut ? 0.36 : 0) + (llm ? 0.62 : 0);
    this.spinSpeed += (targetSpin - this.spinSpeed) * expSmoothingAlpha(dt, 0.28);

    let targetBob = 0;
    if (llm) {
      targetBob = 0.1;
    } else if (serveOut) {
      targetBob = 0.032;
    }
    this.bobAmp += (targetBob - this.bobAmp) * expSmoothingAlpha(dt, 0.24);
    const bobSpeed = llm ? 4.4 : serveOut ? 2.7 : 0;
    this.bobPhase += dt * bobSpeed;

    if (this.modelRoot) {
      this.modelRoot.rotation.y += this.spinSpeed * dt;
      this.modelRoot.position.y = this.baseModelY + Math.sin(this.bobPhase) * this.bobAmp;
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
    this.modelRoot.traverse((obj: Object3D) => {
      if (T && obj instanceof T.Mesh) {
        obj.geometry?.dispose();
        const mats = obj.material;
        const list = Array.isArray(mats) ? mats : [mats];
        for (const m of list) {
          m.dispose();
        }
      }
    });
    this.modelRoot = null;
    this.tintMaterials = [];
  }
}
