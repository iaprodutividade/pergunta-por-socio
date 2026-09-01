// Interpretação da pergunta e composição da resposta via OpenAI.
// Importante: o modelo nunca gera SQL nem decide sozinho quais empresas mostrar —
// ele só escolhe NOMES dentro da lista de empresas já autorizadas pro sócio (ver src/db.js
// e o filtro em server.js). Isso mantém o isolamento por sócio fora do alcance do prompt.

async function chamarOpenAI(messages, { json = false, maxTokens = 500 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada');

  const resposta = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!resposta.ok) {
    throw new Error(`openai falhou (${resposta.status}): ${await resposta.text()}`);
  }
  const dados = await resposta.json();
  return (dados.choices?.[0]?.message?.content || '').trim();
}

// pergunta: texto transcrito. empresasPermitidas: [{empresa_id, empresa_nome}] do sócio autenticado.
async function interpretarPergunta(pergunta, empresasPermitidas) {
  const nomes = empresasPermitidas.map((e) => e.empresa_nome);
  const hoje = new Date().toISOString().slice(0, 10);

  const prompt = `Você ajuda um sócio a consultar lançamentos financeiros da(s) empresa(s) dele.
Empresas que ESTE sócio pode consultar (não sugira nenhuma fora desta lista): ${JSON.stringify(nomes)}
Data de hoje: ${hoje}

Pergunta do sócio (transcrita por voz, pode ter erros de transcrição): "${pergunta}"

Responda em JSON com este formato exato:
{
  "empresas": ["nome exatamente como na lista, uma ou mais; vazio [] se a pergunta for sobre todas"],
  "data_inicio": "YYYY-MM-DD ou null",
  "data_fim": "YYYY-MM-DD ou null",
  "natureza": "string curta se a pergunta mencionar um tipo específico de lançamento, senão null",
  "texto_busca": "palavra-chave se a pergunta mencionar uma descrição específica, senão null",
  "pedido_tipo": "lancamentos ou saldo ou resumo"
}`;

  const bruto = await chamarOpenAI([{ role: 'user', content: prompt }], { json: true, maxTokens: 300 });
  return JSON.parse(bruto);
}

// contexto: { empresas: [...], lancamentos: [...], avisos: [...] }
async function responderComDados(pergunta, contexto) {
  const prompt = `Pergunta original do sócio: "${pergunta}"

Dados encontrados (já filtrados só pelo que este sócio pode ver):
${JSON.stringify(contexto, null, 2)}

Responda em português, em 2 a 4 frases, tom direto e falado (a resposta vai ser lida em voz alta por síntese de voz).
Se não houver lançamentos, diga isso claramente. Não invente números fora dos dados acima.
Se houver algum aviso nos dados (ex: extrato desatualizado), mencione por último.`;

  return chamarOpenAI([{ role: 'user', content: prompt }], { maxTokens: 300 });
}

module.exports = { interpretarPergunta, responderComDados };
