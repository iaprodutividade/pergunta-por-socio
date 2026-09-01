// Transcrição de áudio via Groq Whisper. Mesmo padrão usado em Comunicação Direta.
async function transcrever(buffer, mimetype, filename) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY não configurada');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'pt');

  const resposta = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!resposta.ok) {
    throw new Error(`groq transcricao falhou (${resposta.status}): ${await resposta.text()}`);
  }
  const dados = await resposta.json();
  return (dados.text || '').trim();
}

module.exports = { transcrever };
