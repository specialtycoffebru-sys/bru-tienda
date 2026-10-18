// B.R.U · Pagos en línea con Wompi (Vercel, Node, sin dependencias)
// Variables de entorno (Vercel → Settings → Environment Variables):
//   WOMPI_PUBLIC_KEY        → llave pública (pub_prod_… o pub_test_…)
//   WOMPI_INTEGRITY_SECRET  → secreto de integridad (prod_integrity_… o test_integrity_…)
//   WOMPI_EVENTS_SECRET     → secreto de eventos (prod_events_… o test_events_…)
// URL de eventos para poner en el panel de Wompi: https://www.brucoffeeshop.online/api/wompi
var crypto = require('crypto');
var SB_URL = 'https://dzgtyazvqpdmwvwqpvco.supabase.co', SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_oWYjmVo0OBg5XbV4BDaSWQ_hOWH6czB';

function json(res, code, obj){ res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }
function leerBody(req){
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
  return new Promise(function(ok){ var d = ''; req.on('data', function(c){ d += c; }); req.on('end', function(){ try { ok(JSON.parse(d || '{}')); } catch (e) { ok({}); } }); });
}
function sha(s){ return crypto.createHash('sha256').update(s).digest('hex'); }
function sb(path, opts){
  opts = opts || {};
  var h = { apikey: SB_KEY, 'Content-Type': 'application/json' }; if (opts.prefer) h.Prefer = opts.prefer;
  return fetch(SB_URL + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(function(r){ if (!r.ok) throw new Error('Supabase ' + r.status); return r.status === 204 || r.status === 201 ? null : r.json(); });
}
function listo(){ return !!(process.env.WOMPI_PUBLIC_KEY && process.env.WOMPI_INTEGRITY_SECRET); }
function api(){ return /^pub_test_/.test(process.env.WOMPI_PUBLIC_KEY || '') ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1'; }

// Calcula el valor en el servidor (no se confía en el navegador) y firma la transacción
function firma(id){
  if (!listo()) return Promise.reject(new Error('Wompi no está configurado'));
  return Promise.all([
    sb('bru_conta?id=eq.' + encodeURIComponent(id) + '&tipo=eq.clase_res&select=id,data'),
    sb('bru_conta?id=eq.clasespub&select=data')
  ]).then(function(r){
    var res = (r[0] || []).filter(function(x){ return x.id === id; })[0]; if (!res) throw new Error('No encontramos la reserva');
    var pago = (r[1] && r[1][0] && r[1][0].data && r[1][0].data.pago) || {};
    var pct = Math.min(100, Math.max(1, Number(pago.anticipo) || 100));
    var valor = Math.round((Number(res.data.total) || 0) * pct / 100 / 100) * 100;
    if (valor < 1500) throw new Error('Valor inválido');
    var cents = valor * 100, ref = id + '-' + Date.now().toString(36);
    return { publicKey: process.env.WOMPI_PUBLIC_KEY, reference: ref, amountInCents: cents, currency: 'COP', signature: sha(ref + cents + 'COP' + process.env.WOMPI_INTEGRITY_SECRET), valor: valor, pct: pct };
  });
}
// Marca la reserva según el estado de la transacción
function aplicar(tx){
  var id = String(tx.reference || '').split('-')[0];
  if (!/^res_/.test(id)) return Promise.resolve({ ignorado: true });
  return sb('bru_conta?id=eq.' + encodeURIComponent(id) + '&select=id,tipo,fecha,data').then(function(r){
    var row = (r || []).filter(function(x){ return x.id === id; })[0]; if (!row) return { sinReserva: true };
    var d = row.data || {};
    d.pagoWompi = { id: tx.id, estado: tx.status, monto: Math.round((tx.amount_in_cents || 0) / 100), medio: tx.payment_method_type || '', fecha: new Date().toISOString() };
    if (tx.status === 'APPROVED') { d.pago = { reportado: true, verificado: true, metodo: 'Wompi · ' + (tx.payment_method_type || 'en línea'), monto: d.pagoWompi.monto, fecha: d.pagoWompi.fecha }; if (d.estado === 'nueva' || d.estado === 'confirmada' || !d.estado) d.estado = 'pagada'; }
    return sb('bru_conta?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: [{ id: row.id, tipo: row.tipo, fecha: row.fecha, data: d }] }).then(function(){ return { ok: true, estado: tx.status }; });
  });
}
// Verifica el evento que envía Wompi (checksum con el secreto de eventos)
function eventoValido(ev){
  var sec = process.env.WOMPI_EVENTS_SECRET; if (!sec || !ev || !ev.signature || !ev.data) return false;
  var cad = (ev.signature.properties || []).map(function(p){ return p.split('.').reduce(function(o, k){ return o == null ? '' : o[k]; }, ev.data); }).join('') + ev.timestamp + sec;
  return sha(cad).toLowerCase() === String(ev.signature.checksum || '').toLowerCase();
}

module.exports = function(req, res){
  if (req.method === 'GET') return json(res, 200, { ok: true, activo: listo(), prueba: /^pub_test_/.test(process.env.WOMPI_PUBLIC_KEY || '') });
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido' });
  leerBody(req).then(function(b){
    if (b && b.event) { // evento de Wompi
      if (!eventoValido(b)) return json(res, 401, { error: 'Firma inválida' });
      var tx = b.data && b.data.transaction; if (!tx) return json(res, 200, { ok: true });
      return aplicar(tx).then(function(r){ json(res, 200, r); }).catch(function(e){ json(res, 500, { error: e.message }); });
    }
    if (b.accion === 'firma') return firma(String(b.id || '')).then(function(r){ json(res, 200, r); }).catch(function(e){ json(res, 200, { error: e.message }); });
    if (b.accion === 'estado') { // el navegador consulta la transacción al volver del pago (respaldo si el evento tarda)
      return fetch(api() + '/transactions/' + encodeURIComponent(String(b.tx || ''))).then(function(r){ return r.json(); }).then(function(j){ var tx = j && j.data; if (!tx) return json(res, 200, { error: 'No encontrada' }); return aplicar(tx).then(function(){ json(res, 200, { estado: tx.status, monto: Math.round(tx.amount_in_cents / 100), medio: tx.payment_method_type }); }); }).catch(function(e){ json(res, 200, { error: e.message }); });
    }
    json(res, 400, { error: 'Acción desconocida' });
  });
};
