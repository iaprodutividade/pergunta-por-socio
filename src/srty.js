// Cliente do encurtador srty.com.br (Máquina 1) — chamado só server-side,
// nunca do navegador, pra não vazar a X-Api-Key no código-fonte da página.
const SRTY_API_URL = 'https://srty.com.br/api/links';

async function encurtarLink(longUrl) {
  const apiKey = process.env.SRTY_API_KEY;
  if (!apiKey) return longUrl;

  try {
    const resposta = await fetch(SRTY_API_URL, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ longUrl }),
    });
    if (!resposta.ok) return longUrl;

    const dados = await resposta.json();
    return dados.shortUrl || longUrl;
  } catch {
    return longUrl;
  }
}

module.exports = { encurtarLink };
