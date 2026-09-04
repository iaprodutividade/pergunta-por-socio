// Cliente do encurtador srty.com.br (Máquina 1) — chamado só server-side,
// nunca do navegador, pra não vazar a X-Api-Key no código-fonte da página.
const SRTY_API_URL = 'https://srty.com.br/api/links';

async function encurtarLink(longUrl, customSlug) {
  const apiKey = process.env.SRTY_API_KEY;
  if (!apiKey) return { ok: false, erro: 'Encurtador não configurado.' };

  try {
    const body = { longUrl };
    if (customSlug) body.customSlug = customSlug;

    const resposta = await fetch(SRTY_API_URL, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) return { ok: false, erro: dados.erro || 'Não deu pra encurtar agora.' };
    return { ok: true, shortUrl: dados.shortUrl };
  } catch {
    return { ok: false, erro: 'Não deu pra encurtar agora.' };
  }
}

module.exports = { encurtarLink };
