// Link mágico sem estado: token = payload base64url + assinatura HMAC-SHA256.
// Não precisa de banco local pra validar — só o TOKEN_SECRET.
const crypto = require('crypto');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload) {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error('TOKEN_SECRET não configurado');
  const body = b64urlEncode(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest();
  return `${body}.${b64urlEncode(mac)}`;
}

function verify(token) {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error('TOKEN_SECRET não configurado');
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;

  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
  return payload;
}

module.exports = { sign, verify };
