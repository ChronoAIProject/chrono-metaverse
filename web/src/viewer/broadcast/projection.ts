import * as T from 'three';

/** 截线在物体的局部坐标中采样，移动、转身和远近变化都不会让纹理滑动。 */
export function projectionMaterial(pitch: number, intensity: number, tint = '#77bad5') {
  return new T.ShaderMaterial({
    uniforms: {
      pitch: { value: pitch },
      intensity: { value: intensity },
      tint: { value: new T.Color(tint) },
    },
    side: T.DoubleSide,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 p, n, eye;
      void main(){
        p=position;
        vec4 view=modelViewMatrix*vec4(position,1.);
        n=normalMatrix*normal; eye=-view.xyz;
        gl_Position=projectionMatrix*view;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec3 p,n,eye;
      uniform float pitch,intensity; uniform vec3 tint;
      float line(float x) {
        float width=max(fwidth(x),.001);
        return (1.-smoothstep(.024,.045+width*.65,abs(fract(x+.5)-.5))) / (1.+width*2.);
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec3 normal=normalize(n);
        float rim=pow(1.-abs(dot(normal,normalize(eye))),1.9);
        float facing=.5+.5*dot(normal,normalize(vec3(-.46,.72,.57)));
        vec3 samplePos=p/pitch;
        float cuts=line(dot(samplePos,vec3(.16,1.,.21)));
        float etch=line(dot(samplePos,vec3(1.,.03,.24))*.28);
        vec3 ink=mix(vec3(.002,.016,.026),vec3(.018,.062,.082),facing);
        ink+=vec3(.19,.61,.60)*(cuts*.68+etch*.14)*intensity;
        ink+=vec3(.21,.49,.52)*rim*(.3+intensity)+vec3(.01,.08,.085)*intensity;
        ink=mix(ink,tint*(.10+.35*facing+.53*rim+.33*cuts),.55);
        gl_FragColor=vec4(ink,1.);
        #include <colorspace_fragment>
      }`,
  });
}
