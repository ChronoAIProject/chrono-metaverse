import * as T from 'three';

export const dusk = `
  vec3 duskColor(vec3 d) {
    float horizon=exp(-5.*abs(d.y+.035));
    float warm=pow(.5+.5*dot(d,normalize(vec3(-.82,.06,.57))),3.);
    return vec3(.002,.006,.014)+horizon*(vec3(.008,.020,.031)+warm*vec3(.024,.016,.010));
  }`;

/** 源影像给出真实的路网、水岸和码头，地表的剖面刻度按世界米制坐标采样。 */
export function projectTerrain(material: T.MeshBasicMaterial) {
  material.customProgramCacheKey = () => 'broadcast-terrain';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'varying vec3 site;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n site=(modelMatrix*vec4(transformed,1.)).xyz;',
      );
    shader.fragmentShader =
      'varying vec3 site;\n' +
      dusk +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `
      vec3 ray = site-cameraPosition;
      vec3 region=diffuseColor.rgb;
      #ifdef USE_MAP
        region=texture2D(map,vMapUv).rgb;
      #endif
      float value=dot(region,vec3(.23,.64,.13));
      float water=smoothstep(-.005,.038,region.b-region.r);
      float street=smoothstep(.035,.39,value);
      vec3 land=vec3(.005,.014,.022)+vec3(.066,.114,.12)*street;
      vec2 grid=site.xz/32.;
      vec2 width=max(fwidth(grid),vec2(.001));
      vec2 tick=(1.-smoothstep(vec2(.004),.008+width*.6,abs(fract(grid+.5)-.5)))/(1.+width*2.);
      vec3 sea=vec3(.002,.010,.019)+vec3(.026,.11,.115)*tick.x*tick.y;
      vec3 color=mix(land,sea,water);
      float mist=1.-exp(-length(ray)*.00038);
      outgoingLight=mix(color,duskColor(normalize(ray)),mist);
      #include <opaque_fragment>`,
      );
  };
}
