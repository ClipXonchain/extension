/*
 * ClipX QR — compact QR Code generator (byte mode, ECC-M, versions 1–10).
 * Adapted from Project Nayuki's QR Code Generator (MIT License).
 * https://github.com/nayuki/QR-Code-generator
 *
 * Exposes window.ClipxQR with:
 *   ClipxQR.encode(text)            -> { size, modules:Array<Array<boolean>> }
 *   ClipxQR.toSvg(text, {scale,margin,dark,light}) -> SVG string
 *   ClipxQR.renderInto(el, text, opts)             -> SVGElement
 */
(function () {
    "use strict";

    const ECC_CODEWORDS_PER_BLOCK_M = [
        // version 1..10
        10, 16, 26, 18, 24, 16, 18, 22, 22, 26
    ];
    const NUM_ERROR_CORRECTION_BLOCKS_M = [
        1, 1, 1, 2, 2, 4, 4, 4, 5, 5
    ];
    const TOTAL_CODEWORDS = [
        // total data + ecc codewords per version (1..10)
        26, 44, 70, 100, 134, 172, 196, 242, 292, 346
    ];

    function getNumDataCodewords(ver) {
        const total = TOTAL_CODEWORDS[ver - 1];
        const eccPerBlock = ECC_CODEWORDS_PER_BLOCK_M[ver - 1];
        const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[ver - 1];
        return total - eccPerBlock * numBlocks;
    }

    function getByteModeCapacity(ver) {
        const dataBits = getNumDataCodewords(ver) * 8;
        const charCountBits = ver < 10 ? 8 : 16;
        const headerBits = 4 + charCountBits;
        return Math.floor((dataBits - headerBits) / 8);
    }

    function pickVersion(byteLen) {
        for (let v = 1; v <= 10; v++) {
            if (byteLen <= getByteModeCapacity(v)) return v;
        }
        throw new Error("Data too long for compact QR (max ~106 bytes).");
    }

    function utf8Bytes(str) {
        const out = [];
        for (let i = 0; i < str.length; i++) {
            let c = str.charCodeAt(i);
            if (c < 0x80) {
                out.push(c);
            } else if (c < 0x800) {
                out.push(0xc0 | (c >> 6));
                out.push(0x80 | (c & 0x3f));
            } else if (c < 0xd800 || c >= 0xe000) {
                out.push(0xe0 | (c >> 12));
                out.push(0x80 | ((c >> 6) & 0x3f));
                out.push(0x80 | (c & 0x3f));
            } else {
                i++;
                c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
                out.push(0xf0 | (c >> 18));
                out.push(0x80 | ((c >> 12) & 0x3f));
                out.push(0x80 | ((c >> 6) & 0x3f));
                out.push(0x80 | (c & 0x3f));
            }
        }
        return out;
    }

    function buildBitStream(bytes, ver) {
        const dataCw = getNumDataCodewords(ver);
        const totalBits = dataCw * 8;
        const charCountBits = ver < 10 ? 8 : 16;
        const buf = [];
        const push = (val, len) => {
            for (let i = len - 1; i >= 0; i--) buf.push((val >> i) & 1);
        };
        push(4, 4);
        push(bytes.length, charCountBits);
        for (const b of bytes) push(b, 8);
        const term = Math.min(4, totalBits - buf.length);
        for (let i = 0; i < term; i++) buf.push(0);
        while (buf.length % 8 !== 0) buf.push(0);
        const codewords = [];
        for (let i = 0; i < buf.length; i += 8) {
            let v = 0;
            for (let j = 0; j < 8; j++) v = (v << 1) | buf[i + j];
            codewords.push(v);
        }
        const padBytes = [0xec, 0x11];
        let pad = 0;
        while (codewords.length < dataCw) {
            codewords.push(padBytes[pad % 2]);
            pad++;
        }
        return codewords;
    }

    function gfMul(a, b) {
        let z = 0;
        for (let i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11d);
            z ^= ((b >>> i) & 1) * a;
        }
        return z & 0xff;
    }

    function reedSolomonGenerator(degree) {
        const result = new Array(degree).fill(0);
        result[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < degree; j++) {
                result[j] = gfMul(result[j], root);
                if (j + 1 < degree) result[j] ^= result[j + 1];
            }
            root = gfMul(root, 2);
        }
        return result;
    }

    function reedSolomonRemainder(data, generator) {
        const result = new Array(generator.length).fill(0);
        for (const b of data) {
            const factor = b ^ result.shift();
            result.push(0);
            for (let i = 0; i < generator.length; i++) {
                result[i] ^= gfMul(generator[i], factor);
            }
        }
        return result;
    }

    function buildCodewordsAndEcc(dataCw, ver) {
        const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[ver - 1];
        const eccLen = ECC_CODEWORDS_PER_BLOCK_M[ver - 1];
        const total = TOTAL_CODEWORDS[ver - 1];
        const totalDataCw = total - eccLen * numBlocks;
        const numShortBlocks = numBlocks - (totalDataCw % numBlocks);
        const shortLen = Math.floor(totalDataCw / numBlocks);
        const generator = reedSolomonGenerator(eccLen);

        const blocks = [];
        let k = 0;
        for (let i = 0; i < numBlocks; i++) {
            const len = shortLen + (i < numShortBlocks ? 0 : 1);
            const dat = dataCw.slice(k, k + len);
            k += len;
            const ecc = reedSolomonRemainder(dat, generator);
            blocks.push({ dat, ecc });
        }

        const result = [];
        const maxData = shortLen + 1;
        for (let i = 0; i < maxData; i++) {
            for (let b = 0; b < numBlocks; b++) {
                if (i !== shortLen || b >= numShortBlocks) {
                    result.push(blocks[b].dat[i]);
                }
            }
        }
        for (let i = 0; i < eccLen; i++) {
            for (let b = 0; b < numBlocks; b++) {
                result.push(blocks[b].ecc[i]);
            }
        }
        return result;
    }

    // Indexed by version - 1 (versions 1..10).
    const ALIGN_PATTERN_POSITIONS = [
        [],            // v1
        [6, 18],       // v2
        [6, 22],       // v3
        [6, 26],       // v4
        [6, 30],       // v5
        [6, 34],       // v6
        [6, 22, 38],   // v7
        [6, 24, 42],   // v8
        [6, 26, 46],   // v9
        [6, 28, 50]    // v10
    ];

    function buildMatrix(ver, allCodewords) {
        const size = ver * 4 + 17;
        const modules = [];
        const isFn = [];
        for (let i = 0; i < size; i++) {
            modules.push(new Array(size).fill(false));
            isFn.push(new Array(size).fill(false));
        }
        const setFn = (x, y, val) => {
            modules[y][x] = val;
            isFn[y][x] = true;
        };
        const drawFinder = (x, y) => {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const xx = x + dx;
                    const yy = y + dy;
                    if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    setFn(xx, yy, dist !== 2 && dist !== 4);
                }
            }
        };
        drawFinder(3, 3);
        drawFinder(size - 4, 3);
        drawFinder(3, size - 4);

        // Timing patterns: only between the finder patterns, never inside them.
        for (let i = 8; i < size - 8; i++) {
            setFn(6, i, i % 2 === 0);
            setFn(i, 6, i % 2 === 0);
        }

        const aligns = ALIGN_PATTERN_POSITIONS[ver - 1];
        for (const cy of aligns) {
            for (const cx of aligns) {
                if ((cx === 6 && cy === 6) ||
                    (cx === 6 && cy === size - 7) ||
                    (cx === size - 7 && cy === 6)) continue;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const dist = Math.max(Math.abs(dx), Math.abs(dy));
                        setFn(cx + dx, cy + dy, dist !== 1);
                    }
                }
            }
        }

        const reserveFormat = () => {
            for (let i = 0; i < 9; i++) {
                if (i !== 6) setFn(8, i, false);
                if (i !== 6) setFn(i, 8, false);
            }
            for (let i = 0; i < 8; i++) {
                setFn(8, size - 1 - i, false);
                setFn(size - 1 - i, 8, false);
            }
            setFn(8, size - 8, true);
        };
        reserveFormat();

        let bitIdx = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let v = 0; v < size; v++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - v : v;
                    if (!isFn[y][x] && bitIdx < allCodewords.length * 8) {
                        const byte = allCodewords[bitIdx >> 3];
                        modules[y][x] = ((byte >> (7 - (bitIdx & 7))) & 1) !== 0;
                        bitIdx++;
                    }
                }
            }
        }

        const applyMask = (mask) => {
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    if (isFn[y][x]) continue;
                    let invert;
                    switch (mask) {
                        case 0: invert = (x + y) % 2 === 0; break;
                        case 1: invert = y % 2 === 0; break;
                        case 2: invert = x % 3 === 0; break;
                        case 3: invert = (x + y) % 3 === 0; break;
                        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                        case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
                        case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
                        case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
                    }
                    if (invert) modules[y][x] = !modules[y][x];
                }
            }
        };

        const score = () => {
            let s = 0;
            for (let y = 0; y < size; y++) {
                let run = 1;
                for (let x = 1; x < size; x++) {
                    if (modules[y][x] === modules[y][x - 1]) {
                        run++;
                        if (run === 5) s += 3;
                        else if (run > 5) s++;
                    } else run = 1;
                }
            }
            for (let x = 0; x < size; x++) {
                let run = 1;
                for (let y = 1; y < size; y++) {
                    if (modules[y][x] === modules[y - 1][x]) {
                        run++;
                        if (run === 5) s += 3;
                        else if (run > 5) s++;
                    } else run = 1;
                }
            }
            for (let y = 0; y < size - 1; y++) {
                for (let x = 0; x < size - 1; x++) {
                    const c = modules[y][x];
                    if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) s += 3;
                }
            }
            let dark = 0;
            for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++)
                    if (modules[y][x]) dark++;
            const total = size * size;
            const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
            s += k * 10;
            return s;
        };

        let bestMask = 0;
        let bestScore = Infinity;
        const snapshot = JSON.stringify(modules);
        for (let m = 0; m < 8; m++) {
            applyMask(m);
            drawFormatBits(m);
            const sc = score();
            if (sc < bestScore) { bestScore = sc; bestMask = m; }
            // restore
            const restored = JSON.parse(snapshot);
            for (let y = 0; y < size; y++) modules[y] = restored[y].slice();
        }
        applyMask(bestMask);
        drawFormatBits(bestMask);

        function drawFormatBits(mask) {
            // EC level M = 0b00, mask is 3 bits.
            const ecBits = 0;
            const data = (ecBits << 3) | mask;
            let rem = data;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = ((data << 10) | rem) ^ 0x5412;
            const get = (i) => ((bits >>> i) & 1) !== 0;

            // First copy (around top-left finder). Note modules is [y][x] = [row][col].
            // Bits 0..5 -> col 8, rows 0..5
            for (let i = 0; i <= 5; i++) modules[i][8] = get(i);
            // Bit 6 -> col 8, row 7 (skip timing row 6)
            modules[7][8] = get(6);
            // Bit 7 -> col 8, row 8
            modules[8][8] = get(7);
            // Bit 8 -> col 7, row 8
            modules[8][7] = get(8);
            // Bits 9..14 -> row 8, cols 5..0 (skip timing col 6)
            for (let i = 9; i < 15; i++) modules[8][14 - i] = get(i);

            // Second copy.
            // Bits 0..7 -> row 8, cols size-1..size-8 (top-right horizontal, right -> left)
            for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = get(i);
            // Bits 8..14 -> col 8, rows size-7..size-1 (bottom-left vertical, top -> bottom)
            for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = get(i);

            // Always-dark module.
            modules[size - 8][8] = true;
        }

        return { size, modules };
    }

    function encode(text) {
        const bytes = utf8Bytes(text);
        const ver = pickVersion(bytes.length);
        const dataCw = buildBitStream(bytes, ver);
        const all = buildCodewordsAndEcc(dataCw, ver);
        return buildMatrix(ver, all);
    }

    function toSvg(text, opts) {
        opts = opts || {};
        const scale = opts.scale || 4;
        const margin = opts.margin == null ? 2 : opts.margin;
        const dark = opts.dark || "#000";
        const light = opts.light || "transparent";
        const { size, modules } = encode(text);
        const dim = (size + margin * 2) * scale;
        const parts = [];
        parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" width="${dim}" height="${dim}">`);
        parts.push(`<rect width="100%" height="100%" fill="${light}"/>`);
        let path = "";
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (modules[y][x]) {
                    const px = (x + margin) * scale;
                    const py = (y + margin) * scale;
                    path += `M${px},${py}h${scale}v${scale}h-${scale}z `;
                }
            }
        }
        parts.push(`<path fill="${dark}" d="${path}"/>`);
        parts.push(`</svg>`);
        return parts.join("");
    }

    function renderInto(el, text, opts) {
        if (!el) return null;
        el.innerHTML = toSvg(text, opts);
        return el.firstChild;
    }

    window.ClipxQR = { encode, toSvg, renderInto };
})();
