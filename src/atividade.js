// Registro local de atividade dos links dos sócios (cópia/envio pelo Robson e
// cliques do sócio no link mágico). Não vive no Postgres do Mural (role só tem
// SELECT). Usa node:sqlite (embutido no Node 24, sem dependência nativa extra
// pra compilar no Alpine) — arquivo em ./data, montado como volume no Docker
// pra sobreviver a `docker rm` + `docker run` de cada deploy (ver README).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.ATIVIDADE_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'atividade.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoa_id TEXT NOT NULL,
    pessoa_nome TEXT NOT NULL,
    link TEXT NOT NULL,
    enviado_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_envios_pessoa ON envios(pessoa_id);

  CREATE TABLE IF NOT EXISTS cliques (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoa_id TEXT NOT NULL,
    pessoa_nome TEXT NOT NULL,
    clicado_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cliques_pessoa ON cliques(pessoa_id);
`);

// Chamado quando o Robson copia (Copiar/Encurtar/Personalizar) o link de um sócio em
// /admin/socios — é a melhor aproximação de "quando eu mandei", já que o envio em si
// acontece fora do app (WhatsApp, manual).
function registrarEnvio({ pessoaId, pessoaNome, link }) {
  db.prepare('INSERT INTO envios (pessoa_id, pessoa_nome, link, enviado_em) VALUES (?, ?, ?, ?)').run(
    pessoaId,
    pessoaNome,
    link,
    new Date().toISOString()
  );
}

// Chamado a cada GET /s/:token válido — cada carregamento da página conta como um clique.
function registrarClique({ pessoaId, pessoaNome }) {
  db.prepare('INSERT INTO cliques (pessoa_id, pessoa_nome, clicado_em) VALUES (?, ?, ?)').run(
    pessoaId,
    pessoaNome,
    new Date().toISOString()
  );
}

// Último link copiado/enviado por pessoa (um registro por pessoa_id, o mais recente).
function ultimosEnviosPorPessoa() {
  return db
    .prepare(
      `SELECT pessoa_id, link, enviado_em
       FROM envios e
       WHERE enviado_em = (SELECT MAX(enviado_em) FROM envios WHERE pessoa_id = e.pessoa_id)
       GROUP BY pessoa_id`
    )
    .all();
}

// Total de cliques e data do último, por pessoa.
function cliquesPorPessoa() {
  return db
    .prepare(`SELECT pessoa_id, COUNT(*) as total, MAX(clicado_em) as ultimo FROM cliques GROUP BY pessoa_id`)
    .all();
}

module.exports = { registrarEnvio, registrarClique, ultimosEnviosPorPessoa, cliquesPorPessoa };
