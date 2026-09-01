// Conexão read-only ao Postgres do Mural Financeiro (role mural_socio_readonly,
// só SELECT em v_socio_empresas e v_socio_lancamentos).
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.MURAL_DB_HOST,
  port: Number(process.env.MURAL_DB_PORT || 5432),
  database: process.env.MURAL_DB_NAME,
  user: process.env.MURAL_DB_USER,
  password: process.env.MURAL_DB_PASSWORD,
  ssl: process.env.MURAL_DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// Empresas que o sócio identificado por pessoaId pode ver.
// Fonte de verdade do isolamento por sócio — nada mais no app confia em outra coisa.
async function empresasDoSocio(pessoaId) {
  const { rows } = await pool.query(
    'SELECT DISTINCT empresa_id, empresa_nome FROM v_socio_empresas WHERE pessoa_id = $1',
    [pessoaId]
  );
  return rows;
}

// Lançamentos filtrados por uma lista de empresa_id já validada como subconjunto
// do que o sócio tem acesso (ver empresasDoSocio). Nunca aceitar SQL vindo da IA aqui.
async function lancamentos({ empresaIds, dataInicio, dataFim, natureza, limite = 200 }) {
  if (!Array.isArray(empresaIds) || empresaIds.length === 0) return [];

  const condicoes = ['empresa_id = ANY($1::uuid[])'];
  const params = [empresaIds];

  if (dataInicio) {
    params.push(dataInicio);
    condicoes.push(`data >= $${params.length}`);
  }
  if (dataFim) {
    params.push(dataFim);
    condicoes.push(`data <= $${params.length}`);
  }
  if (natureza) {
    params.push(natureza);
    condicoes.push(`natureza = $${params.length}`);
  }

  params.push(Math.min(Number(limite) || 200, 500));
  const sql = `
    SELECT id, empresa_id, empresa_nome, natureza, descricao, valor, data, status, criado_em
    FROM v_socio_lancamentos
    WHERE ${condicoes.join(' AND ')}
    ORDER BY data DESC
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query(sql, params);
  return rows;
}

// Todos os sócios com suas empresas, agrupados — usado só na página administrativa (/admin).
async function todosOsSocios() {
  const { rows } = await pool.query(
    'SELECT pessoa_id, pessoa_nome, empresa_nome FROM v_socio_empresas ORDER BY pessoa_nome, empresa_nome'
  );
  const porPessoa = new Map();
  for (const r of rows) {
    if (!porPessoa.has(r.pessoa_id)) {
      porPessoa.set(r.pessoa_id, { pessoaId: r.pessoa_id, pessoaNome: r.pessoa_nome, empresas: [] });
    }
    porPessoa.get(r.pessoa_id).empresas.push(r.empresa_nome);
  }
  return [...porPessoa.values()];
}

// Nome de um sócio específico por pessoa_id — usado pelo endpoint interno que o
// Mural Financeiro chama pra montar o link mágico direto do botão "Pergunte por voz".
async function nomeDoSocio(pessoaId) {
  const { rows } = await pool.query(
    'SELECT DISTINCT pessoa_nome FROM v_socio_empresas WHERE pessoa_id = $1 LIMIT 1',
    [pessoaId]
  );
  return rows[0]?.pessoa_nome || null;
}

module.exports = { pool, empresasDoSocio, lancamentos, todosOsSocios, nomeDoSocio };
