<!--
  Confetti Pool (FLIP/PIC).

  Точь-в-точь спецификация briefs/confetti-pool.md. Танк — нормализованные координаты
  (tankWidth=2, tankHeight=2·vH/vW), конверсия в пиксели делается в шейдере через
  u_renderScale. 5 мешей: 4 shape (cross/square/circle/triangle) + 1 textured-плейн
  с атласом 8 колонок × 3 канала = 24 формы. useTextured-toggle переключает группы.
-->
<template>
  <canvas ref="canvas" class="confetti-pool" />
</template>

<script setup>
  import * as THREE from 'three';
  import GUI from 'lil-gui';
  import flipTextureUrl from '~/assets/textures/flip_texture.png';

  const canvas = ref(null);

  // Ортокамера: 1 unit = 1 CSS px, origin в центре. Шейдер сам переводит tank-coords
  // в pixel-screen-coords centered через u_renderScale, так что world-координаты
  // совпадают с пикселями viewport.
  const { scene, camera, mouse, size, onTick, onResize } = useScene(canvas, {
    cameraType: 'orthographic',
    cameraPosition: [0, 0, 10],
    near: -100,
    far: 100,
    clearColor: 0x1a2ffb,
  });

  // Cell-type маркеры FlipSim — три состояния: solid стенка, air пустая, fluid с частицей.
  const FLUID_CELL = 0;
  const AIR_CELL = 1;
  const SOLID_CELL = 2;

  // Палитра рефа: 5 ярких + 4 серых = 9 цветов. Селектор `j < 5 ? j : 5 + ((j-5) % 4)`
  // даёт ≈11% ярких / 89% серых частиц.
  const COLORS_HEX = ['#ff383c', '#0029ff', '#bb2bff', '#1eff5d', '#cfff0f', '#d6e4ec', '#bbcbda', '#7a8d9b', '#262229'];
  const COLORS = COLORS_HEX.map((h) => new THREE.Color(h));

  // EMIT_RATE — частиц/сек. В рефе константа определена вне показанного фрагмента;
  // 2000 — подбор по визуальному ощущению (танк ~1900 частиц заполняется ~1 сек).
  const EMIT_RATE = 2000;

  // Реф клампит dt снизу до 1/120 (защита от слишком мелких шагов в ang_vel-формулах)
  // и сверху до 1/60 (выше FLIP теряет устойчивость).
  const MIN_DT = 1 / 120;
  const MAX_DT = 1 / 60;

  const SHAPE_COUNT = 4; // 4 shape-меша + 1 textured = 5 всего

  // math.* утилиты — реф-эквиваленты framework-функций.
  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const fit = (v, fMin, fMax, tMin, tMax) =>
    tMin + Math.max(0, Math.min(1, (v - fMin) / (fMax - fMin))) * (tMax - tMin);
  const normalizeAngle = (a) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };

  // Module-level Vector2 — переиспользуем в hot loop handleParticleCollisions,
  // чтобы не аллоцировать на каждом кадре × N частиц.
  const _v0 = new THREE.Vector2();
  const _v1 = new THREE.Vector2();
  const _v2 = new THREE.Vector2();

  // FlipSim — буквальная копия рефа (Слой 4 в briefs/confetti-pool.md).
  // Все размеры в нормализованных tank-координатах (tankW=2).
  class FlipSim {
    constructor() {
      this.isFlushing = false;
      this.hasInitialized = false;
      this.emitterPosA = new THREE.Vector2(1, 1);
      this.emitterPosB = new THREE.Vector2(1, 1);
      this.colliderRectList = [];
    }

    addColliderRect(e, t = 0, r = 0, n = 0, a = 0) {
      const l = this.fInvSpacing;
      const c = this.fNumY;
      let u = clamp(Math.round(e.x * l) - t, 0, this.fNumX - 1);
      const f = clamp(Math.round(e.y * l) - a, 0, this.fNumY - 1);
      let p = clamp(Math.round((e.x + e.w) * l) + r, 0, this.fNumX - 1);
      let g = clamp(Math.round((e.y + e.h) * l) + n, 0, this.fNumY - 1);
      p = Math.max(u, p);
      g = Math.max(f, g);
      this.colliderRectList.push(e);
      for (let i = u; i <= p; i++) {
        for (let j = f; j <= g; j++) {
          this.s[i * c + j] = 0;
        }
      }
      e.x = u / l;
      e.y = f / l;
      e.w = Math.max(1, p - u) / l;
      e.h = Math.max(1, g - f) / l;
      e.l = e.x;
      e.r = e.x + e.w;
      e.b = e.y;
      e.t = e.y + e.h;
      e.hw = e.w / 2;
      e.hh = e.h / 2;
      e.cx = e.x + e.hw;
      e.cy = e.y + e.hh;
    }

    init(density, width, height, cellSize, particleRadius, maxParticles) {
      const isReinit = this.hasInitialized;
      this.colliderRectList.length = 0;
      this.density = density;
      this.fNumX = Math.ceil(width / cellSize) + 1;
      this.fNumY = Math.ceil(height / cellSize) + 1;
      this.h = Math.max(width / this.fNumX, height / this.fNumY);
      this.fInvSpacing = 1 / this.h;
      const numCells = this.fNumX * this.fNumY;
      this.tankInnerWidth = (this.fNumX - 2) * this.h;
      this.tankInnerHeight = (this.fNumY - 2) * this.h;

      // Реаллок grid-массивов только если выросло; иначе — обнулим ниже.
      if (!isReinit || numCells > this.cellType.length) {
        this.u = new Float32Array(numCells);
        this.v = new Float32Array(numCells);
        this.du = new Float32Array(numCells);
        this.dv = new Float32Array(numCells);
        this.prevU = new Float32Array(numCells);
        this.prevV = new Float32Array(numCells);
        this.p = new Int8Array(numCells);
        this.s = new Int8Array(numCells);
        this.cellType = new Int8Array(numCells);
        this.particleDensity = new Float32Array(numCells);
      }
      this.fNumCells = numCells;

      for (let i = 0; i < numCells; i++) {
        this.u[i] = 0;
        this.v[i] = 0;
        this.du[i] = 0;
        this.dv[i] = 0;
        this.prevU[i] = 0;
        this.prevV[i] = 0;
        this.p[i] = 0;
        this.s[i] = 0;
        this.cellType[i] = 0;
        this.particleDensity[i] = 0;
      }

      this.particleRadius = particleRadius;
      this.pInvSpacing = 1 / (2.2 * particleRadius);
      this.pNumX = Math.floor(width * this.pInvSpacing) + 1;
      this.pNumY = Math.floor(height * this.pInvSpacing) + 1;
      this.particleRestDensity = 0;

      const pNumCells = this.pNumX * this.pNumY;
      if (!isReinit || pNumCells > this.numCellParticles.length) {
        this.numCellParticles = new Uint32Array(pNumCells);
        this.firstCellParticle = new Uint32Array(pNumCells + 1);
      } else {
        for (let i = 0; i < pNumCells; i++) {
          this.numCellParticles[i] = 0;
          this.firstCellParticle[i] = 0;
        }
        this.firstCellParticle[pNumCells] = 0;
      }
      this.pNumCells = pNumCells;

      // ВАЖНО: эти три буфера пересоздаются на КАЖДОМ init(). Все Instanced-атрибуты,
      // ссылающиеся на них через subarray, становятся stale → переcобираем в reInitTank.
      this.particlePosOut = new Float32Array(2 * maxParticles);
      this.particlePos = new Float32Array(2 * maxParticles);
      this.particleInfo = new Float32Array(2 * maxParticles);

      if (!isReinit || maxParticles > this.particleDir.length / 2) {
        this.particleDir = new Float32Array(2 * maxParticles);
        this.particlePrevPos = new Float32Array(2 * maxParticles);
        this.particleVel = new Float32Array(2 * maxParticles);
        this.cellParticleIds = new Uint32Array(maxParticles);
        this.particleStatuses = new Uint8Array(maxParticles);
      }

      // Все слоты стартуют как «мёртвые» (status=0, pos=-1e4 — далеко за пределами танка).
      for (let i = 0; i < maxParticles; i++) {
        this.particlePos[i * 2] = -1e4;
        this.particlePos[i * 2 + 1] = 0;
        this.particlePosOut[i * 2] = -1e4;
        this.particlePosOut[i * 2 + 1] = 0;
        this.particleInfo[i * 2] = 0;
        this.particleInfo[i * 2 + 1] = 0;
        this.particleDir[i * 2] = 0;
        this.particleDir[i * 2 + 1] = 0;
        this.particlePrevPos[i * 2] = -1e4;
        this.particlePrevPos[i * 2 + 1] = 0;
        this.particleVel[i * 2] = 0;
        this.particleVel[i * 2 + 1] = 0;
        this.cellParticleIds[i] = 0;
        this.particleStatuses[i] = 0;
      }
      this.numParticles = maxParticles;
      this.maxParticles = maxParticles;

      // Внешний слой ячеек — solid стенки (s=0), внутренние — passable (s=1).
      const n = this.fNumY;
      for (let i = 0; i < this.fNumX; i++) {
        for (let j = 0; j < this.fNumY; j++) {
          let s = 0;
          if (i > 0 && i < this.fNumX - 1 && j > 0 && j < this.fNumY - 1) s = 1;
          this.s[i * n + j] = s;
        }
      }

      this.hasInitialized = true;
    }

    integrateParticles(dt, gravity) {
      for (let i = 0; i < this.numParticles; i++) {
        if (!this.particleStatuses[i]) continue;
        this.particleVel[2 * i + 1] += dt * gravity;
        this.particlePos[2 * i] += this.particleVel[2 * i] * dt;
        this.particlePos[2 * i + 1] += this.particleVel[2 * i + 1] * dt;
      }
    }

    // Сепарация (PBD-style). minDist = 3·radius (с запасом — иначе при плотной упаковке
    // частицы продолжают «трещать» при колебаниях вокруг 2·radius).
    pushParticlesApart(numIters) {
      this.numCellParticles.fill(0);
      for (let i = 0; i < this.numParticles; i++) {
        if (!this.particleStatuses[i]) continue;
        const x = this.particlePos[2 * i];
        const y = this.particlePos[2 * i + 1];
        const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
        const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
        this.numCellParticles[xi * this.pNumY + yi]++;
      }
      let first = 0;
      for (let i = 0; i < this.pNumCells; i++) {
        first += this.numCellParticles[i];
        this.firstCellParticle[i] = first;
      }
      this.firstCellParticle[this.pNumCells] = first;
      for (let i = 0; i < this.numParticles; i++) {
        if (!this.particleStatuses[i]) continue;
        const x = this.particlePos[2 * i];
        const y = this.particlePos[2 * i + 1];
        const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
        const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
        const cellNr = xi * this.pNumY + yi;
        this.firstCellParticle[cellNr]--;
        this.cellParticleIds[this.firstCellParticle[cellNr]] = i;
      }

      const minDist = 3 * this.particleRadius;
      const minDist2 = minDist * minDist;

      for (let iter = 0; iter < numIters; iter++) {
        for (let i = 0; i < this.numParticles; i++) {
          if (!this.particleStatuses[i]) continue;
          const px = this.particlePos[2 * i];
          const py = this.particlePos[2 * i + 1];
          const pxi = Math.floor(px * this.pInvSpacing);
          const pyi = Math.floor(py * this.pInvSpacing);
          const x0 = Math.max(pxi - 1, 0);
          const y0 = Math.max(pyi - 1, 0);
          const x1 = Math.min(pxi + 1, this.pNumX - 1);
          const y1 = Math.min(pyi + 1, this.pNumY - 1);
          for (let xi = x0; xi <= x1; xi++) {
            for (let yi = y0; yi <= y1; yi++) {
              const cellNr = xi * this.pNumY + yi;
              const start = this.firstCellParticle[cellNr];
              const end = this.firstCellParticle[cellNr + 1];
              for (let k = start; k < end; k++) {
                const id = this.cellParticleIds[k];
                if (id === i || !this.particleStatuses[id]) continue;
                const qx = this.particlePos[2 * id];
                const qy = this.particlePos[2 * id + 1];
                let dx = qx - px;
                let dy = qy - py;
                const d2 = dx * dx + dy * dy;
                if (d2 > minDist2 || d2 === 0) continue;
                const d = Math.sqrt(d2);
                const sep = (0.5 * (minDist - d)) / d;
                dx *= sep;
                dy *= sep;
                this.particlePos[2 * i] -= dx;
                this.particlePos[2 * i + 1] -= dy;
                this.particlePos[2 * id] += dx;
                this.particlePos[2 * id + 1] += dy;
              }
            }
          }
        }
      }
    }

    // Стенки + obstacle (cursor) + DOM-rect-коллайдеры + обновление particleInfo
    // (rotation/ang_vel) + сохранение prevPos. cursor-vel внутри радиуса присваивается
    // частице с множителем ×2 (особенность рефа — кильватер за курсором заметнее).
    handleParticleCollisions(dt, cursorX, cursorY, cursorR, cursorVx, cursorVy) {
      const h = 1 / this.fInvSpacing;
      const r = this.particleRadius;
      const minDistObs = cursorR + r;
      const minDistObs2 = minDistObs * minDistObs;
      const minX = h + r;
      const maxX = (this.fNumX - 1) * h - r;
      const minY = h + r;
      const maxY = (this.fNumY - 1) * h - r;
      const isFlushing = this.isFlushing;

      for (let i = 0; i < this.numParticles; i++) {
        if (!this.particleStatuses[i]) continue;
        let x = this.particlePos[2 * i];
        let y = this.particlePos[2 * i + 1];

        const dx = x - cursorX;
        const dy = y - cursorY;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDistObs2) {
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            const corr = (minDistObs - d) / d;
            x += dx * corr;
            y += dy * corr;
          }
          // ВАЖНО: cursor-vel × 2 (реф-особенность).
          this.particleVel[2 * i] = cursorVx * 2;
          this.particleVel[2 * i + 1] = cursorVy * 2;
        }

        // Прямоугольные DOM-коллайдеры — для нашего юзкейса список пуст, цикл не исполняется.
        const dispX = x - this.particlePrevPos[2 * i];
        const dispY = y - this.particlePrevPos[2 * i + 1];
        const dispLen = Math.sqrt(dispX * dispX + dispY * dispY);
        if (dispLen > 0) {
          const nx = dispX / dispLen;
          const ny = dispY / dispLen;
          const ix = 1 / (Math.abs(nx) > 1e-4 ? nx : 1e-4);
          const iy = 1 / (Math.abs(ny) > 1e-4 ? ny : 1e-4);
          for (let r2 = 0; r2 < this.colliderRectList.length; r2++) {
            const rect = this.colliderRectList[r2];
            if (x > rect.l && x < rect.r && y > rect.b && y < rect.t) {
              const dxR = x - rect.cx;
              const dyR = y - rect.cy;
              const t1 = dxR * ix;
              const t2 = dyR * iy;
              const aw = Math.abs(ix) * rect.hw;
              const ah = Math.abs(iy) * rect.hh;
              const tDelta = Math.max(-t1 - aw, -t2 - ah);
              x += nx * tDelta;
              y += ny * tDelta;
            }
          }
        }

        // Стенки. При isFlushing=true частицы, выпавшие через дно, killятся
        // (status=0, pos=-1e4) и идут в re-emit pool — это и есть «fountain mode».
        if (x < minX) {
          x = minX;
          this.particleVel[2 * i] = 0;
        }
        if (x > maxX) {
          x = maxX;
          this.particleVel[2 * i] = 0;
        }
        if (y < minY) {
          if (isFlushing) {
            x = -1e4;
            y = 0;
            this.particleStatuses[i] = 0;
          } else {
            y = minY;
            this.particleVel[2 * i + 1] = 0;
          }
        }
        if (y > maxY) {
          y = maxY;
          this.particleVel[2 * i + 1] = 0;
        }

        this.particlePos[2 * i] = x;
        this.particlePos[2 * i + 1] = y;
      }

      // Обновление particleInfo (rotation/ang_vel) — отдельный цикл, для всех частиц
      // (для dead vel=0, ветка пропускается). L (длина velocity) уже в норм. ед./сек,
      // так что L * normalizeAngle(Δφ) идёт в ang_vel прямо без доп. нормализации.
      for (let i = 0; i < this.numParticles; i++) {
        _v0.fromArray(this.particleVel, 2 * i);
        const L = _v0.length();
        if (L > 1e-5) {
          _v2.fromArray(this.particleDir, 2 * i);
          _v1.fromArray(this.particleInfo, 2 * i);
          _v1.y = mix(_v1.y, 0, 1 - Math.exp(-4 * dt));
          _v0.multiplyScalar(1 / L);
          const curDir = Math.atan2(_v0.y, _v0.x);
          const prevDir = Math.atan2(_v2.y, _v2.x);
          _v1.y += L * normalizeAngle(curDir - prevDir);
          _v1.x += _v1.y * dt;
          _v1.toArray(this.particleInfo, 2 * i);
          _v2.toArray(this.particleDir, 2 * i);
        }
        this.particlePrevPos[2 * i] = this.particlePos[2 * i];
        this.particlePrevPos[2 * i + 1] = this.particlePos[2 * i + 1];
      }
    }

    // Билинейная оценка плотности по сетке. На первом кадре с FLUID-ячейками
    // фиксирует ρ₀ = avg(ρ по fluid-cells).
    updateParticleDensity() {
      const n = this.fNumY;
      const h = this.h;
      const h1 = this.fInvSpacing;
      const h2 = 0.5 * h;
      const d = this.particleDensity;
      d.fill(0);
      for (let i = 0; i < this.numParticles; i++) {
        if (!this.particleStatuses[i]) continue;
        let x = this.particlePos[2 * i];
        let y = this.particlePos[2 * i + 1];
        x = clamp(x, h, (this.fNumX - 1) * h);
        y = clamp(y, h, (this.fNumY - 1) * h);
        const x0 = Math.floor((x - h2) * h1);
        const tx = (x - h2 - x0 * h) * h1;
        const x1 = Math.min(x0 + 1, this.fNumX - 2);
        const y0 = Math.floor((y - h2) * h1);
        const ty = (y - h2 - y0 * h) * h1;
        const y1 = Math.min(y0 + 1, this.fNumY - 2);
        const sx = 1 - tx;
        const sy = 1 - ty;
        if (x0 < this.fNumX && y0 < this.fNumY) d[x0 * n + y0] += sx * sy;
        if (x1 < this.fNumX && y0 < this.fNumY) d[x1 * n + y0] += tx * sy;
        if (x1 < this.fNumX && y1 < this.fNumY) d[x1 * n + y1] += tx * ty;
        if (x0 < this.fNumX && y1 < this.fNumY) d[x0 * n + y1] += sx * ty;
      }
      if (this.particleRestDensity === 0) {
        let sum = 0;
        let num = 0;
        for (let i = 0; i < this.fNumCells; i++) {
          if (this.cellType[i] === FLUID_CELL) {
            sum += d[i];
            num++;
          }
        }
        if (num > 0) this.particleRestDensity = sum / num;
      }
    }

    // P→G (toGrid=true) и G→P (toGrid=false). При G→P — смесь PIC и FLIP по flipRatio.
    transferVelocities(toGrid, flipRatio) {
      const n = this.fNumY;
      const h = this.h;
      const h1 = this.fInvSpacing;
      const h2 = 0.5 * h;

      if (toGrid) {
        this.prevU.set(this.u);
        this.prevV.set(this.v);
        this.du.fill(0);
        this.dv.fill(0);
        this.u.fill(0);
        this.v.fill(0);
        for (let i = 0; i < this.fNumCells; i++) {
          this.cellType[i] = this.s[i] === 0 ? SOLID_CELL : AIR_CELL;
        }
        for (let i = 0; i < this.numParticles; i++) {
          if (!this.particleStatuses[i]) continue;
          const x = this.particlePos[2 * i];
          const y = this.particlePos[2 * i + 1];
          const xi = clamp(Math.floor(x * h1), 0, this.fNumX - 1);
          const yi = clamp(Math.floor(y * h1), 0, this.fNumY - 1);
          const cellNr = xi * n + yi;
          if (this.cellType[cellNr] === AIR_CELL) this.cellType[cellNr] = FLUID_CELL;
        }
      }

      for (let component = 0; component < 2; component++) {
        const dx_ = component === 0 ? 0 : h2;
        const dy_ = component === 0 ? h2 : 0;
        const f = component === 0 ? this.u : this.v;
        const prevF = component === 0 ? this.prevU : this.prevV;
        const dF = component === 0 ? this.du : this.dv;

        for (let i = 0; i < this.numParticles; i++) {
          if (!this.particleStatuses[i]) continue;
          let x = this.particlePos[2 * i];
          let y = this.particlePos[2 * i + 1];
          x = clamp(x, h, (this.fNumX - 1) * h);
          y = clamp(y, h, (this.fNumY - 1) * h);
          const x0 = Math.min(Math.floor((x - dx_) * h1), this.fNumX - 2);
          const tx = (x - dx_ - x0 * h) * h1;
          const x1 = Math.min(x0 + 1, this.fNumX - 2);
          const y0 = Math.min(Math.floor((y - dy_) * h1), this.fNumY - 2);
          const ty = (y - dy_ - y0 * h) * h1;
          const y1 = Math.min(y0 + 1, this.fNumY - 2);
          const sx = 1 - tx;
          const sy = 1 - ty;
          const d0 = sx * sy;
          const d1 = tx * sy;
          const d2 = tx * ty;
          const d3 = sx * ty;
          const nr0 = x0 * n + y0;
          const nr1 = x1 * n + y0;
          const nr2 = x1 * n + y1;
          const nr3 = x0 * n + y1;

          if (toGrid) {
            const pv = this.particleVel[2 * i + component];
            f[nr0] += pv * d0;
            dF[nr0] += d0;
            f[nr1] += pv * d1;
            dF[nr1] += d1;
            f[nr2] += pv * d2;
            dF[nr2] += d2;
            f[nr3] += pv * d3;
            dF[nr3] += d3;
          } else {
            const offset = component === 0 ? n : 1;
            const valid0 = this.cellType[nr0] !== AIR_CELL || this.cellType[nr0 - offset] !== AIR_CELL ? 1 : 0;
            const valid1 = this.cellType[nr1] !== AIR_CELL || this.cellType[nr1 - offset] !== AIR_CELL ? 1 : 0;
            const valid2 = this.cellType[nr2] !== AIR_CELL || this.cellType[nr2 - offset] !== AIR_CELL ? 1 : 0;
            const valid3 = this.cellType[nr3] !== AIR_CELL || this.cellType[nr3 - offset] !== AIR_CELL ? 1 : 0;
            const vCur = this.particleVel[2 * i + component];
            const dSum = valid0 * d0 + valid1 * d1 + valid2 * d2 + valid3 * d3;
            if (dSum > 0) {
              const picV =
                (valid0 * d0 * f[nr0] + valid1 * d1 * f[nr1] + valid2 * d2 * f[nr2] + valid3 * d3 * f[nr3]) / dSum;
              const corr =
                (valid0 * d0 * (f[nr0] - prevF[nr0]) +
                  valid1 * d1 * (f[nr1] - prevF[nr1]) +
                  valid2 * d2 * (f[nr2] - prevF[nr2]) +
                  valid3 * d3 * (f[nr3] - prevF[nr3])) /
                dSum;
              const flipV = vCur + corr;
              this.particleVel[2 * i + component] = (1 - flipRatio) * picV + flipRatio * flipV;
            }
          }
        }

        if (toGrid) {
          for (let i = 0; i < f.length; i++) {
            if (dF[i] > 0) f[i] /= dF[i];
          }
          // Restore: грани, прилегающие к solid, держат предыдущую скорость (no-slip).
          for (let i = 0; i < this.fNumX; i++) {
            for (let j = 0; j < this.fNumY; j++) {
              const idx = i * n + j;
              const solid = this.cellType[idx] === SOLID_CELL;
              if (solid || (i > 0 && this.cellType[(i - 1) * n + j] === SOLID_CELL)) this.u[idx] = this.prevU[idx];
              if (solid || (j > 0 && this.cellType[i * n + j - 1] === SOLID_CELL)) this.v[idx] = this.prevV[idx];
            }
          }
        }
      }
    }

    // Решение давления (Gauss-Seidel + SOR). compensateDrift — поправка на дрейф плотности.
    solveIncompressibility(numIters, dt, overRelaxation, compensateDrift = true) {
      this.p.fill(0);
      this.prevU.set(this.u);
      this.prevV.set(this.v);
      const n = this.fNumY;
      const lFactor = (this.density * this.h) / dt;

      for (let iter = 0; iter < numIters; iter++) {
        for (let i = 1; i < this.fNumX - 1; i++) {
          for (let j = 1; j < this.fNumY - 1; j++) {
            if (this.cellType[i * n + j] !== FLUID_CELL) continue;
            const center = i * n + j;
            const left = (i - 1) * n + j;
            const right = (i + 1) * n + j;
            const bottom = i * n + j - 1;
            const top = i * n + j + 1;
            const sx0 = this.s[left];
            const sx1 = this.s[right];
            const sy0 = this.s[bottom];
            const sy1 = this.s[top];
            const sSum = sx0 + sx1 + sy0 + sy1;
            if (sSum === 0) continue;
            let div = this.u[right] - this.u[center] + this.v[top] - this.v[center];
            if (this.particleRestDensity > 0 && compensateDrift) {
              const k = 0.5;
              const compression = this.particleDensity[center] - this.particleRestDensity;
              if (compression > 0) div -= k * compression;
            }
            let pp = -div / sSum;
            pp *= overRelaxation;
            this.p[center] += lFactor * pp;
            this.u[center] -= sx0 * pp;
            this.u[right] += sx1 * pp;
            this.v[center] -= sy0 * pp;
            this.v[top] += sy1 * pp;
          }
        }
      }
    }

    // Полный шаг симуляции: эмиссия → integrate → push apart → collisions →
    // P→G → density → pressure → G→P → smooth output buffer.
    simulate(dt, gravity, flipRatio, pressureIters, particleIters, overRelaxation, compensateDrift, separateParticles, cursorX, cursorY, cursorR, cursorVx, cursorVy) {
      dt = Math.min(dt, MAX_DT);
      const numSubSteps = 1;
      const sdt = dt / numSubSteps;
      const toEmitPerSubstep = Math.ceil(EMIT_RATE * dt);
      let emitted = 0;

      for (let step = 0; step < numSubSteps; step++) {
        // Эмиссия: оживляем мёртвые слоты до лимита. Позиция = mix(emitterA, emitterB, rand) +
        // микроjitter ±0.005 (страховка от d2=0 в pushParticlesApart).
        for (let i = 0; i < this.numParticles && emitted / numSubSteps < toEmitPerSubstep; i++) {
          if (this.particleStatuses[i] === 0) {
            const t = Math.random();
            const px = mix(this.emitterPosA.x, this.emitterPosB.x, t) + (Math.random() - 0.5) * 0.01;
            const py = mix(this.emitterPosA.y, this.emitterPosB.y, t) + (Math.random() - 0.5) * 0.01;
            this.particlePos[2 * i] = px;
            this.particlePrevPos[2 * i] = px;
            this.particlePosOut[2 * i] = px;
            this.particlePos[2 * i + 1] = py;
            this.particlePrevPos[2 * i + 1] = py;
            this.particlePosOut[2 * i + 1] = py;
            this.particleInfo[2 * i] = Math.random() * Math.PI * 2;
            this.particleInfo[2 * i + 1] = 0;
            this.particleDir[2 * i] = 0;
            this.particleDir[2 * i + 1] = -1;
            // Vy = (2..5) · gravity · 0.1. gravity отрицательна → vy отрицательна (вниз).
            const I = (2 + Math.pow(Math.random(), 2) * 3) * gravity * 0.1;
            this.particleVel[2 * i] = 0;
            this.particleVel[2 * i + 1] = I;
            this.particleStatuses[i] = 1;
            emitted++;
          }
        }

        this.integrateParticles(sdt, gravity);
        if (separateParticles) this.pushParticlesApart(particleIters);
        this.handleParticleCollisions(sdt, cursorX, cursorY, cursorR, cursorVx, cursorVy);
        this.transferVelocities(true);
        this.updateParticleDensity();
        this.solveIncompressibility(pressureIters, sdt, overRelaxation, compensateDrift);
        this.transferVelocities(false, flipRatio);

        // Сглаживание output-буфера для рендера (двойная буферизация).
        for (let i = 0; i < this.numParticles; i++) {
          this.particlePosOut[2 * i] =
            this.particlePos[2 * i] + (this.particlePosOut[2 * i] - this.particlePrevPos[2 * i]) * 0.5;
          this.particlePosOut[2 * i + 1] =
            this.particlePos[2 * i + 1] + (this.particlePosOut[2 * i + 1] - this.particlePrevPos[2 * i + 1]) * 0.5;
        }
      }
    }
  }

  const flipSim = new FlipSim();

  // Геометрии. Cross — кастомная (12 вершин, 30 индексов из рефа). Остальные — стандартные
  // three.js. Пятая (texture-plane) вдвое больше других (1.6 против 0.8) — это для атласа.
  function buildCrossGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([
          0.0714286, -0.5, 0, -0.0714286, -0.5, 0, 0.5, -0.0714286, 0, 0.0714286, -0.0714286, 0, -0.0714286, -0.0714286, 0, -0.5,
          -0.0714286, 0, 0.5, 0.0714286, 0, 0.0714286, 0.0714286, 0, -0.0714286, 0.0714286, 0, -0.5, 0.0714286, 0, 0.0714286, 0.5, 0,
          -0.0714286, 0.5, 0,
        ]),
        3
      )
    );
    g.setIndex(
      new THREE.BufferAttribute(
        new Uint8Array([4, 5, 9, 0, 4, 3, 8, 7, 3, 7, 2, 3, 7, 6, 2, 11, 10, 7, 7, 8, 11, 3, 4, 8, 0, 1, 4, 4, 9, 8]),
        1
      )
    );
    return g;
  }

  // Шейдеры — точь-в-точь реф, кроме `<ufxVert>`-инклюда: getScreenPosition заменён на
  // identity (`screenPos = basePos`), потому что у нас нет скролла / page-секций.
  const vertexShader = /* glsl */ `
attribute vec2 instancedPos;
attribute vec2 instancedInfo;
uniform vec2 u_tankOffset;
uniform vec2 u_tankSize;
uniform vec2 u_tankActualSize;
uniform vec2 u_renderScale;
uniform float u_radius;
uniform float u_opacity;

#ifdef IS_TEXTURE
attribute vec4 instanceColorShape;
varying vec3 v_color;
varying vec3 v_colorMix;
varying vec2 v_uv;
#endif

void main() {
  float angle = instancedInfo.x;
  float s = sin(angle);
  float c = cos(angle);
  mat2 m = mat2(c, -s, s, c);

  // tank coords → нормализованные [-0.5, 0.5] → pixel-screen-coords centered.
  // ВНИМАНИЕ: реф-шейдер делал basePos.y = -basePos.y для CSS top-down системы.
  // У нас WebGL-камера (bottom-up), поэтому флип убран — иначе гравитация
  // визуально работает «вверх», а курсор попадает в зеркальную точку относительно
  // того, где пользователь его видит.
  vec3 basePos = vec3((instancedPos - u_tankOffset) / u_tankActualSize - vec2(0.5), 0.0);
  basePos.xy *= u_renderScale * 2.0;

  float particleSize = 1.0;

  #ifdef IS_TEXTURE
    // colorFract в {0, 1/3, 2/3} (циклически по 3) — селектор RGB-канала текстуры.
    float colorFract = fract(instanceColorShape.w / 3.0);
    v_color = instanceColorShape.rgb;
    v_colorMix = vec3(
      colorFract < 0.25 ? 1.0 : 0.0,
      abs(colorFract - 0.5) < 0.25 ? 1.0 : 0.0,
      colorFract > 0.75 ? 1.0 : 0.0
    );
    v_uv = uv;
    // Текстура — атлас 8 колонок: floor(w/3) даёт column index ∈ [0..7].
    v_uv.x = (v_uv.x + floor(instanceColorShape.w / 3.0)) / 8.0;
  #else
    // Shape-mode: при высокой ang_vel частица слегка раздувается (визуальный эффект кручения).
    particleSize += min(1.0, abs(instancedInfo.y) * 0.01);
  #endif

  vec3 screenPos = basePos;
  screenPos.xy += (m * position.xy) * u_radius * particleSize * u_renderScale.x * 2.0 * u_opacity;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(screenPos, 1.0);
}
`;

  const fragmentShader = /* glsl */ `
#ifdef IS_TEXTURE
uniform sampler2D u_texture;
varying vec3 v_color;
varying vec3 v_colorMix;
varying vec2 v_uv;
#else
uniform vec3 u_color;
#endif

void main() {
  #ifdef IS_TEXTURE
    // dot(colorMix, texture.rgb) выбирает один из RGB-каналов по one-hot маске —
    // в один пиксель упакованы 3 разные shape-маски (R, G, B).
    float a = dot(v_colorMix, texture2D(u_texture, v_uv).rgb);
    gl_FragColor = vec4(v_color, a);
  #else
    gl_FragColor = vec4(u_color, 1.0);
  #endif
}
`;

  // Render-state.
  const sharedUniforms = {
    u_tankOffset: { value: new THREE.Vector2() },
    u_tankSize: { value: new THREE.Vector2() },
    u_tankActualSize: { value: new THREE.Vector2() },
    u_radius: { value: 0 },
    u_opacity: { value: 1 },
    u_renderScale: { value: new THREE.Vector2() },
    u_color: { value: new THREE.Color('#1A2FFB') },
    u_texture: { value: null },
  };

  const shapedContainer = new THREE.Object3D();
  const texturedContainer = new THREE.Object3D();
  let shapeMeshes = [];
  let texturedMesh = null;
  const baseGeometries = [];
  const instancedGeometries = [];
  const materials = [];
  let textureRef = null;

  // Параметры для GUI / runtime.
  const params = {
    useTextured: false,
    // Цвет shapes (когда useTextured=false). Белый — контрастно к синему фону.
    colorHex: '#ffffff',
    opacity: 1,
    flipRatio: 0,
    pressureIters: 60,
    particleIters: 4,
    overRelaxation: 1,
    compensateDrift: true,
  };

  // Состояние, обновляемое в reInitTank (зависит от viewport / useTextured).
  const state = {
    gravity: 0,
    tankH: 0,
    particleR: 0,
    hasDown: false,
  };

  // Cursor-tracking.
  let prevMousePxX = 0;
  let prevMousePxY = 0;
  let curMousePxX = 0;
  let curMousePxY = 0;
  let isDown = false;
  let pointerInside = false;
  let gui = null;

  function setupCamera() {
    const cam = camera.value;
    cam.left = -size.width / 2;
    cam.right = size.width / 2;
    cam.top = size.height / 2;
    cam.bottom = -size.height / 2;
    cam.updateProjectionMatrix();
  }

  // Преобразование canvas-px (bottom-up Y, как у useScene.mouse) в tank-coords.
  // Реф ожидает top-down py, но вход у нас уже bottom-up — конверсия унифицирована.
  function canvasPxToTank(pxX, pxYbu) {
    const vW = size.width;
    const vH = size.height;
    const cx = clamp(pxX, 0, vW - 1);
    const cy = clamp(pxYbu, 0, vH - 1);
    return {
      x: (cx / vW) * flipSim.tankInnerWidth + flipSim.h,
      y: (cy / vH) * flipSim.tankInnerHeight + flipSim.h,
    };
  }

  function preInit() {
    // 5 геометрий в строгом порядке: cross, square(0.8), circle(0.4, 10), triangle, texture-plane(1.6).
    baseGeometries.push(buildCrossGeometry());
    baseGeometries.push(new THREE.PlaneGeometry(0.8, 0.8));
    baseGeometries.push(new THREE.CircleGeometry(0.4, 10));
    baseGeometries.push(new THREE.CircleGeometry(0.5, 3));
    baseGeometries.push(new THREE.PlaneGeometry(1.6, 1.6));

    // Текстура — асинхронная загрузка. До onLoad u_texture = null, GPU подставит чёрный.
    const texLoader = new THREE.TextureLoader();
    texLoader.load(flipTextureUrl, (tex) => {
      // Atlas-текстура: фильтрация — линейная (без mipmaps), без wrap.
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      sharedUniforms.u_texture.value = tex;
      textureRef = tex;
    });

    // Сборка 5 мешей. Первые 4 — shape, последний — textured.
    for (let i = 0; i < 5; i++) {
      const baseGeom = baseGeometries[i];
      const ig = new THREE.InstancedBufferGeometry();
      for (const k in baseGeom.attributes) {
        ig.setAttribute(k, baseGeom.attributes[k]);
      }
      if (baseGeom.index) ig.index = baseGeom.index;

      const isTexture = i === 4;
      const matOpts = {
        uniforms: sharedUniforms,
        vertexShader,
        fragmentShader,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      };
      if (isTexture) {
        matOpts.transparent = true;
        matOpts.defines = { IS_TEXTURE: true };
      }
      const mat = new THREE.ShaderMaterial(matOpts);
      mat.extensions.derivatives = true;

      const mesh = new THREE.Mesh(ig, mat);
      mesh.frustumCulled = false;

      instancedGeometries.push(ig);
      materials.push(mat);

      if (isTexture) {
        texturedMesh = mesh;
        texturedContainer.add(mesh);
      } else {
        shapeMeshes.push(mesh);
        shapedContainer.add(mesh);
      }
    }

    scene.value.add(shapedContainer);
    scene.value.add(texturedContainer);
  }

  // Пересчёт viewport-зависимых параметров FLIP, init flipSim, обновление uniforms,
  // сборка instanced-атрибутов на свежевыделенные массивы flipSim.
  function reInitTank() {
    const vW = size.width;
    const vH = size.height;
    if (vW <= 0 || vH <= 0) return;

    const useTexturedMul = params.useTextured ? 0.4 : 1;
    const numCells = Math.max(2, Math.ceil(fit(vW, 320, 2560, 20, 90) * useTexturedMul));
    const tankW = 2;
    const tankH = (2 * vH) / vW;
    const cellSize = tankW / numCells;
    const density = 1;
    const gravity = Math.ceil(fit(vW, 320, 2560, -15, -3)) * (params.useTextured ? 1.5 : 1);
    const particleR = 0.2 * cellSize;

    const M = Math.max(1, Math.ceil(fit(vW, 320, 2560, 20, 80) * useTexturedMul));
    const S = Math.max(1, Math.ceil((M * vH) / vW));
    const maxParticles = Math.max(SHAPE_COUNT, Math.ceil((M * S) / SHAPE_COUNT) * SHAPE_COUNT);

    state.gravity = gravity;
    state.tankH = tankH;
    state.particleR = particleR;
    state.hasDown = false;

    flipSim.init(density, tankW, tankH, cellSize, particleR, maxParticles);

    // Дефолт эмиттера — центр танка.
    flipSim.emitterPosA.set(1, tankH * 0.5);
    flipSim.emitterPosB.set(1, tankH * 0.5);
    flipSim.isFlushing = false;

    sharedUniforms.u_tankOffset.value.set(flipSim.h, flipSim.h);
    sharedUniforms.u_tankSize.value.set(tankW, tankH);
    sharedUniforms.u_tankActualSize.value.set(flipSim.tankInnerWidth, flipSim.tankInnerHeight);
    sharedUniforms.u_radius.value = particleR;
    sharedUniforms.u_renderScale.value.set(
      vW / tankW,
      ((vW / tankW) * flipSim.tankInnerHeight) / flipSim.tankInnerWidth
    );
    sharedUniforms.u_color.value.setStyle(params.colorHex);
    sharedUniforms.u_opacity.value = params.opacity;

    rebuildInstanceAttributes(maxParticles);
  }

  // particlePosOut/Info пересоздаются на КАЖДОМ flipSim.init() — старые InstancedBufferAttribute
  // указывают на освобождённые буферы. Пересобираем все атрибуты на новые массивы.
  function rebuildInstanceAttributes(maxParticles) {
    const perShape = maxParticles / SHAPE_COUNT; // делится без остатка по конструкции

    // 4 shape-меша: split общего буфера через subarray (упрощённый эквивалент
    // InstancedInterleavedBuffer-подхода рефа — рендер визуально идентичен).
    for (let s = 0; s < SHAPE_COUNT; s++) {
      const mesh = shapeMeshes[s];
      const start = s * perShape;
      const end = start + perShape;
      const posView = flipSim.particlePosOut.subarray(start * 2, end * 2);
      const infoView = flipSim.particleInfo.subarray(start * 2, end * 2);

      const posAttr = new THREE.InstancedBufferAttribute(posView, 2);
      posAttr.usage = THREE.DynamicDrawUsage;
      mesh.geometry.setAttribute('instancedPos', posAttr);

      const infoAttr = new THREE.InstancedBufferAttribute(infoView, 2);
      infoAttr.usage = THREE.DynamicDrawUsage;
      mesh.geometry.setAttribute('instancedInfo', infoAttr);

      mesh.geometry.instanceCount = perShape;
      mesh.geometry._maxInstanceCount = maxParticles;
    }

    // Textured-меш: читает ВСЕ частицы. Дополнительный атрибут instanceColorShape (rgb + shapeIdx).
    const tposAttr = new THREE.InstancedBufferAttribute(flipSim.particlePosOut, 2);
    tposAttr.usage = THREE.DynamicDrawUsage;
    texturedMesh.geometry.setAttribute('instancedPos', tposAttr);

    const tinfoAttr = new THREE.InstancedBufferAttribute(flipSim.particleInfo, 2);
    tinfoAttr.usage = THREE.DynamicDrawUsage;
    texturedMesh.geometry.setAttribute('instancedInfo', tinfoAttr);

    // Селектор: первые 5 цветов берутся напрямую, остальные 40 индексов из 45 циклятся
    // по 4 серым (5..8). Итог: ≈11% ярких / 89% серых.
    // Shape-индекс ~~(i/23) % 23 — каждые 23 частицы новый блок, после 23 блоков (=529) циклит.
    const colorShape = new Float32Array(maxParticles * 4);
    for (let i = 0; i < maxParticles; i++) {
      let j = i % 45;
      j = j < 5 ? j : 5 + ((j - 5) % 4);
      const c = COLORS[j];
      colorShape[i * 4 + 0] = c.r;
      colorShape[i * 4 + 1] = c.g;
      colorShape[i * 4 + 2] = c.b;
      colorShape[i * 4 + 3] = Math.floor(i / 23) % 23;
    }
    texturedMesh.geometry.setAttribute('instanceColorShape', new THREE.InstancedBufferAttribute(colorShape, 4));

    texturedMesh.geometry.instanceCount = maxParticles;
    texturedMesh.geometry._maxInstanceCount = maxParticles;
  }

  function onPointerEnter() {
    pointerInside = true;
  }
  function onPointerLeave() {
    pointerInside = false;
    isDown = false;
  }
  // pointerenter не сработает, если курсор уже был над canvas в момент mount —
  // подстраховка: первый pointermove тоже включает «inside».
  function onPointerMoveLocal() {
    pointerInside = true;
  }
  function onPointerDown() {
    isDown = true;
  }
  function onPointerUp() {
    isDown = false;
  }

  function setupGUI() {
    gui = new GUI({ title: 'Confetti Pool (FLIP)' });

    const fLook = gui.addFolder('Внешний вид');
    fLook
      .add(params, 'useTextured')
      .name('текстурный режим')
      .onChange(() => reInitTank());
    fLook
      .addColor(params, 'colorHex')
      .name('цвет (shapes)')
      .onChange((v) => sharedUniforms.u_color.value.setStyle(v));
    fLook
      .add(params, 'opacity', 0, 1, 0.01)
      .name('opacity')
      .onChange((v) => (sharedUniforms.u_opacity.value = v));

    const fPhys = gui.addFolder('Физика (FLIP/PIC)');
    fPhys.add(params, 'flipRatio', 0, 1, 0.01).name('PIC↔FLIP');
    fPhys.add(params, 'pressureIters', 1, 120, 1).name('итер. давления');
    fPhys.add(params, 'particleIters', 1, 8, 1).name('итер. сепарации');
    fPhys.add(params, 'overRelaxation', 1, 1.95, 0.01).name('SOR');
    fPhys.add(params, 'compensateDrift').name('компенс. дрейфа');

    const actions = {
      restart: () => window.dispatchEvent(new CustomEvent('effect-restart')),
    };
    gui.add(actions, 'restart').name('перезапуск');

    // Все папки свёрнуты по умолчанию.
    gui.folders.forEach((f) => f.close());
  }

  onMounted(() => {
    setupCamera();
    preInit();
    reInitTank();
    setupGUI();

    canvas.value.addEventListener('pointerenter', onPointerEnter);
    canvas.value.addEventListener('pointerleave', onPointerLeave);
    canvas.value.addEventListener('pointermove', onPointerMoveLocal);
    canvas.value.addEventListener('pointerdown', onPointerDown);
    canvas.value.addEventListener('pointerup', onPointerUp);

    onResize(() => {
      setupCamera();
      reInitTank();
    });

    onTick((dt) => {
      if (!flipSim.hasInitialized) return;

      // Toggle visibility (useTextured GUI-параметр).
      shapedContainer.visible = !params.useTextured;
      texturedContainer.visible = params.useTextured;

      // Цвет/opacity uniforms могут меняться через GUI — апдейтим каждый кадр.
      sharedUniforms.u_color.value.setStyle(params.colorHex);
      sharedUniforms.u_opacity.value = params.opacity;

      dt = Math.max(MIN_DT, dt);

      const vW = size.width;
      const vH = size.height;
      curMousePxX = mouse.x * vW;
      // useScene.mouse имеет bottom-left origin; canvasPxToTank ожидает bottom-up Y.
      curMousePxY = mouse.y * vH;

      const prev = canvasPxToTank(prevMousePxX, prevMousePxY);
      const cur = canvasPxToTank(curMousePxX, curMousePxY);

      let cursorX = cur.x;
      let cursorY = cur.y;
      const cursorVx = (cur.x - prev.x) / dt;
      const cursorVy = (cur.y - prev.y) / dt;
      const speed = Math.sqrt(cursorVx * cursorVx + cursorVy * cursorVy);
      // cursorR в норм. ед.: (150/vW) — масштаб «150 px», fit добавляет зависимость от скорости.
      let cursorR = (150 / vW) * fit(speed, 0, 2, 0.2, 1);

      if (!pointerInside) {
        cursorX = -1e3;
        cursorY = -1e3;
        cursorR = 0;
      }

      // Fountain mode: при isDown курсор «уходит за пределы» (нет obstacle), эмиттер
      // на курсоре, частицы исходят из-под мыши и вылетают через дно (isFlushing=true).
      if (isDown && pointerInside) {
        cursorX = -1e3;
        cursorY = -1e3;
        state.hasDown = true;
        flipSim.isFlushing = true;
        flipSim.emitterPosA.copy(prev);
        flipSim.emitterPosB.copy(cur);
      } else {
        if (!state.hasDown) {
          flipSim.emitterPosA.set(1, state.tankH * 0.5);
          flipSim.emitterPosB.set(1, state.tankH * 0.5);
        }
        flipSim.isFlushing = false;
      }

      flipSim.simulate(
        dt,
        state.gravity,
        params.flipRatio,
        params.pressureIters,
        params.particleIters,
        params.overRelaxation,
        params.compensateDrift,
        true,
        cursorX,
        cursorY,
        cursorR,
        cursorVx,
        cursorVy
      );

      // Subarray-views шарят underlying buffer с flipSim.particlePosOut/Info,
      // достаточно отметить needsUpdate для аплоада на GPU.
      for (const mesh of shapeMeshes) {
        mesh.geometry.attributes.instancedPos.needsUpdate = true;
        mesh.geometry.attributes.instancedInfo.needsUpdate = true;
      }
      texturedMesh.geometry.attributes.instancedPos.needsUpdate = true;
      texturedMesh.geometry.attributes.instancedInfo.needsUpdate = true;

      prevMousePxX = curMousePxX;
      prevMousePxY = curMousePxY;
    });
  });

  onBeforeUnmount(() => {
    gui?.destroy();
    if (canvas.value) {
      canvas.value.removeEventListener('pointerenter', onPointerEnter);
      canvas.value.removeEventListener('pointerleave', onPointerLeave);
      canvas.value.removeEventListener('pointermove', onPointerMoveLocal);
      canvas.value.removeEventListener('pointerdown', onPointerDown);
      canvas.value.removeEventListener('pointerup', onPointerUp);
    }
    for (const m of shapeMeshes) shapedContainer.remove(m);
    if (texturedMesh) texturedContainer.remove(texturedMesh);
    scene.value?.remove(shapedContainer);
    scene.value?.remove(texturedContainer);
    for (const g of instancedGeometries) g.dispose();
    for (const g of baseGeometries) g.dispose();
    for (const m of materials) m.dispose();
    textureRef?.dispose();
  });
</script>

<style lang="scss" scoped>
  .confetti-pool {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
