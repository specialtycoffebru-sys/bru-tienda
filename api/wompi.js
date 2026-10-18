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

// Costo de la pasarela: se suma al cliente para que a la cuenta llegue el valor completo
var FEE_DEF = { trasladar: true, pct: 2.99, fijo: 600, iva: 19 };
function feeCfg(pago){ var f = (pago && pago.pasarela) || {}; return { trasladar: f.trasladar !== false, pct: f.pct == null ? FEE_DEF.pct : Number(f.pct), fijo: f.fijo == null ? FEE_DEF.fijo : Number(f.fijo), iva: f.iva == null ? FEE_DEF.iva : Number(f.iva) }; }
function bruto(neto, f){ if (!f.trasladar) return neto; var t = 1 + f.iva / 100; return Math.ceil((neto + f.fijo * t) / (1 - f.pct / 100 * t) / 100) * 100; }
function pagoPub(doc){ return sb('bru_conta?id=eq.' + (doc || 'clasespub') + '&select=data').then(function(r){ return (r && r[0] && r[0].data && r[0].data.pago) || {}; }).catch(function(){ return {}; }); }

// Calcula el valor en el servidor (no se confía en el navegador) y firma la transacción
function firma(id){
  if (!listo()) return Promise.reject(new Error('Wompi no está configurado'));
  var esPed = /^ped_/.test(id);
  if (!/^(res|ped|evt)_[a-z0-9]+$/.test(id)) return Promise.reject(new Error('Referencia inválida'));
  return Promise.all([sb('bru_conta?id=eq.' + encodeURIComponent(id) + '&select=id,tipo,data'), pagoPub(), /^evt_/.test(id) ? pagoPub('eventospub') : null]).then(function(r){
    var row = (r[0] || []).filter(function(x){ return x.id === id; })[0]; if (!row) throw new Error(esPed ? 'No encontramos el pedido' : 'No encontramos la reserva');
    var pago = r[1], pctSrc = r[2] || pago, pct = esPed ? 100 : Math.min(100, Math.max(1, Number(pctSrc.anticipo) || 100));
    var neto = Math.round((Number(row.data.total) || 0) * pct / 100 / 100) * 100;
    if (neto < 1500) throw new Error('Valor inválido');
    var f = feeCfg(pago), valor = bruto(neto, f), cents = valor * 100, ref = id + '-' + Date.now().toString(36);
    return { publicKey: process.env.WOMPI_PUBLIC_KEY, reference: ref, amountInCents: cents, currency: 'COP', signature: sha(ref + cents + 'COP' + process.env.WOMPI_INTEGRITY_SECRET), valor: valor, neto: neto, costo: valor - neto, pct: pct };
  });
}
// Venta para el sistema contable: queda en bru_conta como 'venta_web' (una sola vez por pago).
// El dashboard la pasa a Ventas al abrir y de ahí entra a Contabilidad → Importar.
function hoyBog(){ return new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); }
function registrarVenta(row, d, tx){
  var id = row.id, ped = /^ped_/.test(id), evt = /^evt_/.test(id);
  return Promise.all([pagoPub(), evt ? pagoPub('eventospub') : null]).then(function(r){
    var pctSrc = r[1] || r[0], pct = ped ? 100 : Math.min(100, Math.max(1, Number(pctSrc.anticipo) || 100));
    var neto = Math.round((Number(d.total) || 0) * pct / 100 / 100) * 100, cob = d.pagoWompi.monto, lineas = [];
    if (ped) { (d.items || []).forEach(function(it){ lineas.push({ prod: (it.nombre || 'Producto') + (it.tamano ? ' ' + it.tamano : ''), qty: Number(it.qty) || 1, precio: Number(it.precio) || 0 }); }); if (Number(d.envio)) lineas.push({ prod: 'Envío', qty: 1, precio: Number(d.envio) }); }
    else lineas.push({ prod: (evt ? 'Evento · ' : 'Clase · ') + (d.clase || '') + (pct < 100 ? ' (anticipo ' + pct + ' %)' : ''), qty: 1, precio: neto });
    var suma = lineas.reduce(function(s, l){ return s + l.qty * l.precio; }, 0);
    if (!lineas.length || Math.abs(suma - neto) > 1) lineas = [{ prod: (ped ? 'Pedido tienda ' : '') + (d.ref || id), qty: 1, precio: neto }];
    var doc = { id: 'vw_' + id, tipo: 'venta_web', fecha: hoyBog(), data: { ref: id, origen: ped ? 'Tienda' : (evt ? 'Evento' : 'Clase'), cliente: d.cliente || d.nombre || '', tel: d.tel || d.telefono || '', lineas: lineas, neto: neto, cobrado: cob, comision: Math.max(0, cob - neto), medio: 'Wompi · ' + (tx.payment_method_type || 'en línea'), tx: tx.id, creado: new Date().toISOString() } };
    return sb('bru_conta?on_conflict=id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: [doc] });
  }).catch(function(){});
}
// Marca la reserva o el pedido según el estado de la transacción
function aplicar(tx){
  var id = String(tx.reference || '').split('-')[0];
  if (!/^(res|ped|evt)_/.test(id)) return Promise.resolve({ ignorado: true });
  return sb('bru_conta?id=eq.' + encodeURIComponent(id) + '&select=id,tipo,fecha,data').then(function(r){
    var row = (r || []).filter(function(x){ return x.id === id; })[0]; if (!row) return { sinRegistro: true };
    var d = row.data || {}, ya = d.pago && d.pago.verificado;
    d.pagoWompi = { id: tx.id, estado: tx.status, monto: Math.round((tx.amount_in_cents || 0) / 100), medio: tx.payment_method_type || '', fecha: new Date().toISOString() };
    if (tx.status === 'APPROVED') { d.pago = { reportado: true, verificado: true, metodo: 'Wompi · ' + (tx.payment_method_type || 'en línea'), monto: d.pagoWompi.monto, fecha: d.pagoWompi.fecha }; if (/^(res|evt)_/.test(id) && (d.estado === 'nueva' || d.estado === 'confirmada' || !d.estado)) d.estado = 'pagada'; if (/^ped_/.test(id)) d.estado = 'pagado'; }
    return sb('bru_conta?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: [{ id: row.id, tipo: row.tipo, fecha: row.fecha, data: d }] }).then(function(){
      return tx.status === 'APPROVED' && !/_prueba/.test(row.tipo || '') ? registrarVenta(row, d, tx) : null;
    }).then(function(){
      if (!/^ped_/.test(id) || tx.status !== 'APPROVED' || ya) return { ok: true, estado: tx.status };
      // Marca también el pedido en la tabla de pedidos de la tienda
      var refTxt = id.replace('ped_', 'PED-').toUpperCase();
      return sb('bru_pedidos?notas=like.*' + encodeURIComponent(refTxt) + '*&select=id,notas').then(function(pp){
        return Promise.all((pp || []).map(function(p){ return sb('bru_pedidos?id=eq.' + p.id, { method: 'PATCH', prefer: 'return=minimal', body: { estado: 'Confirmado', notas: String(p.notas || '').replace(/ · ⏳ Pago en línea pendiente/, '') + ' · ✅ PAGADO en línea (Wompi ' + (tx.payment_method_type || '') + ') ' + d.pagoWompi.monto } }).catch(function(){}); }));
      }).catch(function(){}).then(function(){ return { ok: true, estado: tx.status }; });
    });
  });
}
// Verifica el evento que envía Wompi (checksum con el secreto de eventos)
function eventoValido(ev){
  var sec = process.env.WOMPI_EVENTS_SECRET; if (!sec || !ev || !ev.signature || !ev.data) return false;
  var cad = (ev.signature.properties || []).map(function(p){ return p.split('.').reduce(function(o, k){ return o == null ? '' : o[k]; }, ev.data); }).join('') + ev.timestamp + sec;
  return sha(cad).toLowerCase() === String(ev.signature.checksum || '').toLowerCase();
}

module.exports = function(req, res){
  if (req.method === 'GET') return pagoPub().then(function(p){ json(res, 200, { ok: true, activo: listo(), prueba: /^pub_test_/.test(process.env.WOMPI_PUBLIC_KEY || ''), fee: feeCfg(p) }); });
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
