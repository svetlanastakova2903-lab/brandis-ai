// Filter the entire catalogue and rank it before selecting a page.
function text(value) {
  return String(value ?? '').trim().toLocaleLowerCase('ru');
}

export function profileKey(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) return null;
    // YouTube channel IDs are case sensitive.
    return host + (host === 'youtube.com' && path.startsWith('/channel/') ? path : path.toLowerCase());
  } catch {
    return null;
  }
}

function values(value) {
  return (Array.isArray(value) ? value : String(value ?? '').split(';')).map(text).filter(Boolean);
}

export function selectCatalog(items, claims, filters = {}) {
  const verified = new Map();
  for (const claim of claims) {
    const key = profileKey(claim.profile_url);
    if (key && claim.status === 'verified' && claim.paid_at) verified.set(key, claim);
  }
  const options = {};
  for (const field of ['city', 'niche', 'platform']) options[field] = values(filters[field]);
  const search = text(filters.search);
  const matched = items.filter(item => {
    for (const field of Object.keys(options)) {
      if (options[field].length && !options[field].some(value => values(item[field]).includes(value))) return false;
    }
    if (search && !text([item.name, item.city, ...values(item.niche)].join(' ')).includes(search)) return false;
    return true;
  }).map((item, index) => {
    const claim = verified.get(profileKey(item.profile_url || item.contact));
    return { ...item, verified: Boolean(claim), verification_id: claim?.id || null, accepts_offers:claim?.offers_enabled===true, originalIndex: index };
  });
  matched.sort((a, b) => {
    const priority = Number(b.verified) - Number(a.verified);
    if (priority) return priority;
    if(['newest','oldest'].includes(filters.sort)){
      const ak=Number.isFinite(a.created_rank),bk=Number.isFinite(b.created_rank);
      if(ak!==bk)return ak?-1:1;
      if(ak&&a.created_rank!==b.created_rank)return (filters.sort==='oldest'?-1:1)*(a.created_rank-b.created_rank);
    }
    if (['name','name_desc'].includes(filters.sort)) return (filters.sort==='name_desc'?-1:1)*String(a.name).localeCompare(String(b.name), 'ru') || a.originalIndex - b.originalIndex;
    if (['price_asc','price_desc'].includes(filters.sort)) return (filters.sort==='price_desc'?-1:1)*((a.price||0)-(b.price||0)) || a.originalIndex-b.originalIndex;
    if (['followers_asc', 'followers_desc'].includes(filters.sort)) {
      const aKnown = Number.isFinite(a.followers);
      const bKnown = Number.isFinite(b.followers);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && a.followers !== b.followers) return filters.sort === 'followers_asc' ? a.followers - b.followers : b.followers - a.followers;
    }
    return a.originalIndex - b.originalIndex;
  });
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const size = Math.min(100, Math.max(1, Number.parseInt(filters.size, 10) || 24));
  return {
    total: matched.length, page, size,
    items: matched.slice((page - 1) * size, page * size).map(({ originalIndex, ...item }) => item),
  };
}

export function registerCatalogRoutes(app, { getCatalog, query, enabled }) {
  app.get('/api/catalog', async (req, res) => {
    const category = req.query.category || 'bloggers';
    if (!['bloggers', 'brands'].includes(category)) return res.status(400).json({ error: 'Неизвестный раздел каталога.' });
    try {
      const claims = enabled() ? (await query(`SELECT id,profile_url,status,paid_at,offers_enabled FROM verification_claims WHERE status='verified' AND paid_at IS NOT NULL`)).rows : [];
      res.set('Cache-Control', 'no-store');
      const items=getCatalog(category);
      const facets={};
      for(const field of ['city','niche','platform']) facets[field]=[...new Set(items.flatMap(item=>Array.isArray(item[field])?item[field]:String(item[field]||'').split(';')).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
      res.json({...selectCatalog(items, claims, req.query),facets});
    } catch {
      res.status(503).json({ error: 'Не удалось загрузить каталог. Попробуйте ещё раз.' });
    }
  });
}
