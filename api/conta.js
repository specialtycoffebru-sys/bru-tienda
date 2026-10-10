// B.R.U · Contabilidad — servidor (Vercel, Node, sin dependencias)
// Variables de entorno (Vercel → Settings → Environment Variables):
//   ALEGRA_EMAIL, ALEGRA_TOKEN       → para emitir facturas electrónicas por Alegra
//   ALEGRA_NUMERACION (opcional)     → id de la numeración de factura electrónica en Alegra
//   ANTHROPIC_API_KEY (opcional)     → agente contable y lectura de PDF escaneados y fotos con IA (ANTHROPIC_MODEL para cambiar el modelo)
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

// ---------- Lectura de documentos con IA ----------
var PROMPT = 'Eres asistente contable en Colombia. Extrae los datos de este documento (factura electrónica, factura POS o tiquete, cuenta de cobro, recibo). ' +
  'Responde SOLO con un objeto JSON, sin texto antes ni después, con esta forma exacta:\n' +
  '{"tipo":"factura|tiquete|cuenta_cobro|nota_credito|otro","numero":"","fecha":"YYYY-MM-DD","vence":"YYYY-MM-DD o null","cufe":"96 caracteres o null",' +
  '"forma":"contado|credito","emisor":{"nombre":"","nit":"solo dígitos sin DV","dv":"","persona":"J|N","email":"","dir":"","ciudad":"","tel":"","respIVA":true},' +
  '"receptor":{"nombre":"","nit":""},"items":[{"desc":"","cant":1,"precio":0,"iva_pct":0,"total":0}],"subtotal":0,"iva":[{"pct":19,"base":0,"valor":0}],' +
  '"impoconsumo":0,"retenciones":[{"tipo":"ReteFuente|ReteIVA|ReteICA","valor":0}],"total":0,' +
  '"categoria":"cafe|insumos|mercancia|servicios|honorarios|arriendo|transporte|publicidad|publicos|mantenimiento|papeleria|equipo|bancario|otro",' +
  '"descripcion":"resumen corto de lo comprado","confianza":"alta|media|baja","nota":"advertencia corta si algo no se lee bien, o vacío"}\n' +
  'Reglas: números sin separador de miles y con punto decimal; precio y total de cada ítem SIN IVA; subtotal = base antes de IVA; ' +
  'emisor = quien vende o cobra; receptor = quien compra; categoria "cafe" solo para café verde, pergamino o cereza; si un dato no aparece usa null.';
function leerIA(d){
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.reject(new Error('Falta ANTHROPIC_API_KEY en Vercel'));
  var arch = (d.archivos || []).slice(0, 4);
  if (!arch.length) return Promise.reject(new Error('No llegó el archivo'));
  var content = arch.map(function(a){
    if (a.tipo === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } };
    return { type: 'image', source: { type: 'base64', media_type: /^image\/(jpeg|png|gif|webp)$/.test(a.tipo) ? a.tipo : 'image/jpeg', data: a.data } };
  });
  content.push({ type: 'text', text: PROMPT + (d.nombre ? '\nNombre del archivo: ' + d.nombre : '') });
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 3000, messages: [{ role: 'user', content: content }] })
  }).then(function(r){ return r.text().then(function(t){
    var j = null; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok) throw new Error('IA: ' + ((j && j.error && j.error.message) || ('error ' + r.status)));
    var txt = (j.content || []).filter(function(c){ return c.type === 'text'; }).map(function(c){ return c.text; }).join('');
    var a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('La IA no devolvió datos legibles');
    var datos; try { datos = JSON.parse(txt.slice(a, b + 1)); } catch (e) { throw new Error('La IA devolvió datos incompletos'); }
    return { ok: true, datos: datos };
  }); });
}

// ---------- Agente contable (la página ejecuta las herramientas sobre sus datos) ----------
var CATS_ENUM = ['cafe','insumos','mercancia','servicios','honorarios','arriendo','transporte','publicidad','publicos','mantenimiento','papeleria','equipo','bancario','otro'];
var TERCERO = { type: 'object', properties: { nombre: {type:'string'}, nit: {type:'string', description:'solo dígitos, sin DV'}, dv: {type:'string'}, persona: {type:'string', enum:['J','N']}, email: {type:'string'}, dir: {type:'string'}, ciudad: {type:'string'}, tel: {type:'string'}, respIVA: {type:'boolean'} }, required: ['nombre'] };
var TOOLS = [
  { name: 'ver_resumen', description: 'Cifras principales: ventas, costos, gastos, utilidad, caja y bancos, cuentas por cobrar y pagar, inventarios, IVA y retenciones por pagar, y lista de pendientes y alertas.', input_schema: { type: 'object', properties: { desde: {type:'string', description:'YYYY-MM-DD (por defecto inicio del año)'}, hasta: {type:'string', description:'YYYY-MM-DD (por defecto hoy)'} } } },
  { name: 'estado_resultados', description: 'Estado de resultados por grupos de cuentas en un rango de fechas.', input_schema: { type: 'object', properties: { desde: {type:'string'}, hasta: {type:'string'} }, required: ['desde','hasta'] } },
  { name: 'balance_prueba', description: 'Saldos de todas las cuentas con movimiento hasta una fecha.', input_schema: { type: 'object', properties: { hasta: {type:'string'} } } },
  { name: 'consultar_cuenta', description: 'Saldo y últimos movimientos de una cuenta del PUC (acepta prefijo, ej. 1105 o 5135).', input_schema: { type: 'object', properties: { cuenta: {type:'string'}, desde: {type:'string'}, hasta: {type:'string'} }, required: ['cuenta'] } },
  { name: 'listar_documentos', description: 'Lista compras o facturas de venta registradas.', input_schema: { type: 'object', properties: { tipo: {type:'string', enum:['compra','factura']}, desde: {type:'string'}, hasta: {type:'string'}, texto: {type:'string', description:'filtra por tercero, número o concepto'}, limite: {type:'number'} }, required: ['tipo'] } },
  { name: 'buscar_tercero', description: 'Busca clientes, proveedores o empleados por nombre o NIT.', input_schema: { type: 'object', properties: { texto: {type:'string'} }, required: ['texto'] } },
  { name: 'impuestos', description: 'Calcula IVA por periodo de un año, retención en la fuente de un mes o ICA de un rango.', input_schema: { type: 'object', properties: { impuesto: {type:'string', enum:['iva','retencion','ica']}, anio: {type:'number'}, mes: {type:'string', description:'YYYY-MM para retención'}, desde: {type:'string'}, hasta: {type:'string'} }, required: ['impuesto'] } },
  { name: 'vencimientos', description: 'Obligaciones DIAN, nómina y legales vencidas o próximas (60 días).', input_schema: { type: 'object', properties: {} } },
  { name: 'pendientes_dashboard', description: 'Operaciones registradas en el dashboard (ventas, gastos, compras de café) que aún no están contabilizadas.', input_schema: { type: 'object', properties: {} } },
  { name: 'datos_dashboard', description: 'Lee el dashboard de la tienda: inventario de café verde, productos y precios por presentación, compras de café verde (kg y precio/kg), insumos (stock y costo unitario), compras de insumos, ventas y ventas externas (cantidades por producto), gastos, y los gastos automáticos que son espejo de otra operación (duplicados) con el comprobante donde quedaron contabilizados.', input_schema: { type: 'object', properties: {} } },
  { name: 'listar_comprobantes', description: 'Busca comprobantes contables por texto, tipo (FV, FC, CE, RC, AJ, DS...) o fechas.', input_schema: { type: 'object', properties: { texto: {type:'string'}, comp: {type:'string'}, desde: {type:'string'}, hasta: {type:'string'}, incluir_anulados: {type:'boolean'}, limite: {type:'number'} } } },
  { name: 'anular_comprobante', description: 'Anula un comprobante contable (por ejemplo un gasto duplicado). No borra: queda marcado como anulado y deja de contar.', input_schema: { type: 'object', properties: { comp: {type:'string'}, num: {type:'number'}, motivo: {type:'string'} }, required: ['comp','num','motivo'] } },
  { name: 'actualizar_empresa', description: 'Actualiza los datos de la empresa (por ejemplo, leídos del RUT). Solo envía los campos que cambian.', input_schema: { type: 'object', properties: { campos: { type: 'object', properties: {
      razon: {type:'string'}, nit: {type:'string', description:'sin DV'}, persona: {type:'string', enum:['J','N']}, regimen: {type:'string', enum:['ordinario','simple']}, simpleGrupo: {type:'number'},
      ciiu: {type:'string'}, ciudad: {type:'string'}, direccion: {type:'string'}, email: {type:'string'}, tel: {type:'string'},
      respIVA: {type:'boolean', description:'responsabilidad 48'}, ivaPeriodo: {type:'string', enum:['bimestral','cuatrimestral']}, agenteRet: {type:'boolean', description:'responsabilidad 07'},
      autoret: {type:'boolean'}, fechaInicio: {type:'string'} } } }, required: ['campos'] } },
  { name: 'registrar_compra', description: 'Registra y contabiliza una compra o gasto con su factura o soporte. Calcula sola la retención según la tabla vigente. No registra duplicados.', input_schema: { type: 'object', properties: {
      proveedor: TERCERO, fecha: {type:'string'}, numero: {type:'string'}, cufe: {type:'string'}, tipo_documento: {type:'string', enum:['factura','tiquete','cuenta_cobro','otro']},
      categoria: {type:'string', enum: CATS_ENUM}, subtotal: {type:'number', description:'base antes de IVA'}, iva: {type:'number'}, iva_pct: {type:'number'}, impoconsumo: {type:'number'},
      forma: {type:'string', enum:['credito','banco','caja']}, vence: {type:'string'}, descripcion: {type:'string'} }, required: ['proveedor','fecha','subtotal','categoria'] } },
  { name: 'registrar_venta_emitida', description: 'Registra una factura de venta que la empresa ya emitió por fuera (portal DIAN u otro programa), con su número y CUFE.', input_schema: { type: 'object', properties: {
      cliente: TERCERO, fecha: {type:'string'}, numero: {type:'string'}, cufe: {type:'string'}, items: { type: 'array', items: { type: 'object', properties: { desc: {type:'string'}, cant: {type:'number'}, precio: {type:'number', description:'sin IVA'}, iva_pct: {type:'number'} } } },
      subtotal: {type:'number'}, iva: {type:'number'}, iva_pct: {type:'number'}, total: {type:'number'}, forma: {type:'string', enum:['credito','banco','caja']}, vence: {type:'string'} }, required: ['cliente','fecha','numero','total'] } },
  { name: 'crear_comprobante', description: 'Crea un comprobante contable manual (ajuste) en partida doble. Débitos y créditos deben sumar igual. Usa cuentas auxiliares de 6 dígitos del plan.', input_schema: { type: 'object', properties: {
      fecha: {type:'string'}, descripcion: {type:'string'}, lineas: { type: 'array', items: { type: 'object', properties: { cuenta: {type:'string'}, debito: {type:'number'}, credito: {type:'number'}, nit_tercero: {type:'string'} }, required: ['cuenta'] } } }, required: ['fecha','descripcion','lineas'] } },
  { name: 'contabilizar_dashboard', description: 'Contabiliza todas las operaciones pendientes del dashboard.', input_schema: { type: 'object', properties: {} } },
  { name: 'crear_tercero', description: 'Crea o completa un cliente, proveedor o empleado.', input_schema: { type: 'object', properties: { tercero: TERCERO, rol: {type:'string', enum:['cliente','proveedor','empleado']} }, required: ['tercero','rol'] } }
];
var SISTEMA = 'Eres el agente contable de la empresa (café de especialidad en Colombia). Actúas como un contador público experto en normativa colombiana: PUC, NIIF para microempresas (Grupo 3), Estatuto Tributario, facturación electrónica DIAN, retención en la fuente, IVA, ICA Bogotá, régimen SIMPLE, nómina y exógena.\n' +
  'Trabajas sobre la contabilidad real del usuario mediante herramientas. Las de consulta se ejecutan de inmediato; las que registran algo pasan por la aprobación del usuario.\n' +
  'Reglas:\n- Responde en español, breve y claro, sin tecnicismos innecesarios. Usa pesos colombianos.\n' +
  '- Nunca inventes datos. Si un documento no se lee bien o falta algo esencial, dilo y pregunta.\n' +
  '- RUT: extrae razón social, NIT (sin DV), tipo de persona (casilla 24: 1 jurídica, 2 natural), dirección, ciudad, correo, teléfono, actividad principal CIIU (casilla 46) y responsabilidades (casilla 53): 05 = renta régimen ordinario, 47 = régimen SIMPLE, 48 = responsable de IVA, 49 = no responsable de IVA, 07 = agente de retención en la fuente, 52 = facturador electrónico, 42 = obligado a llevar contabilidad, 14 = informante de exógena. Luego llama actualizar_empresa con lo que cambie y explica en una línea qué implica cada responsabilidad.\n' +
  '- Facturas o soportes: por cada documento verifica que esté a nombre de la empresa, extrae los datos y llama registrar_compra (o registrar_venta_emitida si el emisor es la propia empresa). Clasifica bien la categoría. Si el documento es una cuenta de cobro de persona no obligada a facturar, usa tipo_documento cuenta_cobro (genera documento soporte).\n' +
  '- Los valores de subtotal e IVA salen del documento; no los recalcules si el documento los trae.\n' +
  '- Al terminar, resume lo que hiciste y lo que queda pendiente (por ejemplo, vencimientos cercanos).\n' +
  '- Organizar la contabilidad (cuando te lo pidan): 1) contabiliza lo pendiente del dashboard; 2) usa datos_dashboard y anula los gastos espejo que ya quedaron contabilizados (duplican compras de insumos o comisiones ya descontadas); 3) cruza compras de café verde, ventas por producto e insumos con el conteo físico que dé el usuario para calcular el costo de ventas (inventario periódico: inventario inicial + compras − inventario final), valorando el café tostado al costo del verde ajustado por la merma de tostión más el empaque y la etiqueta; si falta la merma u otro dato clave, propón un valor razonable (por ejemplo 16 % de merma) y pide confirmación antes de registrar; 4) registra el costo de ventas con crear_comprobante (débito 612001, créditos a 140505 café verde y 140510 insumos según corresponda; si queda café tostado, llévalo a 143005); 5) revisa IVA, retenciones y vencimientos y termina con un resumen claro de lo hecho y lo pendiente.\n' +
  '- No das asesoría legal definitiva: para decisiones de alto impacto recomienda validar con el contador.';
function agente(d){
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Promise.reject(new Error('Falta ANTHROPIC_API_KEY en Vercel (Configuración → Facturación electrónica explica cómo crearla)'));
  var msgs = Array.isArray(d.messages) ? d.messages : [];
  if (!msgs.length) return Promise.reject(new Error('Sin mensajes'));
  var sys = SISTEMA + '\n\nContexto actual de la contabilidad:\n' + String(d.contexto || '').slice(0, 24000);
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 16000, system: sys, tools: TOOLS, messages: msgs })
  }).then(function(r){ return r.text().then(function(t){
    var j = null; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok) throw new Error('IA: ' + ((j && j.error && j.error.message) || ('error ' + r.status)));
    return { ok: true, content: j.content || [], stop_reason: j.stop_reason, usage: j.usage || null };
  }); });
}

module.exports = function(req, res){
  if (req.method === 'OPTIONS') { res.setHeader('Allow', 'POST'); return json(res, 204, {}); }
  if (req.method === 'GET') return json(res, 200, { ok: true, version: 5, alegra: alegraOK(), ia: !!process.env.ANTHROPIC_API_KEY, agente: true });
  if (req.method !== 'POST') return json(res, 405, { error: 'Usa POST' });
  leerBody(req).then(function(b){
    if (process.env.CONTA_TOKEN && req.headers['x-conta-token'] !== process.env.CONTA_TOKEN) return json(res, 401, { error: 'Clave de acceso incorrecta (Configuración → Facturación electrónica)' });
    var a = b.accion, d = b.datos || {};
    if (a === 'ping') return json(res, 200, { ok: true, version: 5, alegra: alegraOK(), ia: !!process.env.ANTHROPIC_API_KEY, protegido: !!process.env.CONTA_TOKEN });
    if (a === 'alegra_test') {
      if (!alegraOK()) return json(res, 200, { error: 'Faltan ALEGRA_EMAIL y ALEGRA_TOKEN en Vercel' });
      return al('/company').then(function(c){ json(res, 200, { ok: true, empresa: (c && (c.name || c.identification)) || '' }); }).catch(function(e){ json(res, 200, { error: e.message }); });
    }
    if (a === 'leer_documento') return leerIA(d).then(function(r){ json(res, 200, r); }).catch(function(e){ json(res, 200, { error: e.message }); });
    if (a === 'agente') return agente(d).then(function(r){ json(res, 200, r); }).catch(function(e){ json(res, 200, { error: e.message }); });
    if (a === 'alegra_factura') return emitir(d).then(function(r){ json(res, 200, r); }).catch(function(e){ json(res, 200, { error: e.message }); });
    json(res, 400, { error: 'Acción desconocida' });
  }).catch(function(e){ json(res, 500, { error: e.message }); });
};
module.exports.config = { maxDuration: 300 };
