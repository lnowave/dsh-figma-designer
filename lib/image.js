/**
 * Minimal image metadata reader for local assets.
 *
 * Figma can place raster images via `figma.createImage`; the Host needs the
 * intrinsic size before creating a frame. This module sniffs PNG/JPEG/GIF
 * headers without adding an image dependency.
 *
 * @module dsh-figma-designer/lib/image
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const matches = (buffer, bytes) => bytes.every((value, index) => buffer[index] === value)

function pngSize(buffer) {
  if (buffer.length < 24) return null
  return {
    mimeType: 'image/png',
    type: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function gifSize(buffer) {
  if (buffer.length < 10) return null
  return {
    mimeType: 'image/gif',
    type: 'gif',
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  }
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        mimeType: 'image/jpeg',
        type: 'jpeg',
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      }
    }
    offset += 2 + length
  }
  return null
}

/**
 * Detect a supported raster image and return its intrinsic size.
 * @param {Buffer} buffer
 * @returns {{mimeType:string,type:string,width:number,height:number}}
 */
export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) throw new Error('不是有效的图片文件')
  let result = null
  if (matches(buffer, PNG_SIGNATURE)) result = pngSize(buffer)
  else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) result = gifSize(buffer)
  else if (buffer[0] === 0xff && buffer[1] === 0xd8) result = jpegSize(buffer)
  if (!result || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0) {
    throw new Error('仅支持 PNG / JPEG / GIF 图片')
  }
  return result
}

/** Suggest a display size while preserving aspect ratio. */
export function fitSize(width, height, maxDimension = 1200) {
  const limit = Math.max(1, Number(maxDimension) || 1200)
  const scale = Math.min(1, limit / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}
