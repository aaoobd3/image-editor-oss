// Thin WebGL helpers: context creation, shader/program compilation, FBOs, full-screen quad.

export function createGL(canvas, { preserveDrawingBuffer = false } = {}) {
  const opts = {
    premultipliedAlpha: false,
    preserveDrawingBuffer,
    antialias: false,
    alpha: true,
    powerPreference: 'high-performance',
  };
  const gl =
    canvas.getContext('webgl2', opts) ||
    canvas.getContext('webgl', opts) ||
    canvas.getContext('experimental-webgl', opts);
  if (!gl) throw new Error('WebGL is not available in this browser.');
  return gl;
}

export function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed:\n${log}\n--- source ---\n${source}`);
  }
  return sh;
}

export function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    throw new Error(`Program link failed:\n${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  const uniforms = {};
  const numU = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < numU; i++) {
    const info = gl.getActiveUniform(prog, i);
    uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
  }
  const attribs = {};
  const numA = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < numA; i++) {
    const info = gl.getActiveAttrib(prog, i);
    attribs[info.name] = gl.getAttribLocation(prog, info.name);
  }
  return { program: prog, uniforms, attribs };
}

export function createFullScreenQuad(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // Two triangles covering clip space; aPos in [-1,1], aUV in [0,1].
  // prettier-ignore
  const verts = new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
    -1,  1, 0, 1,
     1, -1, 1, 0,
     1,  1, 1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  return buf;
}

export function bindQuad(gl, buf, attribs) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  if (attribs.aPos !== -1 && attribs.aPos !== undefined) {
    gl.enableVertexAttribArray(attribs.aPos);
    gl.vertexAttribPointer(attribs.aPos, 2, gl.FLOAT, false, 16, 0);
  }
  if (attribs.aUV !== -1 && attribs.aUV !== undefined) {
    gl.enableVertexAttribArray(attribs.aUV);
    gl.vertexAttribPointer(attribs.aUV, 2, gl.FLOAT, false, 16, 8);
  }
}

export function createTexture(gl, width, height, { float = false } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Try float textures for higher precision intermediates; gracefully fall back to UNSIGNED_BYTE.
  let internalFormat = gl.RGBA;
  let type = gl.UNSIGNED_BYTE;
  if (float) {
    const isWebGL2 = !!gl.HALF_FLOAT;
    if (isWebGL2) {
      internalFormat = gl.RGBA16F || gl.RGBA;
      type = gl.HALF_FLOAT;
    } else {
      const ext = gl.getExtension('OES_texture_half_float');
      if (ext) type = ext.HALF_FLOAT_OES;
    }
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
  return tex;
}

export function createFBO(gl, width, height, opts) {
  const tex = createTexture(gl, width, height, opts);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    // Fallback to byte texture if half-float wasn't completable.
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    return createFBO(gl, width, height, { float: false });
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex, width, height };
}

export function uploadImageTexture(gl, image) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  return { texture: tex, width: image.width || image.naturalWidth, height: image.height || image.naturalHeight };
}
