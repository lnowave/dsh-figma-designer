/**
 * Open-license media search and download.
 *
 * Host-side only: Figma's plugin iframe cannot reach external domains, so the
 * Host searches/downloads and the companion only receives final image bytes.
 * The source list deliberately prefers public-domain/CC0/CC-BY collections.
 *
 * @module dsh-figma-designer/lib/media
 */

const USER_AGENT = 'dsh-figma-designer/0.9 (+https://github.com/lnowave/dsh-figma-designer)'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT = 15000

export const MEDIA_SOURCES = ['all', 'openverse', 'commons', 'met', 'aic', 'cleveland', 'nasa', 'polyhaven']

const PREFIX = { commons: 'C', openverse: 'O', met: 'M', aic: 'A', cleveland: 'K', nasa: 'N', polyhaven: 'T' }

const stripHtml = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim()
const asHttps = (value) => String(value ?? '').replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://')

export function rightsUse(license = '', licenseUrl = '') {
  const text = `${license} ${licenseUrl}`.toLowerCase()
  if (/non-?commercial|by-nc|\bnc\b|no ?deriv|by-nd|\bnd\b|requires licensing/.test(text)) return 'reference'
  if (/third-party rights|not verified|not specified|in copyright|rights not specified/.test(text)) return 'check'
  if (/cc0|publicdomain|public domain|\bpdm?\b|no known restrictions|not subject to us copyright|creativecommons\.org\/licenses\/by(-sa)?\/|\bcc[ -]by(-sa)?\b|attribution( |-sharealike )\d/.test(text)) return 'page'
  return 'check'
}

const jsonFetch = async (url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT) => {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

const imageFetch = async (url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT) => {
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB')
    return { buffer, mimeType: response.headers.get('content-type') || 'application/octet-stream' }
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      try { await reader.cancel() } catch (_ignored) {}
      throw new Error('图片超过 20MB')
    }
    chunks.push(Buffer.from(value))
  }
  return { buffer: Buffer.concat(chunks), mimeType: response.headers.get('content-type') || 'application/octet-stream' }
}

function candidate(provider, data) {
  const license = data.license || 'Unknown'
  const licenseUrl = data.licenseUrl || ''
  return {
    provider,
    source: data.source || provider,
    title: stripHtml(data.title || 'Untitled'),
    detail: stripHtml(data.detail || ''),
    about: stripHtml(data.about || ''),
    license,
    licenseUrl,
    attribution: stripHtml(data.attribution || ''),
    pageUrl: data.pageUrl || '',
    imageUrl: asHttps(data.imageUrl || ''),
    previewUrl: asHttps(data.previewUrl || data.imageUrl || ''),
    width: Number(data.width) || null,
    height: Number(data.height) || null,
    usable: rightsUse(license, licenseUrl),
    ref: null,
  }
}

async function searchOpenverse(query, limit, fetchImpl) {
  const params = new URLSearchParams({
    q: query,
    page_size: String(Math.min(limit * 2, 20)),
    license: 'cc0,pdm,by,by-sa',
    mature: 'false',
  })
  const data = await jsonFetch(`https://api.openverse.org/v1/images/?${params}`, fetchImpl)
  return (data.results || []).flatMap((item) => {
    if (!item.url) return []
    const license = item.license ? `CC ${String(item.license).toUpperCase()}${item.license_version ? ` ${item.license_version}` : ''}` : 'Unknown'
    return [candidate('openverse', {
      title: item.title,
      detail: [item.creator, item.source].filter(Boolean).join(' · '),
      license,
      licenseUrl: item.license_url,
      attribution: [item.creator, item.source].filter(Boolean).join(' · ') || 'Openverse',
      pageUrl: item.foreign_landing_url,
      imageUrl: item.url,
      previewUrl: item.thumbnail,
      width: item.width,
      height: item.height,
    })]
  }).slice(0, limit)
}

async function searchCommons(query, limit, fetchImpl) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', generator: 'search',
    gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(Math.min(limit * 3, 30)),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600',
    iiextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|ObjectName|ImageDescription|AttributionRequired',
  })
  const data = await jsonFetch(`https://commons.wikimedia.org/w/api.php?${params}`, fetchImpl)
  return (data.query?.pages || []).flatMap((page) => {
    const info = page.imageinfo && page.imageinfo[0]
    if (!info || !info.url || !info.width) return []
    const meta = (key) => stripHtml(info.extmetadata?.[key]?.value)
    const license = meta('LicenseShortName') || meta('License') || 'License on file page'
    const image = info.thumburl || info.url
    if (!/^https?:/i.test(image)) return []
    return [candidate('commons', {
      title: meta('ObjectName') || page.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
      detail: [meta('Artist'), meta('DateTimeOriginal')].filter(Boolean).join(' · '),
      about: meta('ImageDescription'),
      license,
      licenseUrl: meta('LicenseUrl') || info.descriptionurl,
      attribution: [meta('Artist') || 'Unknown', 'via Wikimedia Commons'].join(' · '),
      pageUrl: info.descriptionurl,
      imageUrl: image,
      previewUrl: info.thumburl || image,
      width: info.width,
      height: info.height,
    })]
  }).slice(0, limit)
}

async function fetchMetObjects(ids, fetchImpl) {
  const results = []
  for (const id of ids) {
    try {
      results.push(await jsonFetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, fetchImpl))
    } catch (_ignored) {}
  }
  return results
}

async function searchMet(query, limit, fetchImpl) {
  const params = new URLSearchParams({ q: query, hasImages: 'true', isPublicDomain: 'true', limit: String(Math.min(limit * 2, 12)) })
  let data
  try {
    data = await jsonFetch(`https://collectionapi.metmuseum.org/public/collection/v1.1/search?${params}`, fetchImpl)
  } catch {
    data = await jsonFetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?${params}`, fetchImpl)
  }
  const objects = await fetchMetObjects((data.objectIDs || []).slice(0, Math.min(limit, 6)), fetchImpl)
  return objects.flatMap((item) => {
    if (!item || item.isPublicDomain !== true || !item.primaryImage) return []
    return [candidate('met', {
      title: item.title || item.objectName || item.objectID,
      detail: [item.objectName, item.artistDisplayName, item.objectDate].filter(Boolean).join(' · '),
      about: [item.medium, item.classification].filter(Boolean).join(' · '),
      license: 'CC0 (Met Open Access)',
      licenseUrl: 'https://www.metmuseum.org/policies/image-resources',
      attribution: `The Metropolitan Museum of Art (${item.objectID})`,
      pageUrl: item.objectURL,
      imageUrl: item.primaryImage,
      previewUrl: item.primaryImageSmall || item.primaryImage,
      width: item.dimensions?.[0]?.width || null,
      height: item.dimensions?.[0]?.height || null,
    })]
  }).slice(0, limit)
}

async function searchAic(query, limit, fetchImpl) {
  const params = new URLSearchParams({ q: query, limit: String(Math.min(limit * 2, 12)), fields: 'id,title,artist_display,image_id,is_public_domain,thumbnail' })
  params.set('query[term][is_public_domain]', 'true')
  const data = await jsonFetch(`https://api.artic.edu/api/v1/artworks/search?${params}`, fetchImpl)
  const iiif = data.config?.iiif_url || 'https://www.artic.edu/iiif/2'
  return (data.data || []).flatMap((item) => {
    if (!item.image_id || item.is_public_domain === false) return []
    const base = `${iiif}/${item.image_id}/full`
    return [candidate('aic', {
      title: item.title || item.id,
      detail: stripHtml(item.artist_display || ''),
      license: 'CC0 (Art Institute of Chicago)',
      licenseUrl: 'https://www.artic.edu/open-access/open-access-images',
      attribution: `Art Institute of Chicago (${item.id})`,
      pageUrl: `https://www.artic.edu/artworks/${item.id}`,
      imageUrl: `${base}/1686,/0/default.jpg`,
      previewUrl: `${base}/600,/0/default.jpg`,
      width: item.thumbnail?.width || null,
      height: item.thumbnail?.height || null,
    })]
  }).slice(0, limit)
}

async function searchCleveland(query, limit, fetchImpl) {
  const params = new URLSearchParams({ q: query, has_image: '1', cc0: '1', limit: String(Math.min(limit * 2, 12)) })
  const data = await jsonFetch(`https://openaccess-api.clevelandart.org/api/artworks/?${params}`, fetchImpl)
  return (data.data || []).flatMap((item) => {
    const web = item.images?.web
    const full = item.images?.print || web
    if (!web?.url) return []
    return [candidate('cleveland', {
      title: item.title || item.id,
      detail: [item.type, ...(item.creators || []).map((creator) => creator.description), item.creation_date].filter(Boolean).join(' · '),
      about: stripHtml(item.description || item.technique || ''),
      license: 'CC0 (Cleveland Museum of Art)',
      licenseUrl: 'https://www.clevelandart.org/open-access',
      attribution: item.creditline ? `Cleveland Museum of Art · ${item.creditline}` : 'Cleveland Museum of Art',
      pageUrl: item.url,
      imageUrl: full?.url || web.url,
      previewUrl: web.url,
      width: full?.width || null,
      height: full?.height || null,
    })]
  }).slice(0, limit)
}

async function searchNasa(query, limit, fetchImpl) {
  const params = new URLSearchParams({ q: query, media_type: 'image', page_size: String(Math.min(limit * 2, 20)) })
  const data = await jsonFetch(`https://images-api.nasa.gov/search?${params}`, fetchImpl)
  return (data.collection?.items || []).flatMap((row) => {
    const item = row.data && row.data[0]
    const image = row.links?.find((link) => link.render === 'image' && link.rel === 'preview')?.href || row.links?.find((link) => link.render === 'image')?.href
    if (!item || !image) return []
    const thirdParty = /copyright|©|all rights reserved/i.test([item.description, item.photographer, item.secondary_creator].join(' '))
    return [candidate('nasa', {
      title: item.title || item.nasa_id,
      detail: [item.center, item.date_created].filter(Boolean).join(' · '),
      about: stripHtml(item.description || '').slice(0, 300),
      license: thirdParty ? 'Third-party rights mentioned; check item credits' : 'NASA media guidelines; generally not subject to US copyright; verify credits',
      licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
      attribution: ['NASA', item.center, item.photographer, item.secondary_creator].filter(Boolean).join(' · '),
      pageUrl: `https://images.nasa.gov/details/${item.nasa_id}`,
      imageUrl: image,
      previewUrl: image,
    })]
  }).slice(0, limit)
}

async function searchPolyHaven(query, limit, fetchImpl) {
  const assets = await jsonFetch('https://api.polyhaven.com/assets?t=textures', fetchImpl)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(assets || {}).flatMap(([slug, item]) => {
    const haystack = `${slug} ${item.name || ''} ${(item.categories || []).join(' ')}`.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) return []
    const preview = `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(slug)}.png?width=768`
    return [candidate('polyhaven', {
      title: item.name || slug,
      detail: (item.categories || []).join(' · '),
      license: 'CC0',
      licenseUrl: 'https://polyhaven.com/license',
      attribution: 'Poly Haven',
      pageUrl: `https://polyhaven.com/a/${slug}`,
      imageUrl: preview,
      previewUrl: preview,
    })]
  }).slice(0, limit)
}

const PROVIDERS = {
  openverse: searchOpenverse,
  commons: searchCommons,
  met: searchMet,
  aic: searchAic,
  cleveland: searchCleveland,
  nasa: searchNasa,
  polyhaven: searchPolyHaven,
}

export async function searchMedia({ query, source = 'all', limit = 6, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) throw new Error('必须提供搜索关键词')
  const total = Math.max(1, Math.min(12, Number(limit) || 6))
  const selected = source === 'all' ? Object.keys(PROVIDERS) : [source]
  if (selected.some((name) => !PROVIDERS[name])) throw new Error(`不支持图库：${source}`)
  const perSource = source === 'all' ? Math.max(2, Math.ceil(total / selected.length)) : total
  const warnings = []
  const results = await Promise.all(selected.map(async (name) => {
    try {
      return await PROVIDERS[name](query.trim(), perSource, fetchImpl, timeoutMs)
    } catch (error) {
      warnings.push(`${name}: ${error && error.message ? error.message : error}`)
      return []
    }
  }))
  const seen = new Set()
  const candidates = []
  for (const item of results.flat()) {
    if (!item.imageUrl || seen.has(item.imageUrl)) continue
    seen.add(item.imageUrl)
    candidates.push(item)
  }
  candidates.sort((a, b) => (a.usable === 'page' ? 0 : a.usable === 'check' ? 1 : 2) - (b.usable === 'page' ? 0 : b.usable === 'check' ? 1 : 2))
  return { candidates: candidates.slice(0, total), warnings }
}

export async function downloadMediaImage(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('图片 URL 必须是 HTTP(S)')
  return imageFetch(url, fetchImpl, timeoutMs)
}

export function extensionForMime(mimeType) {
  const type = String(mimeType || '').toLowerCase()
  if (type.includes('png')) return '.png'
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg'
  if (type.includes('gif')) return '.gif'
  return '.img'
}

export function refFor(provider, index) {
  return `${PREFIX[provider] || 'X'}${index}`
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Build a self-contained contact sheet from candidates with `thumbDataUri`. */
export function buildMediaContactPage({ query = '', source = 'all', candidates = [] } = {}) {
  const cards = candidates.map((item) => {
    const usable = item.usable === 'page'
    const label = usable ? '可商用' : item.usable === 'reference' ? '仅参考' : '需核对'
    return `<article class="card" id="${escapeHtml(item.ref)}">
  <div class="card-head">
    <span class="ref">${escapeHtml(item.ref)}</span>
    <span class="license ${item.usable}">${label}</span>
  </div>
  ${item.thumbDataUri ? `<img class="thumb" src="${item.thumbDataUri}" alt="${escapeHtml(item.title)}" loading="lazy" />` : '<div class="thumb empty">无预览</div>'}
  <h2>${escapeHtml(item.title)}</h2>
  <p class="detail">${escapeHtml(item.detail || '')}</p>
  <p class="license-line">${escapeHtml(item.license || 'Unknown')}</p>
  <p class="attribution">${escapeHtml(item.attribution || '')}</p>
  <div class="row">
    <button class="choose" data-ref="${escapeHtml(item.ref)}">选这个</button>
    <a href="${escapeHtml(item.pageUrl || item.imageUrl)}" target="_blank" rel="noreferrer">来源页</a>
  </div>
</article>`
  }).join('\n')
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>图库候选 - ${escapeHtml(query)}</title>
<style>
  :root { color-scheme: light; --bg:#f5f6f8; --surface:#fff; --text:#15181e; --muted:#68707d; --border:#dfe3e8; --ok:#16794a; --warn:#a15c00; --bad:#b42318; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
  header { max-width:1200px; margin:0 auto; padding:28px 24px 8px; }
  h1 { margin:0 0 4px; font-size:24px; letter-spacing:-.02em; }
  header p { margin:0; color:var(--muted); }
  main { max-width:1200px; margin:0 auto; padding:16px 24px 48px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px; min-width:0; }
  .card-head { display:flex; justify-content:space-between; gap:8px; align-items:center; }
  .ref { color:var(--muted); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .license { border-radius:999px; padding:1px 7px; font-size:10px; border:1px solid var(--border); color:var(--muted); }
  .license.page { color:var(--ok); border-color:#b7dfc8; background:#effaf3; }
  .license.reference { color:var(--warn); border-color:#f0d7ae; background:#fff8ec; }
  .license.check { color:var(--bad); border-color:#f2c2bd; background:#fff1f0; }
  .thumb { display:block; width:100%; height:170px; object-fit:cover; border-radius:8px; margin:10px 0; background:#eef0f3; }
  .thumb.empty { display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; }
  h2 { margin:0; font-size:13px; line-height:1.4; }
  .detail, .license-line, .attribution { margin:5px 0 0; color:var(--muted); font-size:11px; }
  .license-line { color:var(--text); }
  .row { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:10px; }
  .choose { border:1px solid var(--border); background:#fff; border-radius:7px; padding:5px 9px; cursor:pointer; font:inherit; font-size:12px; }
  .choose:hover { background:#eef3ff; border-color:#2563eb; color:#2563eb; }
  a { color:#2563eb; font-size:12px; text-decoration:none; }
  .toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); background:#15181e; color:#fff; border-radius:8px; padding:7px 11px; opacity:0; transition:.15s; font-size:12px; pointer-events:none; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<header><h1>图库候选</h1><p>查询：${escapeHtml(query)} · 来源：${escapeHtml(source)} · 点“选这个”复制编号，再用 ui_media fetch 下载。</p></header>
<main><div class="grid">${cards || '<p>没有候选。</p>'}</div></main>
<div class="toast" id="toast"></div>
<script>
  const toast = document.getElementById('toast');
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.choose');
    if (!button) return;
    const text = button.dataset.ref;
    try { await navigator.clipboard.writeText(text); } catch {}
    toast.textContent = '已复制：' + text + '（可多选，用逗号分隔）';
    toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
  });
</script>
</body>
</html>`
  return html
}
