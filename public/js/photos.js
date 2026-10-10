// Сжатие фотографий в браузере перед загрузкой:
// основная — до 1400 px по длинной стороне, миниатюра — 360 px.
// Обычное фото с телефона (4–8 МБ) превращается в ~200 КБ + ~25 КБ,
// так что в бесплатный 1 ГБ хранилища помещается 4–5 тысяч снимков.

const FULL_MAX = 1400;
const THUMB_MAX = 360;

export async function processImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Это не изображение');
  const img = await loadImage(file);
  const full = await resize(img, FULL_MAX, 0.82);
  const thumb = await resize(img, THUMB_MAX, 0.8, true);
  return { full, thumb, width: img.naturalWidth, height: img.naturalHeight };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось открыть изображение. Если это HEIC с iPhone — сохраните фото как JPG.'));
    };
    img.src = url;
  });
}

// square=true — квадратная миниатюра по центру (для кружков на карточках)
function resize(img, max, quality, square = false) {
  let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2;
    // для портретов берём чуть выше центра — там обычно лицо
    sy = sh > sw ? Math.max(0, (sh - side) * 0.3) : (sh - side) / 2;
    sw = sh = side;
  }
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Не удалось сжать изображение'))), 'image/jpeg', quality);
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
