// B.R.U · Prospectos — función serverless de Vercel (Node 18+, sin dependencias)
// Acciones: ping, buscar_google, buscar_osm, enriquecer, whatsapp_enviar, email_enviar
// Variables de entorno (Vercel → Settings → Environment Variables):
//   PROSPECTOS_TOKEN   clave privada del módulo (obligatoria para Google, WhatsApp API y email)
//   GOOGLE_PLACES_KEY  API key de Google Places (New)
//   WA_TOKEN, WA_PHONE_ID, WA_API_VERSION   (opcional) WhatsApp Cloud API
//   RESEND_API_KEY, EMAIL_FROM              (opcional) envío de correos por lote

'use strict';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
var OSM_UA = 'BRU-Prospectos/1.0 (brucoffeeshop.online)';

// ---------- categorías para OpenStreetMap ----------
var OSM_CATS = {
  cafeterias:   [['amenity', 'cafe'], ['shop', 'coffee']],
  restaurantes: [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  panaderias:   [['shop', 'bakery'], ['shop', 'pastry'], ['shop', 'confectionery']],
  hoteles:      [['tourism', 'hotel'], ['tourism', 'hostel'], ['tourism', 'guest_house']],
  tiendas:      [['shop', 'deli'], ['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'organic'], ['shop', 'health_food'], ['shop', 'coffee'], ['shop', 'tea']],
  bares:        [['amenity', 'bar'], ['amenity', 'pub']],
  coworkings:   [['amenity', 'coworking_space'], ['office', 'coworking']],
  empresas:     [['office', 'company'], ['office', 'corporate'], ['office', 'it'], ['office', 'financial'], ['office', 'insurance']],
  universidades:[['amenity', 'university'], ['amenity', 'college']],
  heladerias:   [['amenity', 'ice_cream']],
  gimnasios:    [['leisure', 'fitness_centre']],
  clinicas:     [['amenity', 'clinic'], ['amenity', 'hospital']]
};

// ---------- utilidades ----------
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); } }
    var data = '';
    req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', function () { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}

function fetchT(url, opts, ms) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, ms || 8000);
  opts = opts || {};
  opts.signal = ctrl.signal;
  return fetch(url, opts).finally(function () { clearTimeout(t); });
}

function uniq(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) {
    var k = String(arr[i]).toLowerCase();
    if (!arr[i] || seen[k]) continue;
    seen[k] = 1; out.push(arr[i]);
  }
  return out;
}

// ---------- Google Places (New) ----------
var G_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount',
  'places.googleMapsUri', 'places.location', 'places.types', 'places.primaryTypeDisplayName',
  'places.businessStatus', 'places.priceLevel', 'places.addressComponents', 'nextPageToken'
].join(',');

async function buscarGoogle(b) {
  var key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return { error: 'Falta GOOGLE_PLACES_KEY en Vercel. Mientras tanto usa la fuente OpenStreetMap (gratis).' };
  if (!b.query) return { error: 'Falta el texto de búsqueda' };
  var iso = /^[A-Za-z]{2}$/.test(b.pais || '') ? String(b.pais).toUpperCase() : 'CO';
  var lang = /^[a-z]{2}$/.test(b.idioma || '') ? b.idioma : 'es';
  var body = { textQuery: String(b.query).slice(0, 200), languageCode: lang, regionCode: iso, pageSize: 20 };
  if (b.pageToken) body.pageToken = b.pageToken;
  var r = await fetchT('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': G_FIELDS },
    body: JSON.stringify(body)
  }, 12000);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) return { error: 'Google: ' + ((j.error && j.error.message) || r.status) };
  var fuera = 0;
  var items = (j.places || []).filter(function (p) { return p.businessStatus !== 'CLOSED_PERMANENTLY'; }).map(function (p) {
    var web = p.websiteUri || '';
    var cc = '';
    (p.addressComponents || []).forEach(function (c) { if ((c.types || []).indexOf('country') >= 0) cc = String(c.shortText || '').toUpperCase(); });
    return {
      pais: cc || null,
      uid: 'g:' + p.id,
      fuente: 'google',
      nombre: (p.displayName && p.displayName.text) || '',
      direccion: p.formattedAddress || '',
      telefono: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
      web: web,
      rating: p.rating || null,
      resenas: p.userRatingCount || 0,
      maps_url: p.googleMapsUri || '',
      lat: p.location ? p.location.latitude : null,
      lng: p.location ? p.location.longitude : null,
      tipo_google: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || (p.types || [])[0] || '',
      precio: p.priceLevel || ''
    };
  }).filter(function (it) {
    // Google a veces mezcla negocios de otros países: solo se queda el país pedido
    if (it.pais && it.pais !== iso) { fuera++; return false; }
    if (!it.pais) it.pais = iso;
    return true;
  });
  return { items: items, fuera: fuera, nextPageToken: j.nextPageToken || null };
}

// ---------- OpenStreetMap (gratis) ----------
async function geocode(q, iso) {
  var cc = /^[A-Za-z]{2}$/.test(iso || '') ? '&countrycodes=' + String(iso).toLowerCase() : '';
  var u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1' + cc + '&q=' + encodeURIComponent(q);
  var r = await fetchT(u, { headers: { 'User-Agent': OSM_UA, 'Accept-Language': 'es' } }, 9000);
  if (!r.ok) throw new Error('Nominatim ' + r.status);
  var j = await r.json();
  if (!j.length) return null;
  var bb = j[0].boundingbox.map(Number); // [sur, norte, oeste, este]
  return { s: bb[0], n: bb[1], w: bb[2], e: bb[3], nombre: j[0].display_name };
}

function osmAddr(t) {
  var parts = [];
  if (t['addr:street']) parts.push(t['addr:street'] + (t['addr:housenumber'] ? ' # ' + t['addr:housenumber'] : ''));
  else if (t['addr:full']) parts.push(t['addr:full']);
  if (t['addr:suburb'] || t['addr:neighbourhood']) parts.push(t['addr:suburb'] || t['addr:neighbourhood']);
  if (t['addr:city']) parts.push(t['addr:city']);
  return parts.join(', ');
}

async function buscarOSM(b) {
  var filtros = OSM_CATS[b.categoria];
  if (!filtros) return { error: 'Categoría no disponible en OpenStreetMap: ' + b.categoria };
  var iso = b.pais || 'CO';
  var lugar = [b.zona, b.ciudad, b.paisNombre || ''].filter(Boolean).join(', ');
  var box = await geocode(lugar, iso);
  if (!box && b.zona) box = await geocode([b.ciudad, b.paisNombre || ''].filter(Boolean).join(', '), iso);
  if (!box) return { error: 'No encontré la zona "' + lugar + '" en el mapa' };
  // evitar cajas gigantes (departamentos enteros)
  if ((box.n - box.s) > 1.2 || (box.e - box.w) > 1.2) return { error: 'La zona es demasiado grande; elige una ciudad o barrio' };
  var bbox = [box.s, box.w, box.n, box.e].join(',');
  var lines = filtros.map(function (f) { return 'nwr["' + f[0] + '"="' + f[1] + '"]["name"](' + bbox + ');'; }).join('');
  var q = '[out:json][timeout:25];(' + lines + ');out center tags 400;';
  var hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  var j = null, lastErr = '';
  for (var i = 0; i < hosts.length && !j; i++) {
    try {
      var r = await fetchT(hosts[i], { method: 'POST', headers: { 'User-Agent': OSM_UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, 25000);
      if (r.ok) j = await r.json(); else lastErr = 'Overpass ' + r.status;
    } catch (e) { lastErr = String(e.message || e); }
  }
  if (!j) return { error: 'OpenStreetMap no respondió (' + lastErr + '). Intenta de nuevo en un minuto.' };
  var items = (j.elements || []).map(function (el) {
    var t = el.tags || {};
    var lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    var lng = el.lon != null ? el.lon : (el.center && el.center.lon);
    var ig = t['contact:instagram'] || t.instagram || '';
    var fb = t['contact:facebook'] || t.facebook || '';
    return {
      uid: 'osm:' + el.type + el.id,
      fuente: 'osm',
      nombre: t.name || '',
      direccion: osmAddr(t),
      telefono: t.phone || t['contact:phone'] || t['contact:mobile'] || '',
      whatsapp: t['contact:whatsapp'] || '',
      web: t.website || t['contact:website'] || t.url || '',
      email: t.email || t['contact:email'] || '',
      instagram: ig,
      facebook: fb,
      lat: lat || null,
      lng: lng || null,
      maps_url: lat ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((t.name || '') + ' ' + lat + ',' + lng) : '',
      tipo_google: t.cuisine ? (t.amenity || t.shop || '') + ' · ' + t.cuisine : (t.amenity || t.shop || t.tourism || t.office || t.leisure || ''),
      marca: t.brand || ''
    };
  }).filter(function (x) { return x.nombre; });
  items.forEach(function (x) { x.pais = /^[A-Za-z]{2}$/.test(iso) ? String(iso).toUpperCase() : null; });
  return { items: items, zona: box.nombre };
}

// ---------- Enriquecer: extraer contactos desde la web del negocio ----------
var BAD_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)|\.local$|\.internal$/i;
var PRIV_172 = /^172\.(1[6-9]|2\d|3[01])\./;
var IG_SKIP = { p: 1, reel: 1, reels: 1, explore: 1, accounts: 1, stories: 1, share: 1, tv: 1, about: 1, legal: 1, developer: 1, direct: 1, sharer: 1, 'web': 1 };
var FB_SKIP = { sharer: 1, 'sharer.php': 1, plugins: 1, tr: 1, dialog: 1, share: 1, 'share.php': 1, login: 1, policies: 1, help: 1, watch: 1, events: 1, groups: 1, hashtag: 1, 'profile.php': 1, pages: 1, privacy: 1 };
var MAIL_SKIP = /(\.(png|jpe?g|gif|webp|svg|css|js|ico|avif|bmp|tiff?|mp4|pdf)$)|example\.|sentry|wixpress|wix\.com|squarespace|godaddy|elatedthemes|qodeinteractive|mikado-themes|themeforest|envato|themeisle|wpengine|cloudflare|domain\.com$|website\.com$|email\.com$|sitio\.com$|tusitio|tudominio|yourdomain|yoursite|your-?email|youremail|correo@|usuario@|user@|name@|nombre@|test@|info@info|@2x|@3x|u00|%|no-?reply|donotreply|do-not-reply|notifica|notification|mailer-daemon|postmaster|abuse@|privacy@|gdpr@|webmaster@|hostmaster@|\.(png|jpg)@/i;
var MAIL_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}|[0-9a-f]{16,}|^[^@]{41,}@/i;
// correo plausible de un negocio (no de plantillas, rastreadores ni robots)
function correoValido(e) {
  return /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e) && !MAIL_SKIP.test(e) && !MAIL_UUID.test(e) && e.length < 70;
}
var ROL_BUENO = /^(ventas|sales|compras|purchasing|pedidos|orders|info|hola|hello|hi|contacto|contact|contactenos|administracion|admin|gerencia|manager|reservas|eventos|events|catering|wholesale|mayoristas)@/;
// ordena: primero los del mismo dominio de la web y los de roles comerciales
function ordenarCorreos(list, host) {
  var dom = String(host || '').replace(/^www\./, '').split('.').slice(-3).join('.');
  var raiz = dom.split('.')[0];
  function pts(e) {
    var d = e.split('@')[1] || '', s = 0;
    if (dom && (d === dom || dom.indexOf(d) >= 0 || d.indexOf(raiz) >= 0)) s += 10;
    if (ROL_BUENO.test(e)) s += 4;
    if (/gmail|hotmail|outlook|yahoo|icloud/.test(d)) s += 2;
    if (/^(careers|jobs|empleo|trabaja|rrhh|hr|press|prensa|legal|soporte|support|billing|facturacion)@/.test(e)) s -= 6;
    return s;
  }
  return list.slice().sort(function (a, b) { return pts(b) - pts(a); });
}

function decodeCf(hex) {
  try {
    var key = parseInt(hex.substr(0, 2), 16), out = '';
    for (var i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
    return out;
  } catch (e) { return ''; }
}

function extraer(html, base) {
  var out = { emails: [], instagram: [], facebook: [], tiktok: [], linkedin: [], whatsapp: [], telefonos: [], links: [] };
  var h = html
    .replace(/&#64;|&#x40;|%40|\s\[at\]\s|\s\(at\)\s|\s\[arroba\]\s/gi, '@')
    .replace(/&#46;|&#x2e;/gi, '.')
    .replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  var m, re;
  re = /data-cfemail="([0-9a-f]+)"/gi;
  while ((m = re.exec(h))) out.emails.push(decodeCf(m[1]));
  re = /mailto:([^"'?\s>]+)/gi;
  while ((m = re.exec(h))) out.emails.push(decodeURIComponent(m[1]));
  re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
  while ((m = re.exec(h))) out.emails.push(m[0]);
  out.emails = uniq(out.emails.map(function (e) { return e.trim().toLowerCase().replace(/^[.]+|[.]+$/g, ''); })
    .filter(correoValido));

  re = /instagram\.com\/([A-Za-z0-9_.]{2,30})/gi;
  while ((m = re.exec(h))) { var u = m[1].replace(/\.$/, ''); if (!IG_SKIP[u.toLowerCase()]) out.instagram.push(u); }
  re = /facebook\.com\/([A-Za-z0-9.\-]{3,80})/gi;
  while ((m = re.exec(h))) { if (!FB_SKIP[m[1].toLowerCase()]) out.facebook.push(m[1]); }
  re = /tiktok\.com\/@([A-Za-z0-9_.]{2,30})/gi;
  while ((m = re.exec(h))) out.tiktok.push(m[1]);
  re = /linkedin\.com\/(company|in)\/([A-Za-z0-9\-_%]{2,100})/gi;
  while ((m = re.exec(h))) out.linkedin.push('https://www.linkedin.com/' + m[1] + '/' + m[2]);
  re = /(?:wa\.me\/|wa\.link\/|api\.whatsapp\.com\/send\/?\?(?:[^"']*?&)?phone=|web\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=)\+?(\d[\d\s-]{7,18}\d)/gi;
  while ((m = re.exec(h))) out.whatsapp.push(m[1].replace(/\D/g, ''));
  re = /tel:([+\d\s().-]{7,20})/gi;
  while ((m = re.exec(h))) out.telefonos.push(m[1].replace(/[^\d+]/g, ''));
  // "WhatsApp: 300 123 4567" escrito en la página
  var texto = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  re = /(?:whats\s?app|wpp|wsp|celular|cel\.?|m[oó]vil)\s*[:#.\-]?\s*(\+?\(?\d[\d\s().-]{8,17}\d)/gi;
  while ((m = re.exec(texto))) out.whatsapp.push(m[1].replace(/\D/g, ''));
  // datos estructurados schema.org (muchas webs los traen)
  re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = re.exec(html))) {
    try {
      var js = JSON.parse(m[1].trim());
      (Array.isArray(js) ? js : (js['@graph'] || [js])).forEach(function (o) {
        if (!o || typeof o !== 'object') return;
        if (o.email) out.emails.push(String(o.email).replace(/^mailto:/i, '').toLowerCase());
        if (o.telephone) out.telefonos.push(String(o.telephone).replace(/[^\d+]/g, ''));
        [].concat(o.sameAs || []).forEach(function (u) { out.links_redes = (out.links_redes || []).concat([String(u)]); });
      });
    } catch (e) {}
  }
  (out.links_redes || []).forEach(function (u) {
    var a = /instagram\.com\/([A-Za-z0-9_.]{2,30})/i.exec(u); if (a && !IG_SKIP[a[1].toLowerCase()]) out.instagram.push(a[1]);
    var f = /facebook\.com\/([A-Za-z0-9.\-]{3,80})/i.exec(u); if (f && !FB_SKIP[f[1].toLowerCase()]) out.facebook.push(f[1]);
  });
  out.emails = uniq(out.emails.filter(correoValido));
  out.telefonos = out.telefonos.filter(function (t) { return t.replace(/\D/g, '').length >= 7; });
  out.whatsapp = out.whatsapp.filter(function (t) { return t.length >= 10 && t.length <= 15; });

  re = /href=["']([^"'#]+)["']/gi;
  while ((m = re.exec(h))) {
    var href = m[1];
    if (/contact|contacto|contactenos|contáctenos|escribenos|nosotros|about|ubicacion|sedes|wholesale|mayoristas|linktr\.ee|beacons\.ai|linkin\.bio/i.test(href) && !/\.(jpg|png|pdf|css|js)$/i.test(href)) {
      try { var abs = new URL(href, base); if (abs.host === new URL(base).host || /linktr\.ee|beacons\.ai|linkin\.bio/.test(abs.host)) out.links.push(abs.href); } catch (e) {}
    }
  }
  ['instagram', 'facebook', 'tiktok', 'linkedin', 'whatsapp', 'telefonos', 'links'].forEach(function (k) { out[k] = uniq(out[k]); });
  var tm = /<title[^>]*>([^<]{1,160})<\/title>/i.exec(html);
  out.titulo = tm ? tm[1].trim() : '';
  var dm = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})/i.exec(html);
  out.descripcion = dm ? dm[1].trim() : '';
  return out;
}

function urlSegura(raw) {
  var s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    var u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (BAD_HOST.test(u.hostname) || PRIV_172.test(u.hostname)) return null;
    return u;
  } catch (e) { return null; }
}

async function bajar(url) {
  var r = await fetchT(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'es-CO,es;q=0.9' }, redirect: 'follow' }, 7000);
  var ct = r.headers.get('content-type') || '';
  if (!r.ok || (ct && ct.indexOf('html') < 0 && ct.indexOf('text') < 0)) return { ok: false, status: r.status, url: r.url };
  var txt = await r.text();
  return { ok: true, html: txt.slice(0, 1500000), url: r.url || url };
}

async function enriquecer(b) {
  var u = urlSegura(b.url);
  if (!u) return { error: 'URL no válida' };
  var host = u.hostname.replace(/^www\./, '');
  var res = { emails: [], instagram: [], facebook: [], tiktok: [], linkedin: [], whatsapp: [], telefonos: [], paginas: [], titulo: '', descripcion: '' };
  // la "web" es una red social: se toma directo
  if (/instagram\.com$/.test(host)) { var ig = u.pathname.split('/').filter(Boolean)[0]; if (ig && !IG_SKIP[ig]) res.instagram.push(ig); return res; }
  if (/facebook\.com$/.test(host)) { var fb = u.pathname.split('/').filter(Boolean)[0]; if (fb && !FB_SKIP[fb]) res.facebook.push(fb); return res; }
  if (/tiktok\.com$/.test(host)) { var tk = (u.pathname.match(/@([A-Za-z0-9_.]+)/) || [])[1]; if (tk) res.tiktok.push(tk); return res; }
  if (/wa\.me$|whatsapp\.com$/.test(host)) { var wn = (u.href.match(/(\d{8,15})/) || [])[1]; if (wn) res.whatsapp.push(wn); return res; }

  var t0 = Date.now();
  var cola = [u.href], vistos = {};
  var extra = ['/contacto', '/contact', '/contactenos', '/pages/contact', '/contact-us'];
  var anadidas = false;
  while (cola.length && res.paginas.length < 4 && Date.now() - t0 < 9000) {
    var url = cola.shift();
    if (vistos[url]) continue;
    vistos[url] = 1;
    var p;
    try { p = await bajar(url); } catch (e) { if (!res.paginas.length) return { error: 'La web no respondió (' + (e.name === 'AbortError' ? 'tiempo agotado' : e.message) + ')' }; continue; }
    if (!p.ok) { if (!res.paginas.length) return { error: 'La web respondió ' + p.status }; continue; }
    if (res.paginas.length && /linktr\.ee|beacons\.ai|linkin\.bio/.test(p.url) === false && new URL(p.url).host !== new URL(u.href).host && !/linktr|beacons|linkin/.test(url)) continue;
    res.paginas.push(p.url);
    var x = extraer(p.html, p.url);
    ['emails', 'instagram', 'facebook', 'tiktok', 'linkedin', 'whatsapp', 'telefonos'].forEach(function (k) { res[k] = uniq(res[k].concat(x[k])); });
    if (!res.titulo) { res.titulo = x.titulo; res.descripcion = x.descripcion; }
    x.links.slice(0, 4).forEach(function (l) { if (!vistos[l]) cola.push(l); });
    // si la portada no trae enlace de contacto, probar las rutas típicas
    if (!anadidas && res.paginas.length === 1) {
      anadidas = true;
      if (!x.links.length) extra.forEach(function (pth) { try { cola.push(new URL(pth, p.url).href); } catch (e) {} });
    }
    if (res.emails.length && (res.whatsapp.length || res.instagram.length) && res.paginas.length >= 2) break;
  }
  res.emails = ordenarCorreos(res.emails, host).slice(0, 8); res.instagram = res.instagram.slice(0, 4); res.facebook = res.facebook.slice(0, 4);
  return res;
}

// ---------- Verificar correos: el dominio debe existir y recibir correo (registros MX) ----------
var dnsp = require('dns').promises;
var MX_CACHE = {};
function conTiempo(prom, ms) { return Promise.race([prom, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]); }
async function dominioRecibe(dom) {
  if (MX_CACHE[dom]) return MX_CACHE[dom];
  var out;
  try {
    var mx = await conTiempo(dnsp.resolveMx(dom), 4000);
    out = mx && mx.length ? { ok: true } : { ok: false, motivo: 'el dominio no recibe correo' };
  } catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA' || e.code === 'NXDOMAIN')) {
      try { var a = await conTiempo(dnsp.resolve4(dom), 3000); out = a && a.length ? { ok: true, debil: true } : { ok: false, motivo: 'el dominio no existe' }; }
      catch (e2) { out = { ok: false, motivo: 'el dominio no existe' }; }
    } else out = { ok: null, motivo: 'no se pudo comprobar' };
  }
  MX_CACHE[dom] = out;
  return out;
}
async function verificarEmails(b) {
  var list = [].concat(b.emails || []).slice(0, 60).map(function (e) { return String(e || '').trim().toLowerCase(); });
  var res = {};
  await Promise.all(list.map(async function (e) {
    if (!correoValido(e)) { res[e] = { ok: false, motivo: 'no parece un correo real del negocio' }; return; }
    res[e] = await dominioRecibe(e.split('@')[1]);
  }));
  return { resultados: res };
}

// ---------- Completar con Google: busca el negocio por nombre y ubicación ----------
function normN(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function parecido(a, b) {
  var A = normN(a).split(' ').filter(function (w) { return w.length > 2; }), B = normN(b);
  if (!A.length) return normN(a) === B ? 1 : 0;
  var hit = A.filter(function (w) { return B.indexOf(w) >= 0; }).length;
  return hit / A.length;
}
async function completarGoogle(b) {
  var key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return { error: 'Falta GOOGLE_PLACES_KEY en Vercel.' };
  if (!b.nombre) return { error: 'Falta el nombre' };
  var iso = /^[A-Za-z]{2}$/.test(b.pais || '') ? String(b.pais).toUpperCase() : 'CO';
  var body = { textQuery: (String(b.nombre) + ', ' + (b.ciudad || '')).slice(0, 200), languageCode: b.idioma || 'es', regionCode: iso, pageSize: 3 };
  if (b.lat != null && b.lng != null) body.locationBias = { circle: { center: { latitude: Number(b.lat), longitude: Number(b.lng) }, radius: 400 } };
  var r = await fetchT('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': G_FIELDS.replace(',nextPageToken', '') },
    body: JSON.stringify(body)
  }, 12000);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) return { error: 'Google: ' + ((j.error && j.error.message) || r.status) };
  var best = null, bestS = 0;
  (j.places || []).forEach(function (p) {
    var n = (p.displayName && p.displayName.text) || '';
    var sc = Math.max(parecido(b.nombre, n), parecido(n, b.nombre));
    if (b.lat != null && p.location) {
      var d = Math.abs(p.location.latitude - b.lat) + Math.abs(p.location.longitude - b.lng);
      if (d < 0.004) sc += 0.3; else if (d > 0.05) sc -= 0.5;
    }
    if (sc > bestS) { bestS = sc; best = p; }
  });
  if (!best || bestS < 0.6) return { encontrado: false };
  if (best.businessStatus === 'CLOSED_PERMANENTLY') return { encontrado: true, cerrado: true };
  return {
    encontrado: true,
    telefono: best.internationalPhoneNumber || best.nationalPhoneNumber || '',
    web: best.websiteUri || '',
    maps_url: best.googleMapsUri || '',
    rating: best.rating || null,
    resenas: best.userRatingCount || 0,
    tipo_google: (best.primaryTypeDisplayName && best.primaryTypeDisplayName.text) || '',
    direccion: best.formattedAddress || ''
  };
}

// ---------- WhatsApp Cloud API (opcional) ----------
async function whatsappEnviar(b) {
  var tok = process.env.WA_TOKEN, pid = process.env.WA_PHONE_ID, ver = process.env.WA_API_VERSION || 'v23.0';
  if (!tok || !pid) return { error: 'WhatsApp Cloud API no configurada (WA_TOKEN y WA_PHONE_ID). Usa el botón de WhatsApp Business, que abre el chat directo.' };
  if (!b.to || !b.plantilla) return { error: 'Faltan destino o plantilla' };
  var comps = [];
  if (b.params && b.params.length) comps.push({ type: 'body', parameters: b.params.map(function (t) { return { type: 'text', text: String(t).slice(0, 200) }; }) });
  var r = await fetchT('https://graph.facebook.com/' + ver + '/' + pid + '/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: String(b.to).replace(/\D/g, ''), type: 'template', template: { name: b.plantilla, language: { code: b.idioma || 'es' }, components: comps } })
  }, 12000);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) return { error: 'WhatsApp: ' + ((j.error && j.error.message) || r.status) };
  return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
}

// ---------- Email por Resend (opcional) ----------
async function emailEnviar(b) {
  var key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM;
  if (!key || !from) return { error: 'Envío automático de correo no configurado (RESEND_API_KEY y EMAIL_FROM). Usa el botón Gmail, que abre el correo listo.' };
  if (!b.to || !b.asunto || !b.texto) return { error: 'Faltan destino, asunto o texto' };
  var html = String(b.texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  var r = await fetchT('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from, to: [b.to], subject: String(b.asunto).slice(0, 200), text: b.texto, html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#222">' + html + '</div>', reply_to: b.responder_a || undefined })
  }, 12000);
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) return { error: 'Email: ' + (j.message || r.status) };
  return { ok: true, id: j.id };
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'Usa POST' });
  var b = await readBody(req);
  var accion = b.accion;
  var tokenEnv = process.env.PROSPECTOS_TOKEN || '';
  var tokenReq = req.headers['x-bru-token'] || '';
  var autorizado = tokenEnv ? tokenReq === tokenEnv : false;
  var pagas = { buscar_google: 1, completar_google: 1, whatsapp_enviar: 1, email_enviar: 1 };

  if (accion === 'ping') {
    return send(res, 200, {
      ok: true,
      requiereClave: !!tokenEnv,
      claveValida: tokenEnv ? autorizado : true,
      google: !!process.env.GOOGLE_PLACES_KEY,
      whatsappApi: !!(process.env.WA_TOKEN && process.env.WA_PHONE_ID),
      email: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
    });
  }
  if (tokenEnv && !autorizado) return send(res, 401, { error: 'Clave del módulo incorrecta' });
  if (!tokenEnv && pagas[accion]) return send(res, 403, { error: 'Para usar ' + accion + ' primero define PROSPECTOS_TOKEN en Vercel (protege tu API key).' });

  try {
    var out;
    if (accion === 'buscar_google') out = await buscarGoogle(b);
    else if (accion === 'buscar_osm') out = await buscarOSM(b);
    else if (accion === 'enriquecer') out = await enriquecer(b);
    else if (accion === 'verificar_emails') out = await verificarEmails(b);
    else if (accion === 'completar_google') out = await completarGoogle(b);
    else if (accion === 'whatsapp_enviar') out = await whatsappEnviar(b);
    else if (accion === 'email_enviar') out = await emailEnviar(b);
    else return send(res, 400, { error: 'Acción desconocida' });
    return send(res, out && out.error ? 422 : 200, out);
  } catch (e) {
    return send(res, 500, { error: 'Error interno: ' + String((e && e.message) || e) });
  }
};

module.exports.extraer = extraer; // para pruebas
module.exports.correoValido = correoValido;
module.exports.dominioRecibe = dominioRecibe;
module.exports.OSM_CATS = OSM_CATS;
