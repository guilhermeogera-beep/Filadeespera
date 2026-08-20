/* ============================================================
   qr.js — Gerador de QR Code (sem bibliotecas externas)
   Modo BYTE (UTF-8), correção de erro M, versões 1 a 10.
   Suficiente para URLs de até ~213 caracteres.

   Uso:  QRCode.svg("https://exemplo.com/fila.html?id=123", { margin: 3 })
         -> devolve uma string com o <svg> pronto para colocar na página.
   ============================================================ */
(function (global) {
  "use strict";

  // ---- Tabela das versões (nível de correção M) -------------
  // total = total de codewords | ec = codewords de correção por bloco
  // g1/d1 = nº de blocos e codewords de dados do grupo 1 (idem g2/d2)
  // align = centros dos padrões de alinhamento
  var V = {
    1:  { total: 26,  ec: 10, g1: 1, d1: 16, g2: 0, d2: 0,  align: [] },
    2:  { total: 44,  ec: 16, g1: 1, d1: 28, g2: 0, d2: 0,  align: [6, 18] },
    3:  { total: 70,  ec: 26, g1: 1, d1: 44, g2: 0, d2: 0,  align: [6, 22] },
    4:  { total: 100, ec: 18, g1: 2, d1: 32, g2: 0, d2: 0,  align: [6, 26] },
    5:  { total: 134, ec: 24, g1: 2, d1: 43, g2: 0, d2: 0,  align: [6, 30] },
    6:  { total: 172, ec: 16, g1: 4, d1: 27, g2: 0, d2: 0,  align: [6, 34] },
    7:  { total: 196, ec: 18, g1: 4, d1: 31, g2: 0, d2: 0,  align: [6, 22, 38] },
    8:  { total: 242, ec: 22, g1: 2, d1: 38, g2: 2, d2: 39, align: [6, 24, 42] },
    9:  { total: 292, ec: 22, g1: 3, d1: 36, g2: 2, d2: 37, align: [6, 26, 46] },
    10: { total: 346, ec: 26, g1: 4, d1: 43, g2: 1, d2: 44, align: [6, 28, 50] }
  };
  var EC_M_BITS = 0; // indicador do nível M na informação de formato (L=1, M=0, Q=3, H=2)

  // ---- Aritmética no campo de Galois GF(256) ----------------
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;      // polinômio primitivo do padrão QR
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Polinômio gerador para "n" codewords de correção
  function genPoly(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], 1);              // termo x
        next[j + 1] ^= gfMul(poly[j], EXP[i]);     // termo alfa^i
      }
      poly = next;
    }
    return poly;
  }

  // Reed–Solomon: devolve os codewords de correção de um bloco
  function rsEncode(data, ecLen) {
    var gen = genPoly(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
    }
    return res;
  }

  // ---- Texto -> bytes UTF-8 ---------------------------------
  function toUtf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  // ---- Monta os codewords (dados + correção, intercalados) --
  function buildCodewords(bytes, ver) {
    var v = V[ver];
    var dataCw = v.g1 * v.d1 + v.g2 * v.d2;
    var lenBits = ver < 10 ? 8 : 16;

    // fluxo de bits: modo(0100) + tamanho + dados + terminador
    var bits = [];
    function push(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    push(4, 4);
    push(bytes.length, lenBits);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var cap = dataCw * 8;
    for (var t = 0; t < 4 && bits.length < cap; t++) bits.push(0);   // terminador
    while (bits.length % 8 !== 0) bits.push(0);                       // completa o byte

    var cw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      cw.push(byte);
    }
    var pad = [0xec, 0x11], p = 0;
    while (cw.length < dataCw) cw.push(pad[p++ % 2]);                 // preenchimento padrão

    // divide em blocos e calcula a correção de cada um
    var blocks = [], ecBlocks = [], pos = 0;
    for (var g = 0; g < v.g1; g++) { blocks.push(cw.slice(pos, pos + v.d1)); pos += v.d1; }
    for (var h = 0; h < v.g2; h++) { blocks.push(cw.slice(pos, pos + v.d2)); pos += v.d2; }
    for (var n = 0; n < blocks.length; n++) ecBlocks.push(rsEncode(blocks[n], v.ec));

    // intercala: 1º byte de cada bloco, 2º byte de cada bloco...
    var out = [], maxD = Math.max(v.d1, v.d2);
    for (var c = 0; c < maxD; c++)
      for (var bi = 0; bi < blocks.length; bi++)
        if (c < blocks[bi].length) out.push(blocks[bi][c]);
    for (var e = 0; e < v.ec; e++)
      for (var bj = 0; bj < ecBlocks.length; bj++) out.push(ecBlocks[bj][e]);

    return out;
  }

  // ---- Desenho da matriz ------------------------------------
  function newGrid(size, val) {
    var g = new Array(size);
    for (var y = 0; y < size; y++) g[y] = new Array(size).fill(val);
    return g;
  }

  function drawFunctions(m, res, size, ver) {
    // padrões localizadores (3 cantos) + separadores
    var corners = [[0, 0], [size - 7, 0], [0, size - 7]];
    corners.forEach(function (c) {
      var cx = c[0], cy = c[1];
      for (var y = -1; y <= 7; y++) {
        for (var x = -1; x <= 7; x++) {
          var px = cx + x, py = cy + y;
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          var inner = (x >= 0 && x <= 6 && y >= 0 && y <= 6);
          var dark = inner && (x === 0 || x === 6 || y === 0 || y === 6 ||
                     (x >= 2 && x <= 4 && y >= 2 && y <= 4));
          m[py][px] = dark ? 1 : 0;
          res[py][px] = 1;
        }
      }
    });

    // linhas de sincronismo (linha 6 e coluna 6)
    for (var i = 8; i < size - 8; i++) {
      var on = (i % 2 === 0) ? 1 : 0;
      m[6][i] = on; res[6][i] = 1;
      m[i][6] = on; res[i][6] = 1;
    }

    // padrões de alinhamento
    var al = V[ver].align;
    for (var a = 0; a < al.length; a++) {
      for (var b = 0; b < al.length; b++) {
        var ax = al[a], ay = al[b];
        // pula os cantos ocupados pelos localizadores
        if ((ax <= 8 && ay <= 8) || (ax <= 8 && ay >= size - 9) || (ax >= size - 9 && ay <= 8)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var mx = Math.max(Math.abs(dx), Math.abs(dy));
            m[ay + dy][ax + dx] = (mx !== 1) ? 1 : 0;
            res[ay + dy][ax + dx] = 1;
          }
        }
      }
    }

    // reserva a área da informação de formato
    for (var f = 0; f < 9; f++) {
      if (f !== 6) { res[8][f] = 1; res[f][8] = 1; }
    }
    res[8][6] = 1; res[6][8] = 1;
    for (var s = 0; s < 8; s++) { res[8][size - 1 - s] = 1; res[size - 1 - s][8] = 1; }
    m[size - 8][8] = 1; res[size - 8][8] = 1;   // módulo sempre escuro

    // informação de versão (só da versão 7 em diante)
    if (ver >= 7) {
      var rem = ver;
      for (var r = 0; r < 12; r++) rem = ((rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25)) & 0x1fff;
      var vbits = (ver << 12) | rem;
      for (var k = 0; k < 18; k++) {
        var bit = (vbits >> k) & 1;
        var x1 = Math.floor(k / 3), y1 = size - 11 + (k % 3);
        m[y1][x1] = bit; res[y1][x1] = 1;
        m[x1][y1] = bit; res[x1][y1] = 1;
      }
    }
  }

  function drawFormat(m, res, size, mask) {
    var data = (EC_M_BITS << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = ((rem << 1) ^ (((rem >>> 9) & 1) * 0x537)) & 0x7ff;
    var bits = ((data << 10) | rem) ^ 0x5412;
    function bit(n) { return (bits >> n) & 1; }

    // 1ª cópia: bits 0..7 descem a coluna 8; bits 8..14 seguem a linha 8 para a esquerda
    for (var j = 0; j <= 5; j++) m[j][8] = bit(j);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (var k = 9; k <= 14; k++) m[8][14 - k] = bit(k);

    // 2ª cópia: bits 0..7 na linha 8 (da direita para o centro); bits 8..14 na coluna 8 (em baixo)
    for (var p = 0; p <= 7; p++) m[8][size - 1 - p] = bit(p);
    for (var q = 8; q <= 14; q++) m[size - 15 + q][8] = bit(q);
    m[size - 8][8] = 1;
  }

  function placeData(m, res, size, cw) {
    var idx = 0, total = cw.length * 8;
    function next() {
      if (idx >= total) return 0;
      var b = (cw[idx >> 3] >> (7 - (idx & 7))) & 1;
      idx++;
      return b;
    }
    var up = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                 // salta a coluna de sincronismo
      for (var v = 0; v < size; v++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var y = up ? (size - 1 - v) : v;
          if (res[y][x]) continue;
          m[y][x] = next();
        }
      }
      up = !up;
    }
  }

  function maskFn(k, x, y) {
    switch (k) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2 + (x * y) % 3) === 0;
      case 6: return (((x * y) % 2 + (x * y) % 3) % 2) === 0;
      default: return (((x + y) % 2 + (x * y) % 3) % 2) === 0;
    }
  }

  function applyMask(m, res, size, k) {
    for (var y = 0; y < size; y++)
      for (var x = 0; x < size; x++)
        if (!res[y][x] && maskFn(k, x, y)) m[y][x] ^= 1;
  }

  // Penalidade (regras 1 a 4 do padrão) — escolhe a melhor máscara
  function penalty(m, size) {
    var score = 0, x, y, i;

    // regra 1: sequências de 5+ módulos iguais (linhas e colunas)
    for (y = 0; y < size; y++) {
      var runR = 1, runC = 1;
      for (x = 1; x < size; x++) {
        runR = (m[y][x] === m[y][x - 1]) ? runR + 1 : 1;
        if (runR === 5) score += 3; else if (runR > 5) score += 1;
        runC = (m[x][y] === m[x - 1][y]) ? runC + 1 : 1;
        if (runC === 5) score += 3; else if (runC > 5) score += 1;
      }
    }

    // regra 2: blocos 2x2 da mesma cor
    for (y = 0; y < size - 1; y++)
      for (x = 0; x < size - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;

    // regra 3: padrão 1:1:3:1:1 com 4 módulos claros de um dos lados
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (var line = 0; line < size; line++) {
      for (var st = 0; st + 11 <= size; st++) {
        var okR1 = true, okR2 = true, okC1 = true, okC2 = true;
        for (i = 0; i < 11; i++) {
          var rv = m[line][st + i], cv = m[st + i][line];
          if (rv !== pat1[i]) okR1 = false;
          if (rv !== pat2[i]) okR2 = false;
          if (cv !== pat1[i]) okC1 = false;
          if (cv !== pat2[i]) okC2 = false;
        }
        if (okR1 || okR2) score += 40;
        if (okC1 || okC2) score += 40;
      }
    }

    // regra 4: proporção de módulos escuros longe de 50%
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) dark += m[y][x];
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  // ---- Geração completa -------------------------------------
  function build(text) {
    var bytes = toUtf8(String(text));
    var ver = 0;
    for (var v = 1; v <= 10; v++) {
      var dataCw = V[v].g1 * V[v].d1 + V[v].g2 * V[v].d2;
      var overhead = (v < 10) ? 2 : 3;               // modo + indicador de tamanho
      if (bytes.length + overhead <= dataCw) { ver = v; break; }
    }
    if (!ver) throw new Error("Texto grande demais para o QR (máx. ~213 caracteres).");

    var size = 17 + 4 * ver;
    var cw = buildCodewords(bytes, ver);

    var best = null;
    for (var k = 0; k < 8; k++) {
      var m = newGrid(size, 0), res = newGrid(size, 0);
      drawFunctions(m, res, size, ver);
      placeData(m, res, size, cw);
      applyMask(m, res, size, k);
      drawFormat(m, res, size, k);
      var s = penalty(m, size);
      if (!best || s < best.score) best = { score: s, m: m };
    }
    return { size: size, modules: best.m, version: ver };
  }

  // ---- Saída em SVG -----------------------------------------
  function svg(text, opts) {
    opts = opts || {};
    var margin = opts.margin == null ? 3 : opts.margin;
    var dark = opts.dark || "#111827";
    var light = opts.light || "#ffffff";
    var q = build(text);
    var dim = q.size + margin * 2;
    var path = "";
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size; x++) {
        if (q.modules[y][x]) path += "M" + (x + margin) + " " + (y + margin) + "h1v1h-1z";
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR Code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/></svg>';
  }

  global.QRCode = { svg: svg, build: build };
})(window);
