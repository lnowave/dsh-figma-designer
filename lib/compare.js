/**
 * Self-contained direction comparison page for Figma screenshots.
 *
 * The page is deliberately a neutral shell: it compares the candidates and
 * gives the user a concrete "choose" action, but adds no visual direction of
 * its own. Pure functions; the Host tool writes the returned files.
 *
 * @module dsh-figma-designer/lib/compare
 */

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const normalizePalette = (value) => {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && /^#[0-9a-f]{3,8}$/i.test(item.trim())).slice(0, 8)
}

const normalizeTraits = (value) => {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0).slice(0, 8)
}

export const compareSlug = (value) => {
  const text = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 32)
  return text || 'candidate'
}

function imageDataUrl(image) {
  if (!image || typeof image.data !== 'string' || image.data.length === 0) return ''
  const mime = image.mimeType || 'image/png'
  return `data:${mime};base64,${image.data}`
}

function candidateCard(candidate, index) {
  const palette = normalizePalette(candidate.palette)
  const traits = normalizeTraits(candidate.traits)
  const swatches = palette.map((color) => `<span class="swatch" style="--c:${escapeHtml(color)}" title="${escapeHtml(color)}"></span>`).join('')
  const traitTags = traits.map((trait) => `<span class="tag">${escapeHtml(trait)}</span>`).join('')
  return `<article class="card" id="candidate-${index + 1}">
  <div class="card-head">
    <span class="index">${String(index + 1).padStart(2, '0')}</span>
    <h2>${escapeHtml(candidate.name || `Candidate ${index + 1}`)}</h2>
    <button type="button" class="choose" data-name="${escapeHtml(candidate.name || `Candidate ${index + 1}`)}" data-index="${index + 1}">选这个</button>
  </div>
  ${candidate.concept ? `<p class="concept">${escapeHtml(candidate.concept)}</p>` : ''}
  <a class="shot" href="#candidate-${index + 1}" data-shot="shot-${index}" aria-label="查看 ${escapeHtml(candidate.name || `Candidate ${index + 1}`)}">
    <img id="shot-${index}" src="${imageDataUrl(candidate.image)}" alt="${escapeHtml(candidate.name || `Candidate ${index + 1}`)}" width="${candidate.width || ''}" height="${candidate.height || ''}" loading="lazy" />
  </a>
  <div class="card-actions">
    <button type="button" class="actual" data-shot="shot-${index}">实际尺寸</button>
    <span class="meta">${candidate.width || '?'} × ${candidate.height || '?'} px</span>
  </div>
  ${swatches || traitTags ? `<div class="meta-row">${swatches ? `<div class="palette">${swatches}</div>` : ''}${traitTags ? `<div class="traits">${traitTags}</div>` : ''}</div>` : ''}
</article>`
}

/**
 * Build a neutral, self-contained compare page plus a manifest.
 * @param {object} input
 * @param {string} [input.title]
 * @param {Array<{nodeId:string,name?:string,concept?:string,palette?:string[],traits?:string[],image?:object,width?:number,height?:number,imageFile?:string}>} input.candidates
 * @param {string} [input.file]
 * @param {string} [input.page]
 * @param {string} [input.generatedAt]
 */
export function buildComparePage(input = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 6) : []
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '设计方向对比'
  const generatedAt = typeof input.generatedAt === 'string' ? input.generatedAt : new Date().toISOString()
  const cards = candidates.map(candidateCard).join('\n')
  const manifest = {
    title,
    generatedAt,
    file: input.file || null,
    page: input.page || null,
    candidates: candidates.map((candidate, index) => ({
      index: index + 1,
      nodeId: candidate.nodeId,
      name: candidate.name || `Candidate ${index + 1}`,
      concept: candidate.concept || null,
      palette: normalizePalette(candidate.palette),
      traits: normalizeTraits(candidate.traits),
      image: candidate.imageFile || null,
      width: candidate.width || null,
      height: candidate.height || null,
    })),
  }
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --surface: #ffffff;
    --text: #15181e;
    --muted: #68707d;
    --border: #dfe3e8;
    --accent: #2563eb;
    --accent-soft: #eef3ff;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; }
  header { max-width: 1480px; margin: 0 auto; padding: 32px 28px 10px; }
  .eyebrow { margin: 0 0 6px; color: var(--muted); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(24px, 3vw, 36px); line-height: 1.2; letter-spacing: -.02em; }
  .sub { margin: 8px 0 0; color: var(--muted); }
  .source { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
  main { max-width: 1480px; margin: 0 auto; padding: 18px 28px 56px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px; align-items: start; }
  .card { min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
  .card-head { display: flex; align-items: center; gap: 8px; min-height: 34px; }
  .index { color: var(--muted); font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h2 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 15px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .choose { flex: 0 0 auto; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 8px; padding: 6px 9px; font: inherit; font-size: 12px; cursor: pointer; }
  .choose:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .concept { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
  .shot { display: flex; justify-content: center; align-items: flex-start; margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #fafbfc; }
  .shot img { display: block; width: auto; max-width: 100%; height: auto; max-height: 640px; object-fit: contain; object-position: top; background: #fff; }
  .card-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
  .actual { border: 0; background: transparent; color: var(--accent); padding: 4px 0; font: inherit; font-size: 12px; cursor: pointer; }
  .meta { color: var(--muted); font-size: 12px; }
  .meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }
  .palette { display: flex; gap: 4px; }
  .swatch { width: 18px; height: 18px; border-radius: 5px; border: 1px solid rgba(0,0,0,.08); background: var(--c); }
  .traits { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 11px; }
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(10px); opacity: 0; background: #15181e; color: #fff; border-radius: 8px; padding: 8px 12px; font-size: 12px; pointer-events: none; transition: .16s ease; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  footer { max-width: 1480px; margin: 0 auto; padding: 0 28px 40px; color: var(--muted); font-size: 12px; }
  @media (max-width: 720px) { header, main, footer { padding-left: 16px; padding-right: 16px; } .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <p class="eyebrow">Design directions</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">并排看构图、层级、字体和色彩；点“选这个”复制选择，再回到对话里确认。</p>
  <p class="source">${escapeHtml(input.file || '')}${input.page ? ` · ${escapeHtml(input.page)}` : ''} · ${escapeHtml(generatedAt)}</p>
</header>
<main>
  <div class="grid">
    ${cards || '<p>没有候选。</p>'}
  </div>
</main>
<footer>候选来自当前 Figma 文件的截图；对比页不写入设计文件。实际尺寸请点每张卡片的“实际尺寸”。</footer>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
  const toast = document.getElementById('toast');
  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
  }
  document.addEventListener('click', async (event) => {
    const choose = event.target.closest('.choose');
    if (choose) {
      const text = '选 ' + String(choose.dataset.index).padStart(2, '0') + ' ' + choose.dataset.name;
      try { await navigator.clipboard.writeText(text); showToast('已复制：' + text); }
      catch { showToast(text); }
      return;
    }
    const actual = event.target.closest('.actual');
    if (actual) {
      const img = document.getElementById(actual.dataset.shot);
      if (!img) return;
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write('<!doctype html><title>' + img.alt + '</title><body style="margin:0;background:#fff"><img src="' + img.src + '" alt="" style="display:block;max-width:none"></body>');
      win.document.close();
    }
  });
</script>
</body>
</html>`
  return { html, manifest }
}
