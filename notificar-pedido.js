// api/notificar-pedido.js
//
// Supabase llama a esta funcion automaticamente cada vez que se inserta una
// fila nueva en la tabla bru_pedidos (via Database Webhooks). Esta funcion
// arma un mensaje con los datos del pedido y lo manda por Telegram al
// instante, sin que nadie tenga que estar mirando el dashboard.
//
// Variables de entorno necesarias en Vercel (Settings -> Environment Variables):
//   TELEGRAM_BOT_TOKEN   -> el token que te da @BotFather al crear el bot
//   TELEGRAM_CHAT_ID     -> el chat_id a donde se manda el aviso (puede ser
//                           tu chat personal o el de un grupo del equipo)
//   NOTIF_SECRET         -> (opcional pero recomendado) una palabra secreta
//                           propia, para que solo Supabase pueda llamar a
//                           esta funcion. Se manda como header x-notif-secret
//                           en la configuracion del webhook.

function fmtCOP(n) {
  var v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString('es-CO');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Solo POST');
    return;
  }
  // Si configuraste NOTIF_SECRET, exige que el webhook lo mande.
  var secretoEsperado = process.env.NOTIF_SECRET;
  if (secretoEsperado) {
    var secretoRecibido = req.headers['x-notif-secret'];
    if (secretoRecibido !== secretoEsperado) {
      res.status(401).send('No autorizado');
      return;
    }
  }

  var token = process.env.TELEGRAM_BOT_TOKEN;
  var chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en las variables de entorno');
    res.status(500).send('Falta configuracion de Telegram');
    return;
  }

  // El webhook de Supabase manda el body como { type, table, record, old_record }
  var body = req.body || {};
  var p = body.record || body || {};

  // Nombres reales de las columnas de bru_pedidos (confirmados en el dashboard):
  // cliente, tel, dir, pago, items, total, estado, ciudad.
  var nombre   = p.cliente || 'Cliente sin nombre';
  var telefono = p.tel || '';
  var direccion = p.dir || '';
  var ciudad   = p.ciudad || '';
  var total    = (p.total != null) ? p.total : null;
  var pago     = p.pago || '';
  var estado   = p.estado || 'Pendiente';
  var items    = p.items || null;

  var lineas = [];
  lineas.push('☕ *Pedido nuevo en B.R.U*');
  lineas.push('');
  lineas.push('*Cliente:* ' + nombre);
  if (telefono) lineas.push('*Whatsapp:* ' + telefono);
  if (total != null) lineas.push('*Total:* ' + fmtCOP(total));
  if (ciudad) lineas.push('*Ciudad:* ' + ciudad);
  if (direccion) lineas.push('*Dirección:* ' + direccion);
  if (pago) lineas.push('*Pago:* ' + pago);
  lineas.push('*Estado:* ' + estado);

  if (items) {
    var itemsTxt = '';
    try {
      var arr = typeof items === 'string' ? JSON.parse(items) : items;
      if (Array.isArray(arr)) {
        itemsTxt = arr.map(function (it) {
          var n = it.nombre || 'Item';
          var t = it.tamano ? ' (' + it.tamano + ')' : '';
          var c = it.qty || 1;
          return '• ' + n + t + ' x' + c;
        }).join('\n');
      }
    } catch (e) { /* si no se puede parsear, se omite el detalle */ }
    if (itemsTxt) {
      lineas.push('');
      lineas.push('*Productos:*');
      lineas.push(itemsTxt);
    }
  }

  lineas.push('');
  lineas.push('Revisalo en el dashboard.');

  var mensaje = lineas.join('\n');

  try {
    var tgUrl = 'https://api.telegram.org/bot' + token + '/sendMessage';
    var tgRes = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mensaje,
        parse_mode: 'Markdown'
      })
    });
    var tgData = await tgRes.json();
    if (!tgData.ok) {
      console.error('Telegram respondio con error:', tgData);
      res.status(502).json({ ok: false, telegram: tgData });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error enviando a Telegram:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
};
