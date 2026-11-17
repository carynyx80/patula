"use client";

// Real-time stable-fluids simulation (semi-Lagrangian advection, vorticity
// confinement, Jacobi pressure solve) rendered with WebGL. Reacts to the
// pointer and drifts on its own with ambient splats.

import { useEffect, useRef } from "react";

type Props = { className?: string; intensity?: number };

const PALETTE: [number, number, number][] = [
  [1.0, 0.62, 0.11], // marigold
  [1.0, 0.8, 0.33], // saffron
  [0.42, 0.18, 0.75], // plum
  [1.0, 0.3, 0.55], // rose
  [0.95, 0.45, 0.1], // ember
];

const VS = `
precision highp float;
attribute vec2 aPosition;
varying vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FS = {
  splat: `precision highp float; varying vec2 vUv;
    uniform sampler2D uTarget; uniform float aspectRatio, radius; uniform vec3 color; uniform vec2 point;
    void main () {
      vec2 p = vUv - point; p.x *= aspectRatio;
      vec3 s = exp(-dot(p, p) / radius) * color;
      gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + s, 1.0);
    }`,
  advection: `precision highp float; varying vec2 vUv;
    uniform sampler2D uVelocity, uSource; uniform vec2 texelSize; uniform float dt, dissipation;
    void main () {
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      gl_FragColor = texture2D(uSource, coord) / (1.0 + dissipation * dt);
    }`,
  divergence: `precision mediump float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x, R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y, B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`,
  curl: `precision mediump float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y, R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x, B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`,
  vorticity: `precision highp float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity, uCurl; uniform float curl, dt;
    void main () {
      float L = texture2D(uCurl, vL).x, R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x, B = texture2D(uCurl, vB).x, C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
      vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
      gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
    }`,
  pressure: `precision mediump float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure, uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      float d = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
    }`,
  gradient: `precision mediump float; varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure, uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
      gl_FragColor = vec4(v, 0.0, 1.0);
    }`,
  clear: `precision mediump float; varying vec2 vUv; uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`,
  display: `precision highp float; varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uTexture; uniform float uIntensity;
    void main () {
      vec3 c = texture2D(uTexture, vUv).rgb;
      // soft relief shading from dye gradients gives the "liquid glass" look
      float dx = length(texture2D(uTexture, vR).rgb) - length(texture2D(uTexture, vL).rgb);
      float dy = length(texture2D(uTexture, vT).rgb) - length(texture2D(uTexture, vB).rgb);
      vec3 n = normalize(vec3(dx, dy, 0.35));
      float light = clamp(dot(n, normalize(vec3(-0.4, 0.6, 1.0))) * 0.55 + 0.6, 0.0, 1.3);
      c *= light * uIntensity * 1.5;
      c = c / (1.0 + c * 0.6);                 // gentle tonemap
      vec3 bg = vec3(0.043, 0.027, 0.063);
      float a = clamp(max(c.r, max(c.g, c.b)) * 1.4, 0.0, 1.0);
      gl_FragColor = vec4(mix(bg, c + bg, a), 1.0);
    }`,
};

export default function FluidCanvas({ className, intensity = 1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    let gl = canvas.getContext("webgl2", params) as WebGL2RenderingContext | WebGLRenderingContext | null;
    const isGL2 = !!gl;
    if (!gl) gl = canvas.getContext("webgl", params) as WebGLRenderingContext | null;
    if (!gl) {
      canvas.classList.add("fluid-fallback");
      return;
    }
    const g = gl;

    let halfFloat: number;
    let internal: number, format: number;
    if (isGL2) {
      const g2 = g as WebGL2RenderingContext;
      g2.getExtension("EXT_color_buffer_float");
      halfFloat = g2.HALF_FLOAT;
      internal = g2.RGBA16F;
      format = g2.RGBA;
    } else {
      const ext = g.getExtension("OES_texture_half_float");
      g.getExtension("OES_texture_half_float_linear");
      if (!ext) {
        canvas.classList.add("fluid-fallback");
        return;
      }
      halfFloat = ext.HALF_FLOAT_OES;
      internal = g.RGBA;
      format = g.RGBA;
    }

    const compile = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) console.warn(g.getShaderInfoLog(s));
      return s;
    };
    const vs = compile(g.VERTEX_SHADER, VS);
    type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
    const program = (fs: string): Prog => {
      const p = g.createProgram()!;
      g.attachShader(p, vs);
      g.attachShader(p, compile(g.FRAGMENT_SHADER, fs));
      g.bindAttribLocation(p, 0, "aPosition");
      g.linkProgram(p);
      const u: Prog["u"] = {};
      const n = g.getProgramParameter(p, g.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const name = g.getActiveUniform(p, i)!.name;
        u[name] = g.getUniformLocation(p, name);
      }
      return { p, u };
    };
    const P = Object.fromEntries(Object.entries(FS).map(([k, v]) => [k, program(v)])) as Record<keyof typeof FS, Prog>;

    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), g.STATIC_DRAW);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), g.STATIC_DRAW);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    g.enableVertexAttribArray(0);

    type FBO = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; attach: (id: number) => number };
    const makeFBO = (w: number, h: number): FBO => {
      g.activeTexture(g.TEXTURE0);
      const tex = g.createTexture()!;
      g.bindTexture(g.TEXTURE_2D, tex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texImage2D(g.TEXTURE_2D, 0, internal, w, h, 0, format, halfFloat, null);
      const fbo = g.createFramebuffer()!;
      g.bindFramebuffer(g.FRAMEBUFFER, fbo);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
      g.viewport(0, 0, w, h);
      g.clear(g.COLOR_BUFFER_BIT);
      return {
        tex, fbo, w, h,
        attach(id) {
          g.activeTexture(g.TEXTURE0 + id);
          g.bindTexture(g.TEXTURE_2D, tex);
          return id;
        },
      };
    };
    const makeDouble = (w: number, h: number) => {
      let a = makeFBO(w, h), b = makeFBO(w, h);
      return {
        get read() { return a; },
        get write() { return b; },
        swap() { [a, b] = [b, a]; },
      };
    };

    const mobile = window.innerWidth < 768;
    const SIM = mobile ? 96 : 128;
    const DYE = mobile ? 512 : 1024;
    const res = (r: number) => {
      const aspect = g.drawingBufferWidth / g.drawingBufferHeight;
      const min = Math.round(r), max = Math.round(r * (aspect < 1 ? 1 / aspect : aspect));
      return g.drawingBufferWidth > g.drawingBufferHeight ? { w: max, h: min } : { w: min, h: max };
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
    };
    resize();
    let s = res(SIM), d = res(DYE);
    let velocity = makeDouble(s.w, s.h), dye = makeDouble(d.w, d.h), pressure = makeDouble(s.w, s.h);
    let divergence = makeFBO(s.w, s.h), curlFBO = makeFBO(s.w, s.h);

    const blit = (target: FBO | null) => {
      if (target) {
        g.viewport(0, 0, target.w, target.h);
        g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      } else {
        g.viewport(0, 0, g.drawingBufferWidth, g.drawingBufferHeight);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      }
      g.drawElements(g.TRIANGLES, 6, g.UNSIGNED_SHORT, 0);
    };
    const use = (pr: Prog) => { g.useProgram(pr.p); return pr.u; };

    const splat = (x: number, y: number, dx: number, dy: number, color: number[]) => {
      const aspect = canvas.width / canvas.height;
      let u = use(P.splat);
      g.uniform1i(u.uTarget, velocity.read.attach(0));
      g.uniform1f(u.aspectRatio, aspect);
      g.uniform2f(u.point, x, y);
      g.uniform3f(u.color, dx, dy, 0);
      g.uniform1f(u.radius, (0.4 / 100) * (aspect > 1 ? aspect : 1));
      blit(velocity.write); velocity.swap();
      u = use(P.splat);
      g.uniform1i(u.uTarget, dye.read.attach(0));
      g.uniform3f(u.color, color[0], color[1], color[2]);
      blit(dye.write); dye.swap();
    };

    const randomColor = () => {
      const c = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      const k = 0.9;
      return [c[0] * k, c[1] * k, c[2] * k];
    };
    const ambient = (n: number) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const f = 600 + Math.random() * 900;
        splat(0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7, Math.cos(a) * f, Math.sin(a) * f, randomColor());
      }
    };

    const step = (dt: number) => {
      g.disable(g.BLEND);
      let u = use(P.curl);
      g.uniform2f(u.texelSize, 1 / s.w, 1 / s.h);
      g.uniform1i(u.uVelocity, velocity.read.attach(0));
      blit(curlFBO);

      u = use(P.vorticity);
      g.uniform2f(u.texelSize, 1 / s.w, 1 / s.h);
      g.uniform1i(u.uVelocity, velocity.read.attach(0));
      g.uniform1i(u.uCurl, curlFBO.attach(1));
      g.uniform1f(u.curl, 28);
      g.uniform1f(u.dt, dt);
      blit(velocity.write); velocity.swap();

      u = use(P.divergence);
      g.uniform2f(u.texelSize, 1 / s.w, 1 / s.h);
      g.uniform1i(u.uVelocity, velocity.read.attach(0));
      blit(divergence);

      u = use(P.clear);
      g.uniform1i(u.uTexture, pressure.read.attach(0));
      g.uniform1f(u.value, 0.8);
      blit(pressure.write); pressure.swap();

      u = use(P.pressure);
      g.uniform2f(u.texelSize, 1 / s.w, 1 / s.h);
      g.uniform1i(u.uDivergence, divergence.attach(0));
      for (let i = 0; i < 20; i++) {
        g.uniform1i(u.uPressure, pressure.read.attach(1));
        blit(pressure.write); pressure.swap();
      }

      u = use(P.gradient);
      g.uniform2f(u.texelSize, 1 / s.w, 1 / s.h);
      g.uniform1i(u.uPressure, pressure.read.attach(0));
      g.uniform1i(u.uVelocity, velocity.read.attach(1));
      blit(velocity.write); velocity.swap();

      u = use(P.advection);
      g.uniform2f(u.texelSize, 1 / s.w, 1 / s.h);
      g.uniform1i(u.uVelocity, velocity.read.attach(0));
      g.uniform1i(u.uSource, velocity.read.attach(0));
      g.uniform1f(u.dt, dt);
      g.uniform1f(u.dissipation, 0.2);
      blit(velocity.write); velocity.swap();

      g.uniform1i(u.uVelocity, velocity.read.attach(0));
      g.uniform1i(u.uSource, dye.read.attach(1));
      g.uniform1f(u.dissipation, 0.32);
      blit(dye.write); dye.swap();
    };

    const render = () => {
      const u = use(P.display);
      g.uniform2f(u.texelSize, 1 / d.w, 1 / d.h);
      g.uniform1i(u.uTexture, dye.read.attach(0));
      g.uniform1f(u.uIntensity, intensity);
      blit(null);
    };

    // pointer
    let last: { x: number; y: number } | null = null;
    let colorTick = 0;
    let pointerColor = randomColor();
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      const x = (e.clientX - r.left) / r.width;
      const y = 1 - (e.clientY - r.top) / r.height;
      if (last) {
        const dx = (x - last.x) * 6000, dy = (y - last.y) * 6000;
        if (Math.abs(dx) + Math.abs(dy) > 1) splat(x, y, dx, dy, pointerColor);
      }
      last = { x, y };
      if (++colorTick % 40 === 0) pointerColor = randomColor();
    };
    const onLeave = () => { last = null; };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    let visible = true;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(canvas);

    const onResize = () => {
      resize();
      s = res(SIM); d = res(DYE);
      velocity = makeDouble(s.w, s.h); dye = makeDouble(d.w, d.h); pressure = makeDouble(s.w, s.h);
      divergence = makeFBO(s.w, s.h); curlFBO = makeFBO(s.w, s.h);
      ambient(6);
    };
    window.addEventListener("resize", onResize);

    ambient(14);
    let raf = 0, prev = performance.now(), sinceAmbient = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - prev) / 1000, 1 / 30);
      prev = now;
      if (!visible || document.hidden) return;
      sinceAmbient += dt;
      if (sinceAmbient > (reduce ? 4 : 0.9)) { ambient(reduce ? 1 : 3); sinceAmbient = 0; }
      step(reduce ? dt * 0.3 : dt);
      render();
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
      g.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [intensity]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
