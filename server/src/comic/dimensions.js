// Minimal JPEG/PNG dimension reader. The lettering overlay needs the real
// pixel size of whatever the image model returned, and pulling in a native
// image library for two integers is not worth it on a free instance.

export function imageSize(buffer){
  if(!buffer || buffer.length < 24) return null;

  // PNG: width/height are big-endian ints in the IHDR chunk.
  if(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47){
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk the segment markers to the start-of-frame.
  if(buffer[0] === 0xFF && buffer[1] === 0xD8){
    let offset = 2;
    while(offset < buffer.length - 9){
      if(buffer[offset] !== 0xFF){ offset++; continue; }
      const marker = buffer[offset + 1];
      // SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC.
      if(marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC){
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}
