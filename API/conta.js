// B.R.U · Contabilidad — servidor (Vercel, Node, sin dependencias)
// Variables de entorno (Vercel → Settings → Environment Variables):
//   ALEGRA_EMAIL, ALEGRA_TOKEN       → para emitir facturas electrónicas por Alegra
//   ALEGRA_NUMERACION (opcional)     → id de la numeración de factura electrónica en Alegra
//   CONTA_TOKEN (opcional)           → si se define, la página debe enviar esta clave
var AL = 'https://api.alegra.com/api/v1';

function json(res, code, obj){ res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
function leerBody(req){
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
  return new Promise(function(ok){ var d = ''; req.on('data', function(c){ d += c; }); req.on('end', function(){ try { ok(JSON.parse(d || '{}')); } catch (e) { ok({}); } }); });
}
function alegraOK(){ return !!(process.env.ALEGRA_EMAIL && process.env.ALEGRA_TOKEN); }
function al(path, method, body){
  var auth = Buffer.from(process.env.ALEGRA_EMAIL + ':' + process.env.ALEGRA_TOKEN).toString('base64');
  return fetch(AL + path, { method: method || 'GET', headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(function(r){ return r.text().then(function(t){ var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { message: t.slice(0, 200) }; }
      if (!r.ok) { var m = (j && (j.message || (j.error && j.error.message))) || ('Alegra ' + r.status); var e2 = new Error('Alegra: ' + m); e2.status = r.status; throw e2; }
      return j; }); });
}
function tipoDocAlegra(t){ return ({NIT:'NIT', CC:'CC', CE:'CE', PA:'PP', PP:'PP', TI:'TI', NITE:'NIT_EXTRANJERO', DIE:'DIE'})[String(t || 'CC').toUpperCase()] || 'CC'; }

// Busca el cliente por documento o lo crea
function contacto(c){
  var num = String(c.num || '').replace(/\D/g, '');
  var p = num ? al('/contacts?identification=' + encodeURIComponent(num) + '&limit=1') : Promise.resolve([]);
  return p.then(function(lst){
    if (Array.isArray(lst) && lst.length) return lst[0].id;
    var esJur = c.persona === 'J' || String(c.tipoDoc).toUpperCase() === 'NIT';
    var body = {
      name: c.nombre || 'Consumidor final',
      identificationObject: { type: tipoDocAlegra(c.tipoDoc), number: num || '222222222222', dv: c.dv || undefined },
      kindOfPerson: esJur ? 'LEGAL_ENTITY' : 'PERSON_ENTITY',
      regime: c.respIVA ? 'COMMON_REGIME' : 'SIMPLIFIED_REGIME',
      email: c.email || undefined,
      address: { address: c.dir || 'Sin dirección', city: c.ciudad || 'Bogotá, D.C.' },
      type: ['client']
    };
    if (!esJur) { var partes = String(body.name).split(' '); body.nameObject = { firstName: partes[0], lastName: partes.slice(1).join(' ') || '.' }; }
    return al('/contacts', 'POST', body).then(function(r){ return r.id; });
  });
}
// Impuestos de Alegra (IVA 19 %, 5 %, 0 %)
function impuestos(){ return al('/taxes').then(function(lst){ var m = {}; (lst || []).forEach(function(t){ if (/iva/i.test(t.type || t.name || '') && (t.status || 'active') === 'active') { var p = Number(t.percentage); if (m[p] == null) m[p] = t.id; } }); return m; }); }
// Producto genérico por descripción (Alegra exige un ítem por línea)
function item(desc, precio, taxId){
  var nombre = String(desc || 'Producto').slice(0, 150);
  return al('/items?name=' + encodeURIComponent(nombre) + '&limit=1').then(function(lst){
    if (Array.isArray(lst) && lst.length && lst[0].name === nombre) return lst[0].id;
    var b = { name: nombre, price: [{ price: precio }], inventory: undefined };
    if (taxId) b.tax = [{ id: taxId }];
    return al('/items', 'POST', b).then(function(r){ return r.id; });
  });
}

function emitir(d){
  if (!alegraOK()) return Promise.reject(new Error('Faltan ALEGRA_EMAIL y ALEGRA_TOKEN en Vercel'));
  if (!d.items || !d.items.length) return Promise.reject(new Error('La factura no tiene ítems'));
  var cli, tax;
  return contacto(d.cliente || {}).then(function(id){ cli = id; return impuestos(); }).then(function(t){ tax = t;
    return Promise.all(d.items.map(function(it){ return item(it.desc, it.precio, Number(it.iva) ? tax[Number(it.iva)] : null); }));
  }).then(function(ids){
    var inv = {
      date: d.fecha, dueDate: d.vence || d.fecha, client: { id: cli },
      paymentForm: d.forma === 'credito' ? 'CREDIT' : 'CASH', paymentMethod: d.forma === 'credito' ? 'INSTRUMENT_NOT_DEFINED' : 'CASH',
      observations: d.obs || undefined,
      items: d.items.map(function(it, i){ var o = { id: ids[i], description: it.desc, price: Number(it.precio), quantity: Number(it.cant) || 1, discount: Number(it.descuento) || 0 }; if (Number(it.iva) && tax[Number(it.iva)]) o.tax = [{ id: tax[Number(it.iva)] }]; return o; }),
      stamp: { generateStamp: true }
    };
    if (process.env.ALEGRA_NUMERACION) inv.numberTemplate = { id: process.env.ALEGRA_NUMERACION };
    return al('/invoices', 'POST', inv);
  }).then(function(r){
    var st = r.stamp || {};
    return { ok: true, id: r.id, numero: (r.numberTemplate && (r.numberTemplate.fullNumber || ((r.numberTemplate.prefix || '') + (r.numberTemplate.number || '')))) || '', cufe: st.cufe || '', estado: st.legalStatus || r.status || '', pdf: r.pdfUrl || '' };
  });
}

module.exports = function(req, res){
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'POST'); return json(res, 204, {}); }
  if (req.method !== 'POST') return json(res, 405, { error: 'Usa POST' });
  leerBody(req).then(function(b){
    if (process.env.CONTA_TOKEN && req.headers['x-conta-token'] !== process.env.CONTA_TOKEN) return json(res, 401, { error: 'Clave de acceso incorrecta (Configuración → Facturación electrónica)' });
    var a = b.accion, d = b.datos || {};
    if (a === 'ping') return json(res, 200, { ok: true, alegra: alegraOK(), protegido: !!process.env.CONTA_TOKEN });
    if (a === 'alegra_test') {
      if (!alegraOK()) return json(res, 200, { error: 'Faltan ALEGRA_EMAIL y ALEGRA_TOKEN en Vercel' });
      return al('/company').then(function(c){ json(res, 200, { ok: true, empresa: (c && (c.name || c.identification)) || '' }); }).catch(function(e){ json(res, 200, { error: e.message }); });
    }
    if (a === 'alegra_factura') return emitir(d).then(function(r){ json(res, 200, r); }).catch(function(e){ json(res, 200, { error: e.message }); });
    json(res, 400, { error: 'Acción desconocida' });
  }).catch(function(e){ json(res, 500, { error: e.message }); });
};
