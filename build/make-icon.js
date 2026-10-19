'use strict';

/**
 * Generates build/icon.png and build/icon.ico for the Shine desktop app.
 *
 * The mark is the word "Shine" in bold text and nothing else - no shape, no
 * spark, no background. Windows ships System.Drawing, so the text is rendered
 * with the OS font stack and the resulting PNGs are packed into an .ico here.
 *
 * Run with: node build/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const FONT_FAMILY = process.env.SHINE_ICON_FONT || 'Segoe UI';
const TEXT = process.env.SHINE_ICON_TEXT || 'Shine';
const COLOUR = process.env.SHINE_ICON_COLOUR || 'White';

/* ---------------------------- PNG ---------------------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Re-encode a BMP produced by System.Drawing as an alpha PNG. */
function bmpToPng(bmpPath, size, outPath) {
  const bmp = fs.readFileSync(bmpPath);
  // BITMAPFILEHEADER is 14 bytes; BITMAPINFOHEADER follows.
  const headerSize = bmp.readUInt32LE(14);
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  const bitCount = bmp.readUInt16LE(28);
  const compression = bmp.readUInt32LE(30);
  if (bitCount !== 32 || compression !== 0) throw new Error(`Expected a 32-bit uncompressed BMP, got ${bitCount}-bit/${compression}`);
  if (width !== size || Math.abs(height) !== size) throw new Error(`Unexpected BMP size ${width}x${height}`);

  const pixelsOffset = 14 + headerSize;
  const rowSize = width * 4;
  const rgba = Buffer.alloc(size * size * 4);

  // BMP scanlines are bottom-up and store pixels as BGRA.
  for (let y = 0; y < size; y += 1) {
    const src = pixelsOffset + (size - 1 - y) * rowSize;
    for (let x = 0; x < size; x += 1) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      rgba[d] = bmp[s + 2];
      rgba[d + 1] = bmp[s + 1];
      rgba[d + 2] = bmp[s];
      rgba[d + 3] = bmp[s + 3];
    }
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', require('node:zlib').deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(outPath, png);
  return png;
}

/* ---------------------------- ICO ---------------------------- */

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;

  pngs.forEach((entry, i) => {
    const b = i * 16;
    dir[b] = entry.size >= 256 ? 0 : entry.size;
    dir[b + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[b + 2] = 0;
    dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(entry.data.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((e) => e.data)]);
}

/* ---------------------------- Rendering ---------------------------- */

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Draw the word centred and scaled to fill the square. Two measuring passes
 * keep the text optically even across icon sizes.
 */
function renderPng(size, outPath) {
  const bmpPath = `${outPath}.bmp`;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$size = ${size}
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

$family  = ${psQuote(FONT_FAMILY)}
$colour  = [System.Drawing.Color]::${COLOUR}
$brush   = New-Object System.Drawing.SolidBrush($colour)
$rect    = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
$format  = New-Object System.Drawing.StringFormat
$format.Alignment     = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$format.FormatFlags   = [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::NoClip

# Fit the word to roughly 86% of the icon width, leaving a little breathing room.
$target = $size * 0.86
$fontSize = [double]$size
for ($i = 0; $i -lt 4; $i++) {
  $font = New-Object System.Drawing.Font($family, [float]$fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $measured = $g.MeasureString(${psQuote(TEXT)}, $font, [System.Drawing.SizeF]::new($size * 8, $size * 8), $format)
  $font.Dispose()
  if ($measured.Width -le 0) { $fontSize = $size * 0.5; break }
  $fontSize = $fontSize * ($target / $measured.Width)
}
if ($fontSize -gt $size) { $fontSize = $size }

$font = New-Object System.Drawing.Font($family, [float]$fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString(${psQuote(TEXT)}, $font, $brush, $rect, $format)
$font.Dispose(); $brush.Dispose(); $format.Dispose(); $g.Dispose()
$bmp.Save(${psQuote(bmpPath)}, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()
`.trim();

  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });

  const png = bmpToPng(bmpPath, size, outPath);
  fs.unlinkSync(bmpPath);
  return png;
}

/* ---------------------------- Main ---------------------------- */

const outDir = __dirname;
fs.mkdirSync(outDir, { recursive: true });

const pngs = SIZES.map((size) => ({ size, data: renderPng(size, path.join(outDir, `icon-${size}.png`)) }));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].data);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(pngs));
for (const size of SIZES) fs.unlinkSync(path.join(outDir, `icon-${size}.png`));

console.log(`Wrote icon.png and icon.ico ("${TEXT}", ${SIZES.join(', ')}px)`);