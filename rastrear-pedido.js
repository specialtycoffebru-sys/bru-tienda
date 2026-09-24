// api/rastrear-pedido.js
//
// Endpoint publico que la tienda usa para que un cliente rastree su propio
// pedido con su numero de telefono (el mismo que dejo al comprar). Usa la
// Service Role Key de Supabase (nunca se expone al navegador) para poder
// leer bru_pedidos aunque esa tabla no tenga lectura publica habilitada, y
// solo devuelve los pedidos que coinciden con el telefono que el cliente
// escribio -- nunca la tabla completa ni datos de otros clientes.
//
// Variable de entorno necesaria en Vercel (Settings -> Environment Variables):
//   SUPABASE_SERVICE_ROLE_KEY  -> Supabase: Project Settings -> API -> service_role key (secreta, NUNCA la publishable/anon)

var SB_URL = 'https://dzgtyazvqpdmwvwqpvco.supabase.co';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Solo POST' });
    return;
  }

  var tel = String((req.body && req.body.tel) || '').replace(/\D/g, '');
  if (tel.length < 7) {
    res.status(400).json({ ok: false, error: 'Numero de telefono invalido' });
    return;
  }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('Falta SUPABASE_SERVICE_ROLE_KEY en las variables de entorno');
    res.status(500).json({ ok: false, error: 'Falta configuracion del servidor' });
    return;
  }

  try {
    // Coincide si el telefono guardado TERMINA en los digitos que escribio el
    // cliente, para que no importe si quedo guardado con o sin indicativo de
    // pais (+57, 57, 0034, etc.).
    var url = SB_URL + '/rest/v1/bru_pedidos?tel=like.*' + encodeURIComponent(tel)
      + '&select=id,estado,guia,guia_url,created_at,items,total,ciudad,pago'
      + '&order=created_at.desc&limit=10';
    var r = await fetch(url, {
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Accept': 'application/json'
      }
    });
    if (!r.ok) {
      var txt = await r.text();
      console.error('Supabase respondio con error:', r.status, txt);
      res.status(502).json({ ok: false, error: 'No se pudo consultar el pedido' });
      return;
    }
    var rows = await r.json();
    res.status(200).json({ ok: true, pedidos: rows });
  } catch (err) {
    console.error('Error consultando pedido:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
};
