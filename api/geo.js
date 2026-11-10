// api/geo.js
// Vercel añade el país del visitante en la cabecera x-vercel-ip-country.
// Esta función solo lo devuelve para que la tienda (HTML estático) pueda leerlo.
// Va en la carpeta /api del repo: bru-tienda/api/geo.js

module.exports = function handler(req, res) {
  var pais = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ pais: pais }));
};
