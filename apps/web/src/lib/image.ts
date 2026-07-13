/**
 * Resize an image File to a fixed square and return a PNG data URI.
 *
 * The logo is drawn "contain" — its aspect ratio is kept and it's centred on a
 * transparent square — so any upload lines up perfectly with the fixed avatar
 * slot in the sidebar without distortion. Output is a self-contained data URI,
 * so it stores straight in Organization.logo and renders anywhere with no
 * separate file hosting, auth, or signed-URL expiry to worry about.
 */
export async function resizeImageToSquareDataUrl(file: File, size = 128): Promise<string> {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(sourceDataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not supported in this browser');

  ctx.clearRect(0, 0, size, size);

  // Some SVGs report no intrinsic size — fall back to filling the square.
  const iw = img.naturalWidth || img.width || size;
  const ih = img.naturalHeight || img.height || size;
  const scale = Math.min(size / iw, size / ih);
  const w = Math.round(iw * scale);
  const h = Math.round(ih * scale);
  ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

  return canvas.toDataURL('image/png');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be read as an image'));
    img.src = src;
  });
}
