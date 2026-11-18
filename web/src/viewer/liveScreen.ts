import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import type Hls from 'hls.js';
import type { EntityBody } from '../core/api/types';
import { FLAT_TOLERANCE, plateFrame } from '../core/shapes/solid';
import { transformMatrix } from '../core/shapes/transform';

type Source = { readonly kind: 'youtube' | 'hls'; readonly url: string };

interface Screen {
  readonly source: Source;
  readonly matrix: THREE.Matrix4;
  readonly width: number;
  readonly height: number;
}

function sourceOf(kind: unknown, value: unknown, origin: string): Source | null {
  if ((kind !== 'youtube' && kind !== 'hls') || typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (kind === 'hls') {
    const sameOriginPath = value.startsWith('/') && url.origin === origin;
    return value.startsWith('https://') || sameOriginPath ? { kind, url: url.href } : null;
  }
  if (url.protocol !== 'https:') return null;
  const [, path, id, extra] = url.pathname.split('/');
  let video: string | null | undefined;
  switch (url.hostname) {
    case 'youtu.be':
      if (id === undefined || id === '') video = path;
      break;
    case 'youtube.com':
    case 'www.youtube.com':
    case 'm.youtube.com':
      if (path === 'watch' && (id === undefined || id === '')) video = url.searchParams.get('v');
      if ((path === 'live' || path === 'embed') && (extra === undefined || extra === ''))
        video = id;
      break;
    case 'www.youtube-nocookie.com':
      if (path === 'embed' && (extra === undefined || extra === '')) video = id;
      break;
  }
  if (video == null || !/^[a-zA-Z0-9_-]{11}$/.test(video)) return null;
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${video}`);
  embed.search = 'autoplay=1&mute=1&playsinline=1';
  return { kind, url: embed.href };
}

/** 按组内下标找到屏幕面板，沿用面板的四个角和整条变换链。 */
function liveScreenOf(entity: EntityBody, origin: string): Screen | null {
  const config = entity.props?.liveScreen;
  if (config === null || typeof config !== 'object') return null;
  const { kind, url, plate } = config as Record<string, unknown>;
  const source = sourceOf(kind, url, origin);
  if (source === null || !Array.isArray(plate)) return null;

  let shape = entity.shape;
  const matrix = new THREE.Matrix4();
  for (const index of plate) {
    if (shape?.type !== 'group' || !Number.isSafeInteger(index) || index < 0) return null;
    matrix.multiply(transformMatrix(shape.transform));
    shape = shape.children[index];
  }
  if (shape?.type !== 'plate' || shape.points.length !== 4) return null;
  const frame = plateFrame(shape.points);
  if (frame === null) return null;
  const [bottomLeft, bottomRight, topRight, topLeft] = shape.points.map(
    (point) => new THREE.Vector3(...point),
  );
  const right = bottomRight!.sub(bottomLeft!);
  const up = topLeft!.sub(bottomLeft!);
  const width = right.length();
  const height = up.length();
  // 四角按左下、右下、右上、左上排列。允许测量所得坐标有毫米级误差。
  const opposite = bottomLeft!.clone().add(right).add(up);
  if (
    topRight!.distanceTo(opposite) > FLAT_TOLERANCE ||
    Math.abs(right.dot(up)) > FLAT_TOLERANCE * Math.min(width, height)
  ) {
    return null;
  }
  const normal = new THREE.Vector3(...frame.normal);
  const face = new THREE.Matrix4().makeBasis(right.normalize(), up.normalize(), normal);
  // 略微抬离原面板，避免同一深度的两个表面相互争抢。
  face.setPosition(new THREE.Vector3(...frame.center).addScaledVector(normal, FLAT_TOLERANCE));
  matrix.multiply(transformMatrix(shape.transform)).multiply(face);
  return { source, matrix, width, height };
}

/** 直播保留原面板作占位。YouTube 播放器由 WebGL 平面遮罩显示，因而受深度和剖切约束。 */
export class LiveScreens {
  private dom: CSS3DRenderer | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly host: HTMLElement,
    private readonly clipping: THREE.Plane[],
  ) {}

  get hasEmbed(): boolean {
    return this.dom !== null;
  }

  add(group: THREE.Group, entity: EntityBody): void {
    const screen = liveScreenOf(entity, window.location.origin);
    if (screen === null) return;
    const { source, matrix, width, height } = screen;
    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({
      clippingPlanes: this.clipping,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.visible = false;
    group.add(mesh);
    const stop =
      source.kind === 'youtube'
        ? this.youtube(group, mesh, screen, entity.label ?? entity.entityId)
        : this.hls(mesh, source.url);
    this.cleanups.push(() => {
      stop();
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    });
  }

  private youtube(
    group: THREE.Group,
    mask: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    { source, matrix, width, height }: Screen,
    label: string,
  ): () => void {
    if (this.dom === null) {
      const dom = new CSS3DRenderer();
      dom.domElement.className = 'viewer__live-screens';
      this.host.prepend(dom.domElement);
      dom.setSize(this.host.clientWidth, this.host.clientHeight);
      this.dom = dom;
    }
    const iframe = document.createElement('iframe');
    const pixelWidth = THREE.MathUtils.clamp(Math.round(720 * (width / height)), 200, 3840);
    iframe.title = `${label}的 YouTube 直播`;
    iframe.tabIndex = -1;
    iframe.allow = 'autoplay; encrypted-media';
    iframe.referrerPolicy = 'origin';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.style.width = `${pixelWidth}px`;
    iframe.style.height = '720px';
    const player = new CSS3DObject(iframe);
    iframe.style.pointerEvents = 'none';
    player.matrixAutoUpdate = false;
    player.matrix.copy(matrix).scale(new THREE.Vector3(width / pixelWidth, height / 720, 1));
    group.add(player);

    // 清除这一面已经画过的颜色，同时留下深度，防止后面的透明物体盖住播放器。
    mask.material.blending = THREE.NoBlending;
    mask.material.premultipliedAlpha = true;
    mask.material.opacity = 0;
    mask.renderOrder = 10;
    iframe.addEventListener('load', () => (mask.visible = true), { once: true });
    iframe.src = source.url;
    return () => player.removeFromParent();
  }

  private hls(
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    url: string,
  ): () => void {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    mesh.material.map = texture;
    let hls: Hls | null = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      mesh.visible = false;
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      texture.dispose();
    };
    video.addEventListener('playing', () => {
      if (!stopped) mesh.visible = true;
    });
    video.addEventListener('canplay', () => {
      if (!stopped && video.paused) void video.play().catch(stop);
    });
    video.addEventListener('error', stop);
    video.addEventListener('ended', stop);
    const nativePlayback = () => {
      if (stopped) return;
      if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
      else stop();
    };
    import('hls.js')
      .then(({ default: Player }) => {
        if (stopped) return;
        if (!Player.isSupported()) {
          nativePlayback();
          return;
        }
        hls = new Player();
        hls.on(Player.Events.ERROR, (_, data) => {
          if (data.fatal) stop();
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      }, nativePlayback)
      .catch(stop);
    return stop;
  }

  resize(width: number, height: number): void {
    this.dom?.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.dom?.render(scene, camera);
  }

  clear(): void {
    for (const dispose of this.cleanups) dispose();
    this.cleanups.length = 0;
    this.dom?.domElement.remove();
    this.dom = null;
  }
}
