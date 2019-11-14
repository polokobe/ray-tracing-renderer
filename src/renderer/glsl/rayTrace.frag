import textureLinear from './chunks/textureLinear.glsl';
import intersect from './chunks/intersect.glsl';
import random from './chunks/random.glsl';
import envmap from './chunks/envmap.glsl';
import bsdf from './chunks/bsdf.glsl';
import sample from './chunks/sample.glsl';
import sampleMaterial from './chunks/sampleMaterial.glsl';
import sampleShadowCatcher from './chunks/sampleShadowCatcher.glsl';
import sampleGlass from './chunks/sampleGlassSpecular.glsl';
// import sampleGlass from './chunks/sampleGlassMicrofacet.glsl';
import { unrollLoop, addDefines } from '../glslUtil';

export default function({ rayTracingRenderTargets, defines }) {
  return `#version 300 es

precision mediump float;
precision mediump int;

${addDefines(defines)}

${rayTracingRenderTargets.set()}

#define PI 3.14159265359
#define TWOPI 6.28318530718
#define INVPI 0.31830988618
#define INVPI2 0.10132118364
#define EPS 0.0005
#define INF 1.0e999
#define RAY_MAX_DISTANCE 9999.0

#define STANDARD 0
#define THIN_GLASS 1
#define THICK_GLASS 2
#define SHADOW_CATCHER 3

#define SAMPLES_PER_MATERIAL 8

const float IOR = 1.5;
const float INV_IOR = 1.0 / IOR;

const float IOR_THIN = 1.015;
const float INV_IOR_THIN = 1.0 / IOR_THIN;

const float R0 = (1.0 - IOR) * (1.0 - IOR)  / ((1.0 + IOR) * (1.0 + IOR));

// https://www.w3.org/WAI/GL/wiki/Relative_luminance
const vec3 luminance = vec3(0.2126, 0.7152, 0.0722);

struct Ray {
  vec3 o;
  vec3 d;
  vec3 invD;
  float tMax;
};

struct SurfaceInteraction {
  bool hit;
  vec3 position;
  vec3 normal; // smoothed normal from the three triangle vertices
  vec3 surfaceNormal; // smoothed normal without normal map
  vec3 faceNormal; // normal of the triangle
  vec3 color;
  float roughness;
  float metalness;
  int materialType;
};

struct Camera {
  mat4 transform;
  float aspect;
  float fov;
  float focus;
  float aperture;
};

uniform Camera camera;
uniform vec2 pixelSize; // 1 / screenResolution

in vec2 vCoord;

void initRay(inout Ray ray, vec3 origin, vec3 direction) {
  ray.o = origin;
  ray.d = direction;
  ray.invD = 1.0 / ray.d;
  ray.tMax = RAY_MAX_DISTANCE;
}

// given the index from a 1D array, retrieve corresponding position from packed 2D texture
ivec2 unpackTexel(int i, int columnsLog2) {
  ivec2 u;
  u.y = i >> columnsLog2; // equivalent to (i / 2^columnsLog2)
  u.x = i - (u.y << columnsLog2); // equivalent to (i % 2^columnsLog2)
  return u;
}

vec4 fetchData(sampler2D s, int i, int columnsLog2) {
  return texelFetch(s, unpackTexel(i, columnsLog2), 0);
}

ivec4 fetchData(isampler2D s, int i, int columnsLog2) {
  return texelFetch(s, unpackTexel(i, columnsLog2), 0);
}

struct Path {
  Ray ray;
  vec3 li;
  vec3 albedo;
  float alpha;
  vec3 beta;
  bool specularBounce;
  bool abort;
};

${textureLinear(defines)}
${intersect(defines)}
${random(defines)}
${envmap(defines)}
${bsdf(defines)}
${sample(defines)}
${sampleMaterial(defines)}
${sampleGlass(defines)}
${sampleShadowCatcher(defines)}

void bounce(inout Path path, int i, inout SurfaceInteraction si) {
  if (path.abort) {
    return;
  }

  si = intersectScene(path.ray);

  if (!si.hit) {
    if (path.specularBounce) {
      path.li += path.beta * sampleEnvmapFromDirection(path.ray.d);
    }

    path.abort = true;
  } else {
    #ifdef USE_GLASS
      if (si.materialType == THIN_GLASS || si.materialType == THICK_GLASS) {
        sampleGlassSpecular(si, i, path);
      }
    #endif
    #ifdef USE_SHADOW_CATCHER
      if (si.materialType == SHADOW_CATCHER) {
        sampleShadowCatcher(si, i, path);
      }
    #endif
    if (si.materialType == STANDARD) {
      sampleMaterial(si, i, path);
    }

    // Russian Roulette sampling
    if (i >= 2) {
      float q = 1.0 - dot(path.beta, luminance);
      if (randomSample() < q) {
        path.abort = true;
      }
      path.beta /= 1.0 - q;
    }
  }
}

// Path tracing integrator as described in
// http://www.pbr-book.org/3ed-2018/Light_Transport_I_Surface_Reflection/Path_Tracing.html#
vec4 integrator(inout Ray ray, inout SurfaceInteraction si) {
  Path path;
  path.ray = ray;
  path.li = vec3(0);
  path.alpha = 1.0;
  path.beta = vec3(1.0);
  path.specularBounce = true;
  path.abort = false;

  bounce(path, 1, si);

  // Manually unroll for loop.
  // Some hardware fails to interate over a GLSL loop, so we provide this workaround
  SurfaceInteraction indirectSi;
  ${unrollLoop('i', 2, defines.BOUNCES + 1, 1, `
  // equivelant to
  // for (int i = 1; i < defines.bounces + 1, i += 1)
    bounce(path, i, indirectSi);
  `)}

  return vec4(path.li, path.alpha);
}

void main() {
  initRandom();
  vec2 antialias = pixelSize * (randomSampleVec2() - 0.5);
  // vec2 vCoordAntiAlias = vCoord + antialias;
  vec2 vCoordAntiAlias = vCoord;

  vec3 direction = normalize(vec3(vCoordAntiAlias - 0.5, -1.0) * vec3(camera.aspect, 1.0, camera.fov));

  // Thin lens model with depth-of-field
  // http://www.pbr-book.org/3ed-2018/Camera_Models/Projective_Camera_Models.html#TheThinLensModelandDepthofField
  // vec2 lensPoint = camera.aperture * sampleCircle(randomSampleVec2());
  // vec3 focusPoint = -direction * camera.focus / direction.z; // intersect ray direction with focus plane

  // vec3 origin = vec3(lensPoint, 0.0);
  // direction = normalize(focusPoint - origin);

  // origin = vec3(camera.transform * vec4(origin, 1.0));
  // direction = mat3(camera.transform) * direction;

  vec3 origin = camera.transform[3].xyz;
  direction = mat3(camera.transform) * direction;

  Ray cam;
  initRay(cam, origin, direction);

  SurfaceInteraction si;

  vec4 liAndAlpha = integrator(cam, si);

  if (!(liAndAlpha.x < INF && liAndAlpha.x > -EPS)) {
    liAndAlpha = vec4(0, 0, 0, 1);
  }

  out_light = liAndAlpha;
  out_normal = vec4(si.surfaceNormal, 1.0);
  out_position = vec4(si.position, 1.0);

  // Stratified Sampling Sample Count Test
  // ---------------
  // Uncomment the following code
  // Then observe the colors of the image
  // If:
  // * The resulting image is pure black
  //   Extra samples are being passed to the shader that aren't being used.
  // * The resulting image contains red
  //   Not enough samples are being passed to the shader
  // * The resulting image contains only white with some black
  //   All samples are used by the shader. Correct result!

  // fragColor = vec4(0, 0, 0, 1);
  // if (sampleIndex == SAMPLING_DIMENSIONS) {
  //   fragColor = vec4(1, 1, 1, 1);
  // } else if (sampleIndex > SAMPLING_DIMENSIONS) {
  //   fragColor = vec4(1, 0, 0, 1);
  // }
}
`;
}
