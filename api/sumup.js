// B.R.U · Pagos en euros con SumUp (Hosted Checkout) · Vercel, Node, sin dependencias
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   SUMUP_API_KEY        → clave secreta de la API de SumUp (sup_sk_…)
//   SUMUP_MERCHANT_CODE  → código de comercio de SumUp (ej. MXXXXXXX)
//
// Cómo funciona:
//   GET  /api/sumup                 → { activo: true|false }  (la tienda sabe si puede cobrar con tarjeta)
//   POST /api/sumup  {pedido}       → calcula el total EN EL SERVIDOR con los precios publicados del
//                                     mercado (no se confía en el navegador), crea el cobro en SumUp
//                                     y devuelve { url, id, ref, total, envio, moneda }
//   GET  /api/sumup?id=…&ref=…      → estado del cobro (PENDING | PAID | FAILED | EXPIRED); si ya está
//                                     pagado, marca el pedido como "Pagado" en bru_pedidos.
var SB_URL = 'https://dzgtyazvqpdmwvwqpvco.supabase.co';
var SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_oWYjmVo0OBg5XbV4BDaSWQ_hOWH6czB';
var SUMUP = 'https://api.sumup.com/v0.1';

// Envío por defecto de cada mercado con pago en línea. Se puede cambiar desde
// tienda_config.mercados.EU.checkout = { envioPaises:['ES'], envio:{ES:0}, envioBaleares:0 }
var CHECKOUT_BASE = { EU: { envioPaises: ['ES'], envio: { ES: 0 }, envioBaleares: 0 } };

function json(res, code, obj){ res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
function leerBody(req){
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
  return new Promise(function(ok){ var d = ''; req.on('data', function(c){ d += c; }); req.on('end', function(){ try { ok(JSON.parse(d || '{}')); } catch (e) { ok({}); } }); });
}
function listo(){ return !!(process.env.SUMUP_API_KEY && process.env.SUMUP_MERCHANT_CODE); }
function sb(path, opts){
  opts = opts || {};
  var h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
  if (opts.prefer) h.Prefer = opts.prefer;
  return fetch(SB_URL + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(function(r){ if (!r.ok) throw new Error('Supabase ' + r.status); return (r.status === 204 || r.status === 201) ? null : r.json(); });
}
function sumup(path, opts){
  opts = opts || {};
  return fetch(SUMUP + path, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + process.env.SUMUP_API_KEY, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function(r){
    return r.text().then(function(t){
      var j = {}; try { j = JSON.parse(t || '{}'); } catch (e) {}
      if (!r.ok) { var m = (j && (j.message || j.error_message || (j[0] && j[0].message))) || ('SumUp ' + r.status); throw new Error(m); }
      return j;
    });
  });
}
function r2(n){ return Math.round((Number(n) || 0) * 100) / 100; }
function norm(s){ return String(s == null ? '' : s).trim().toLowerCase(); }

// Precio publicado de un producto/presentación en el mercado (misma lógica que la tienda)
function precioEn(p, tamano, cod){
  var t = norm(tamano);
  var propio = p.presentacionesPorMercado && p.presentacionesPorMercado[cod];
  if (Array.isArray(propio) && propio.length){
    var e = propio.filter(function(x){ return norm(x.label) === t; })[0] || (!t && propio.length === 1 ? propio[0] : null);
    var v = e ? parseFloat(e.precio) : NaN;
    return (isNaN(v) || v <= 0) ? null : v;
  }
  var pres = p.presentaciones || [];
  if (pres.length){
    var pr = pres.filter(function(x){ return norm(x.label) === t || (x.etiquetas && norm(x.etiquetas[cod]) === t); })[0] || (!t && pres.length === 1 ? pres[0] : null);
    var w = pr && pr.precios ? parseFloat(pr.precios[cod]) : NaN;
    if (!isNaN(w) && w > 0) return w;
    if (pr) return null;
  }
  var b = p.precios ? parseFloat(p.precios[cod]) : NaN;
  return (isNaN(b) || b <= 0) ? null : b;
}

function cotizar(pedido){
  var cod = String(pedido.mercado || 'EU').toUpperCase();
  return sb('bru_store?id=eq.main&select=catalogo,tienda_config').then(function(rows){
    var row = rows && rows[0]; if (!row) throw new Error('No se pudo leer el catálogo');
    var merc = ((row.tienda_config || {}).mercados || {})[cod];
    if (!merc || !merc.activo) throw new Error('Este mercado no está activo');
    var ck = Object.assign({}, CHECKOUT_BASE[cod] || {}, merc.checkout || {});
    var pais = String(pedido.pais || '').toUpperCase();
    if ((ck.envioPaises || []).indexOf(pais) < 0) throw new Error('Por ahora no enviamos a ese país');
    var cp = String(pedido.cp || '').replace(/\s/g, '');
    if (pais === 'ES' && /^(35|38|51|52)/.test(cp)) throw new Error('Canarias, Ceuta y Melilla requieren aduana: escríbenos por WhatsApp');
    var cat = row.catalogo || [];
    var items = (pedido.items || []).slice(0, 30).map(function(it){
      var p = cat.filter(function(x){ return x && x.activo !== false && norm(x.nombre) === norm(it.nombre); })[0];
      if (!p) throw new Error('Producto no disponible: ' + it.nombre);
      var precio = precioEn(p, it.tamano, cod);
      if (precio === null) throw new Error('Sin precio en este mercado: ' + it.nombre + (it.tamano ? ' ' + it.tamano : ''));
      var qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
      return { nombre: p.nombre, tamano: it.tamano || '', qty: qty, precio: r2(precio) };
    });
    if (!items.length) throw new Error('El carrito está vacío');
    var sub = r2(items.reduce(function(s, i){ return s + i.precio * i.qty; }, 0));
    var envio = r2((ck.envio && ck.envio[pais]) || 0);
    if (pais === 'ES' && /^07/.test(cp)) envio = r2(envio + (Number(ck.envioBaleares) || 0));
    return { mercado: cod, moneda: merc.moneda || 'EUR', items: items, subtotal: sub, envio: envio, total: r2(sub + envio) };
  });
}

module.exports = function handler(req, res){
  if (req.method === 'GET'){
    var q = req.query || {};
    if (!q.id) return json(res, 200, { activo: listo() });
    if (!listo()) return json(res, 400, { error: 'SumUp no está configurado' });
    var id = String(q.id).replace(/[^a-zA-Z0-9-]/g, '');
    var ref = String(q.ref || '').replace(/[^a-z0-9_]/g, '');
    return sumup('/checkouts/' + id).then(function(c){
      var estado = c.status || 'PENDING';
      var marcar = (estado === 'PAID' && ref && c.checkout_reference === ref)
        ? sb('bru_pedidos?notas=ilike.*' + encodeURIComponent(ref) + '*', { method: 'PATCH', body: { estado: 'Pagado' }, prefer: 'return=minimal' }).catch(function(){})
        : Promise.resolve();
      return marcar.then(function(){ json(res, 200, { estado: estado, total: c.amount, moneda: c.currency }); });
    }).catch(function(e){ json(res, 500, { error: e.message }); });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido' });
  if (!listo()) return json(res, 400, { error: 'SumUp no está configurado' });
  return leerBody(req).then(function(b){
    var pedido = (b && b.pedido) || {};
    return cotizar(pedido).then(function(cot){
      var ref = 'eu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      var origen = String(b.origen || '').replace(/[^a-zA-Z0-9:/._-]/g, '');
      if (!/^https:\/\/([a-z0-9-]+\.)*(brucoffeeshop\.online|vercel\.app)$/.test(origen)) origen = 'https://www.brucoffeeshop.online';
      var desc = 'B.R.U · ' + cot.items.map(function(i){ return i.nombre + (i.tamano ? ' ' + i.tamano : '') + ' x' + i.qty; }).join(', ');
      return sumup('/checkouts', { method: 'POST', body: {
        checkout_reference: ref,
        amount: cot.total,
        currency: cot.moneda,
        merchant_code: process.env.SUMUP_MERCHANT_CODE,
        description: desc.slice(0, 250),
        redirect_url: origen + '/?sumup=' + ref,
        hosted_checkout: { enabled: true }
      }}).then(function(c){
        if (!c.hosted_checkout_url) throw new Error('SumUp no devolvió el enlace de pago');
        json(res, 200, { url: c.hosted_checkout_url, id: c.id, ref: ref, items: cot.items, subtotal: cot.subtotal, envio: cot.envio, total: cot.total, moneda: cot.moneda });
      });
    });
  }).catch(function(e){ json(res, 400, { error: e.message }); });
};
