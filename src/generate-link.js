// Uso: npm run link -- "Nome do sócio"
// Busca o sócio pelo nome em v_socio_empresas, gera um link assinado válido por 180 dias
// e imprime a URL pronta pra mandar manualmente (WhatsApp/e-mail).
require('dotenv').config();
const { pool } = require('./db');
const token = require('./token');

async function main() {
  const nomeBusca = process.argv.slice(2).join(' ').trim();
  if (!nomeBusca) {
    console.error('Uso: npm run link -- "Nome do sócio"');
    process.exit(1);
  }

  const { rows } = await pool.query(
    'SELECT DISTINCT pessoa_id, pessoa_nome FROM v_socio_empresas WHERE pessoa_nome ILIKE $1',
    [`%${nomeBusca}%`]
  );

  if (rows.length === 0) {
    console.error(`Nenhum sócio encontrado com nome parecido com "${nomeBusca}".`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error('Mais de um sócio encontrado, seja mais específico:');
    rows.forEach((r) => console.error(` - ${r.pessoa_nome} (id ${r.pessoa_id})`));
    process.exit(1);
  }

  const socio = rows[0];
  const exp = Date.now() + 180 * 24 * 60 * 60 * 1000; // 180 dias
  const t = token.sign({ pessoaId: socio.pessoa_id, pessoaNome: socio.pessoa_nome, exp });

  const base = process.env.BASE_URL || 'http://localhost:3200';
  console.log(`\nLink pra ${socio.pessoa_nome} (válido até ${new Date(exp).toLocaleDateString('pt-BR')}):`);
  console.log(`${base}/s/${t}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
