import * as T from 'three';
import { dusk } from './terrain';
import fieldUrl from '../../assets/earth/field.webp';
import { EARTH_RADIUS, GeoReference } from '../geography';

export function broadcastSky() {
  const material = new T.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    side: T.BackSide,
    uniforms: { orbit: { value: 0 } },
    vertexShader: `
      varying vec3 ray;
      void main() {
        ray=position;
        vec4 clip=projectionMatrix*vec4(mat3(viewMatrix)*position,1.);
        gl_Position=clip.xyww;
      }`,
    fragmentShader: `
      varying vec3 ray;
      uniform float orbit;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      ${dusk}
      void main() {
        vec3 d=normalize(ray);
        vec3 dusk=duskColor(d);
        vec2 uv=vec2(atan(d.x,d.z)/6.28318,asin(d.y)/3.14159);
        vec2 cells=uv*vec2(950.,475.);
        float star=hash(floor(cells));
        float light=step(.984,star)*(1.-smoothstep(.025,.28,length(fract(cells)-.5)));
        vec3 space=vec3(.0012,.0032,.007)+vec3(.005,.013,.019)*exp(-5.*abs(d.y+.24*d.x))+
          vec3(.42,.55,.62)*light*hash(floor(cells)+3.);
        gl_FragColor=vec4(mix(dusk,space,orbit),1.);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new T.Mesh(new T.SphereGeometry(1, 24, 16), material);
  sky.frustumCulled = false;
  sky.renderOrder = -999;
  return sky;
}

/** 海岸等距线、亮点与经纬网在地理坐标上采样，转动镜头时保持在球面上。 */
export function orbitalEarth(ref: GeoReference) {
  const field = new T.TextureLoader().load(fieldUrl);
  field.wrapS = T.RepeatWrapping;
  field.anisotropy = 4;
  const material = new T.ShaderMaterial({
    uniforms: { field: { value: field } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 chart; varying vec3 n, eye;
      void main(){
        chart=uv; n=normalMatrix*normal;
        vec4 p=modelViewMatrix*vec4(position,1.); eye=-p.xyz;
        gl_Position=projectionMatrix*p;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 chart; varying vec3 n,eye; uniform sampler2D field;
      float stroke(float x,float thickness) {
        float w=max(fwidth(x),.001);
        return (1.-smoothstep(thickness,thickness+w*.75,abs(fract(x+.5)-.5)))/(1.+w*1.8);
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec3 data=texture2D(field,chart).rgb;
        float coast=(data.r*255.-128.)/2.5;
        float land=smoothstep(-.65,.65,coast);
        vec3 normal=normalize(n);
        float rim=1.-clamp(dot(normal,normalize(eye)),0.,1.);
        float daylight=smoothstep(-.66,.90,dot(normal,normalize(vec3(-.65,.58,.51))));
        vec3 sea=vec3(.002,.012,.022), landBase=vec3(.007,.038,.048);
        vec3 color=mix(sea,landBase*(.7+data.g),land);
        float shore=1.-smoothstep(.20,1.15+fwidth(coast)*.65,abs(coast));
        float bathymetry=stroke(abs(coast)*.18,.018)*exp(-abs(coast)*.098);
        vec2 cell=chart*vec2(700.,350.);
        float marks=stroke(cell.y,.045)*stroke(cell.x,.07);
        float parallels=stroke(chart.y*18.,.0028),meridians=stroke(chart.x*36.,.0025);
        color+=vec3(.18,.65,.56)*(shore*.76+bathymetry*.26);
        color+=land*(.28+data.g*1.4)*(vec3(.18,.56,.50)*marks+vec3(.014,.046,.049)*stroke(cell.y,.015));
        color+=vec3(.024,.081,.087)*max(parallels,meridians);
        color+=vec3(.72,.44,.21)*pow(data.b,1.25)*land*(.22+.9*marks);
        color*=.42+.77*daylight;
        color+=vec3(.023,.14,.17)*pow(rim,2.4)+vec3(.18,.62,.62)*pow(rim,12.);
        gl_FragColor=vec4(color,1.);
        #include <colorspace_fragment>
      }`,
  });
  const earth = new T.Mesh(new T.SphereGeometry(1, 160, 112), material);
  earth.quaternion.setFromRotationMatrix(
    ref.rotation.clone().multiply(new T.Matrix4().makeRotationX(Math.PI / 2)),
  );
  earth.scale.set(EARTH_RADIUS, 6356752.3, EARTH_RADIUS);
  earth.position.copy(ref.center);
  return { earth, dispose: () => field.dispose() };
}
