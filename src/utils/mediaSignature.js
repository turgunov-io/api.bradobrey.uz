// Detects an uploaded image/video type from its leading bytes, so the stored
// extension never depends on the client-supplied Content-Type.
//   (callers: routers/marketplace/banner.js)
// Returns a MIME type from the supported set, or null.

const startsWith = (buffer, bytes, offset = 0) => (
  buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte)
);

const ascii = (text) => [...Buffer.from(text, 'latin1')];

// ISO BMFF brands (bytes 8-11 after "ftyp").
const QUICKTIME_BRANDS = new Set(['qt  ']);

function detectMediaType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, ascii('GIF87a')) || startsWith(buffer, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(buffer, ascii('RIFF')) && startsWith(buffer, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';

  if (startsWith(buffer, ascii('ftyp'), 4) && buffer.length >= 12) {
    const brand = buffer.toString('latin1', 8, 12);
    return QUICKTIME_BRANDS.has(brand) ? 'video/quicktime' : 'video/mp4';
  }

  return null;
}

module.exports = { detectMediaType };
