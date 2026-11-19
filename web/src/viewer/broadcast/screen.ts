import * as T from 'three';

/** 浏览器视频由 WebGL 蒙版显露。保留一部分已绘制的景深，让楼体与球面透过投影。 */
export class RelayScreen {
  private readonly mesh: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
  private readonly original: T.MeshBasicMaterial;
  private readonly projected: T.MeshBasicMaterial;

  constructor(player: T.Group) {
    this.mesh = player.children.find((o) => o instanceof T.Mesh) as typeof this.mesh;
    this.original = this.mesh.material;
    const mat = this.original.clone();
    mat.transparent = true;
    mat.depthWrite = true;
    if (mat.map instanceof T.VideoTexture) {
      mat.opacity = 0.81;
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `
          float luminance = dot(outgoingLight, vec3(.2126,.7152,.0722));
          outgoingLight = vec3(.003,.016,.022)+luminance*vec3(.26,.64,.58);
          #include <opaque_fragment>`,
        );
      };
    } else {
      mat.blending = T.CustomBlending;
      mat.blendSrc = mat.blendSrcAlpha = T.ZeroFactor;
      mat.blendDst = mat.blendDstAlpha = T.OneMinusSrcAlphaFactor;
      mat.opacity = 0.83;
    }
    this.projected = mat;
  }
  get playing() {
    return this.mesh.visible;
  }
  show(exterior: boolean) {
    this.mesh.material = exterior ? this.projected : this.original;
  }
  dispose() {
    this.show(false);
    this.projected.dispose();
  }
}

/** 扫描纹和边缘辉光均使用屏面坐标，转动镜头时与节目保持相同的透视。 */
export function screenGlass() {
  const mesh = new T.Mesh(
    new T.PlaneGeometry(17.2, 10.2),
    new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 pane;
      void main(){
        pane=position.xy;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
        #include <logdepthbuf_vertex>
      }`,
      fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 pane;
      void main(){
        #include <logdepthbuf_fragment>
        vec2 edge=abs(pane)-vec2(8.,4.5);
        float sd=length(max(edge,0.))+min(max(edge.x,edge.y),0.);
        float pixel=max(max(fwidth(pane.x),fwidth(pane.y)),.008);
        float contour=1.-smoothstep(.018,.028+pixel*.65,abs(sd-.065));
        float corner=step(-1.05,min(edge.x,edge.y));
        float haze=exp(-abs(sd-.06)*9.);
        float row=pane.y*6.;
        float scan=(1.-smoothstep(.025,.06+fwidth(row)*.45,abs(fract(row+.5)-.5))) / (1.+2.*fwidth(row));
        float alpha=.16*haze+(.27+.47*corner)*contour+.10*scan*step(sd,0.);
        gl_FragColor=vec4(.28,.81,.73,alpha);
        #include <colorspace_fragment>
      }`,
    }),
  );
  mesh.position.z = 0.09;
  mesh.renderOrder = 11;
  return mesh;
}
