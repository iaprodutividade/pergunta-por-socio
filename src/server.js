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

    if (!interpretacao.pergunta_valida) {
      return res.json({
        pergunta,
        resposta: 'Não entendi uma pergunta sobre sua empresa aí. Pode repetir perguntando sobre lançamentos ou saldo?',
        quantidade: 0,
      });
    }

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

    // "status" (pendente/confirmado) é controle interno do escritório, não interessa ao sócio —
    // nem entra nos dados que a IA recebe, pra não ter risco de mencionar por engano.
    const lancamentosParaIA = registros.slice(0, 50).map(({ status, ...resto }) => resto);

    const contexto = {
      empresas_consultadas: empresasPermitidas.filter((e) => empresaIds.includes(e.empresa_id)).map((e) => e.empresa_nome),
      quantidade_lancamentos: registros.length,
      lancamentos: lancamentosParaIA,
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

// Fala a resposta em voz — só chamado quando o sócio toca no alto-falante, nunca automático.
app.post('/api/tts', autenticar, async (req, res) => {
  try {
    const texto = String(req.body?.texto || '').slice(0, 1000);
    if (!texto) return res.status(400).json({ erro: 'Texto vazio.' });

    const audio = await openai.sintetizarVoz(texto);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Falha ao gerar áudio.' });
  }
});

// Página administrativa (só o Robson, protegida por basic auth no Caddy — ver README) com os
// links de cada sócio prontos pra copiar e mandar por WhatsApp. Token estável (não muda a cada
// carregamento) pra ele poder comparar com o que já mandou antes.
app.get('/admin/socios', async (req, res) => {
  try {
    const socios = await db.todosOsSocios();
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const CORES = ['cor-0', 'cor-1', 'cor-2', 'cor-3'];
    const ICONE_PREDIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1"/></svg>';

    const cards = socios
      .map((s, i) => {
        const link = `${base}/s/${token.signStavel({ pessoaId: s.pessoaId, pessoaNome: s.pessoaNome })}`;
        const badges = s.empresas
          .map((nome, j) => `<span class="icone-selo ${CORES[j % 4]}" style="width:auto;height:auto;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;margin:0 6px 6px 0">${nome}</span>`)
          .join('');
        return `
          <div class="card-empresa" style="grid-column:1 / -1">
            <p class="nome-empresa" style="margin-bottom:10px">${s.pessoaNome}</p>
            <div style="display:flex;flex-wrap:wrap;margin-bottom:12px">${badges}</div>
            <div style="display:flex;align-items:center;gap:8px">
              <code id="link-${s.pessoaId}" style="flex:1;background:var(--card-grad-1);border:1px solid var(--card-borda);border-radius:8px;padding:6px 10px;font-size:11px;word-break:break-all;color:var(--texto-sec)">${link}</code>
              <button class="botao-mic" style="padding:8px 14px;flex-shrink:0" onclick="copiar('link-${s.pessoaId}', this)">Copiar</button>
            </div>
          </div>`;
      })
      .join('');

    res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Links dos sócios</title>
<link rel="stylesheet" href="/style.css" />
<style>.copiado { background: #22c55e !important; }</style>
</head>
<body>
  <div class="tela">
    <header class="topo">
      <div class="avatar">A</div>
      <div class="topo-textos">
        <p class="rotulo-topo">Mural Financeiro</p>
        <p class="titulo-topo">Links dos sócios</p>
      </div>
    </header>
    <p class="secao-rotulo">Copiar e mandar por WhatsApp</p>
    <div class="grid-empresas">${cards}</div>
    <p class="status" style="margin-top:8px">Links estáveis, não expiram até 2030. Você não tem link próprio — já tem acesso direto ao Mural Financeiro.</p>
  </div>
  <script>
    function copiar(id, btn) {
      const texto = document.getElementById(id).textContent;
      navigator.clipboard.writeText(texto).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copiado!';
        btn.classList.add('copiado');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('copiado'); }, 1500);
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
