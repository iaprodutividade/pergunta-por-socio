require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const token = require('./token');
const groq = require('./groq');
const openai = require('./openai');
const db = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// Middleware: valida o token do link mágico (header Authorization: Bearer <token>).
function autenticar(req, res, next) {
  const header = req.headers.authorization || '';
  const t = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = t && token.verify(t);
  if (!payload) return res.status(401).json({ erro: 'Link inválido ou expirado. Peça um novo link.' });
  req.socio = payload; // { pessoaId, pessoaNome, exp }
  next();
}

// Página do sócio: serve o app estático, o token fica só no client (localStorage), nunca em log de servidor.
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/api/me', autenticar, async (req, res) => {
  try {
    const empresas = await db.empresasDoSocio(req.socio.pessoaId);
    res.json({ nome: req.socio.pessoaNome, empresas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao carregar empresas do sócio.' });
  }
});

app.post('/api/ask', autenticar, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Áudio não recebido.' });

    const empresasPermitidas = await db.empresasDoSocio(req.socio.pessoaId);
    if (empresasPermitidas.length === 0) {
      return res.status(403).json({ erro: 'Nenhuma empresa vinculada a este sócio.' });
    }

    const pergunta = await groq.transcrever(req.file.buffer, req.file.mimetype, req.file.originalname || 'audio.webm');
    if (!pergunta) return res.status(422).json({ erro: 'Não entendi o áudio. Tente falar de novo.' });

    const interpretacao = await openai.interpretarPergunta(pergunta, empresasPermitidas);

    // Isolamento por sócio garantido AQUI: só aceita nomes que já estão na lista autorizada,
    // nunca confia no que o modelo devolveu além disso.
    const nomesPermitidos = new Set(empresasPermitidas.map((e) => e.empresa_nome));
    const empresasEscolhidas = (interpretacao.empresas || []).filter((nome) => nomesPermitidos.has(nome));
    const empresaIds = (
      empresasEscolhidas.length > 0
        ? empresasPermitidas.filter((e) => empresasEscolhidas.includes(e.empresa_nome))
        : empresasPermitidas
    ).map((e) => e.empresa_id);

    const registros = await db.lancamentos({
      empresaIds,
      dataInicio: interpretacao.data_inicio || null,
      dataFim: interpretacao.data_fim || null,
      natureza: interpretacao.natureza || null,
    });

    const contexto = {
      empresas_consultadas: empresasPermitidas.filter((e) => empresaIds.includes(e.empresa_id)).map((e) => e.empresa_nome),
      quantidade_lancamentos: registros.length,
      lancamentos: registros.slice(0, 50),
      aviso: interpretacao.pedido_tipo === 'saldo'
        ? 'Cálculo de saldo (extrato bancário + lançamentos) ainda não está disponível neste app — só lançamentos.'
        : null,
    };

    const respostaTexto = await openai.responderComDados(pergunta, contexto);

    res.json({ pergunta, resposta: respostaTexto, quantidade: registros.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao processar a pergunta.' });
  }
});

// Página administrativa (só o Robson, protegida por basic auth no Caddy — ver README) com os
// links de cada sócio prontos pra copiar e mandar por WhatsApp. Token estável (não muda a cada
// carregamento) pra ele poder comparar com o que já mandou antes.
app.get('/admin/socios', async (req, res) => {
  try {
    const socios = await db.todosOsSocios();
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const linhas = socios
      .map((s) => {
        const link = `${base}/s/${token.signStavel({ pessoaId: s.pessoaId, pessoaNome: s.pessoaNome })}`;
        return `
          <tr>
            <td>${s.pessoaNome}</td>
            <td>${s.empresas.join(', ')}</td>
            <td class="link-cell">
              <code id="link-${s.pessoaId}">${link}</code>
              <button onclick="copiar('link-${s.pessoaId}', this)">Copiar</button>
            </td>
          </tr>`;
      })
      .join('');

    res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Links dos sócios</title>
<style>
  body { background:#0b1220; color:#e8ecf5; font-family:-apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
  h1 { font-size:18px; color:#93a0bd; font-weight:600; }
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid #24304d; vertical-align:top; }
  th { color:#93a0bd; font-size:13px; font-weight:600; }
  code { background:#141d33; border:1px solid #24304d; border-radius:6px; padding:4px 8px; font-size:12px; word-break:break-all; }
  button { margin-left:8px; background:#3b82f6; color:white; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; }
  button.copiado { background:#22c55e; }
  .link-cell { max-width:420px; }
  .nota { color:#93a0bd; font-size:13px; margin-top:20px; }
</style>
</head>
<body>
  <h1>Links de acesso — Pergunta por sócio</h1>
  <table>
    <thead><tr><th>Sócio</th><th>Empresas</th><th>Link (copiar e mandar por WhatsApp)</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table>
  <p class="nota">Links estáveis — não expiram até 2030. O Robson não tem link próprio (já tem acesso direto ao Mural Financeiro).</p>
  <script>
    function copiar(id, btn) {
      const texto = document.getElementById(id).textContent;
      navigator.clipboard.writeText(texto).then(() => {
        btn.textContent = 'Copiado!';
        btn.classList.add('copiado');
        setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copiado'); }, 1500);
      });
    }
  </script>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Falha ao carregar sócios.');
  }
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => console.log(`pergunta-por-socio rodando na porta ${PORT}`));
