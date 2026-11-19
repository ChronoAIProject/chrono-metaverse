import * as T from 'three';
import clouds from '../../assets/earth/clouds.jpg';
import day from '../../assets/earth/day.jpg';
import night from '../../assets/earth/night.jpg';
import { EARTH_RADIUS, GeoReference } from '../geography';

/** 暮色和星空按镜头高度混合，手动拖动时也能连续越过大气层。 */
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
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);
      }
      void main() {
        vec3 d=normalize(ray);
        vec2 uv=vec2(atan(d.x,d.z)/6.28318,asin(d.y)/3.14159);
        float glow=exp(-5.2*abs(d.y-.014));
        vec3 dusk=mix(vec3(.012,.018,.062),vec3(.19,.095,.21),glow);
        vec3 sun=normalize(vec3(-.57,.09,-1.));
        float ds=distance(d,sun);
        dusk+=vec3(.67,.19,.10)*exp(-3.9*ds)*glow;
        dusk+=vec3(1.,.66,.36)*(1.-smoothstep(.052,.054,ds))*smoothstep(.025,.04,d.y);
        vec2 band=vec2(d.x*15.+d.z*9.,d.y*88.+2.*sin(d.x*4.));
        float cloud=noise(band)*.55+noise(band*2.13)*.3+noise(band*5.8)*.15;
        dusk+=vec3(.085,.045,.091)*smoothstep(.39,.75,cloud)*exp(-3.4*abs(d.y-.12));
        vec2 cells=uv*vec2(1350.,675.);
        float star=hash(floor(cells));
        float dotSize=max(fwidth(cells.x),fwidth(cells.y))*.34;
        float light=step(.978,star)*(1.-smoothstep(.05,.29+min(.45,dotSize),length(fract(cells)-.5)));
        float dust=exp(-9.*abs(d.y+.38*d.x-.18))*noise(uv*17.);
        vec3 space=vec3(.003,.005,.015)+dust*vec3(.045,.036,.075)+light*mix(vec3(.4,.72,.94),vec3(1.,.84,.64),hash(floor(cells)+3.));
        gl_FragColor=vec4(mix(dusk,space,orbit),1.);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new T.Mesh(new T.SphereGeometry(1, 24, 16), material);
  sky.frustumCulled = false;
  sky.renderOrder = -999;
  return sky;
}

/** 对齐地图的地心和经纬方向，太空摄影只在地表瓦片失去可见细节后接替地图。 */
export function orbitalEarth(ref: GeoReference) {
  const loader = new T.TextureLoader();
  const dayMap = loader.load(day),
    nightMap = loader.load(night),
    cloudMap = loader.load(clouds);
  const material = new T.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayMap },
      nightMap: { value: nightMap },
      cloudMap: { value: cloudMap },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 surface; varying vec3 n; varying vec3 eye;
      void main(){
        surface=uv; n=normalize(mat3(modelMatrix)*normal);
        vec4 p=modelMatrix*vec4(position,1.); eye=cameraPosition-p.xyz;
        gl_Position=projectionMatrix*viewMatrix*p;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 surface; varying vec3 n; varying vec3 eye; uniform sampler2D dayMap,nightMap,cloudMap;
      void main(){
        #include <logdepthbuf_fragment>
        vec3 normal=normalize(n);
        float sun=dot(normal,normalize(vec3(-.83,.65,.34)));
        float lit=smoothstep(-.12,.43,sun);
        vec3 land=texture2D(dayMap,surface).rgb;
        float cloud=texture2D(cloudMap,surface).r;
        land=mix(land,vec3(.95,.97,.99),cloud*.92);
        vec3 cities=texture2D(nightMap,surface).rgb;
        float rim=pow(1.-max(0.,dot(normal,normalize(eye))),3.3);
        vec3 color=land*mix(vec3(.035,.061,.11),vec3(.93,.96,1.),lit);
        color+=cities*vec3(1.25,.85,.48)*(1.-lit);
        color+=vec3(.16,.54,.91)*rim*(.43+.57*lit);
        gl_FragColor=vec4(color,1.);
      }`,
  });
  const earth = new T.Mesh(new T.SphereGeometry(1, 128, 80), material);
  // 球面纹理的本地轴依次是本初子午线、北极和西经 90°。
  earth.quaternion.setFromRotationMatrix(
    ref.rotation.clone().multiply(new T.Matrix4().makeRotationX(Math.PI / 2)),
  );
  earth.scale.set(EARTH_RADIUS, 6356752.3, EARTH_RADIUS);
  earth.position.copy(ref.center);
  return {
    earth,
    dispose: () => {
      dayMap.dispose();
      nightMap.dispose();
      cloudMap.dispose();
    },
  };
}
