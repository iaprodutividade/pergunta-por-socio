(function () {
  const botao = document.getElementById('botaoMic');
  const status = document.getElementById('status');
  const cartao = document.getElementById('cartaoResposta');
  const perguntaTexto = document.getElementById('perguntaTexto');
  const respostaTexto = document.getElementById('respostaTexto');
  const avatar = document.getElementById('avatar');
  const tituloTopo = document.getElementById('tituloTopo');
  const gridEmpresas = document.getElementById('gridEmpresas');
  const botaoOuvir = document.getElementById('botaoOuvir');
  const iconeOuvir = botaoOuvir.querySelector('.icone-ouvir');
  const iconeParar = botaoOuvir.querySelector('.icone-parar');
  const textoBotaoOuvir = document.getElementById('textoBotaoOuvir');

  // Tema (claro/intermediário/escuro) — mesmo esquema do Hub, persiste por
  // navegador, não sincroniza entre dispositivos. Escuro é o padrão, sem atributo.
  const botoesTema = document.querySelectorAll('.botao-tema');
  function aplicarTema(tema) {
    if (tema === 'claro' || tema === 'intermediario') {
      document.documentElement.setAttribute('data-theme', tema);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    botoesTema.forEach((b) => b.classList.toggle('ativo', b.dataset.tema === tema));
    localStorage.setItem('tema', tema);
  }
  botoesTema.forEach((b) => b.addEventListener('click', () => aplicarTema(b.dataset.tema)));
  aplicarTema(localStorage.getItem('tema') || 'escuro');

  const ICONE_PREDIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1"/></svg>';

  // O token vem na URL (/s/<token>) só na primeira visita; depois fica salvo local
  // pra funcionar como PWA instalado (sem repetir o link toda vez).
  const partesUrl = window.location.pathname.split('/');
  const tokenDaUrl = partesUrl[1] === 's' ? partesUrl[2] : null;
  if (tokenDaUrl) {
    localStorage.setItem('token', tokenDaUrl);
    window.history.replaceState({}, '', '/');
  }
  const token = localStorage.getItem('token');

  if (!token) {
    status.textContent = 'Link inválido. Peça um novo link.';
    botao.disabled = true;
    return;
  }

  let mediaRecorder = null;
  let chunks = [];
  let estado = 'ocioso'; // ocioso | gravando | processando

  async function carregarSocio() {
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('sessao invalida');
      const dados = await r.json();

      const nome = dados.nome || '';
      avatar.textContent = nome.charAt(0).toUpperCase() || '?';
      tituloTopo.innerHTML = `Olá, <b>${nome}</b>`;

      gridEmpresas.innerHTML = (dados.empresas || [])
        .map((e, i) => `
          <div class="card-empresa">
            <div class="icone-selo cor-${i % 4}">${ICONE_PREDIO}</div>
            <p class="nome-empresa">${e.empresa_nome}</p>
          </div>`)
        .join('');
    } catch {
      status.textContent = 'Link expirado ou inválido. Peça um novo link.';
      botao.disabled = true;
    }
  }

  // Áudio da resposta é gerado sob demanda (OpenAI TTS), só quando o sócio toca "Ouvir".
  // Nunca toca sozinho — combinado com o Robson depois de reclamação sobre a voz do navegador.
  let audioAtual = null;

  function pararAudio() {
    if (audioAtual) {
      audioAtual.pause();
      audioAtual = null;
    }
    iconeOuvir.classList.remove('oculto');
    iconeParar.classList.add('oculto');
    textoBotaoOuvir.textContent = 'Ouvir';
    botaoOuvir.classList.remove('tocando');
  }

  async function tocarResposta(texto) {
    if (audioAtual) { pararAudio(); return; }

    botaoOuvir.disabled = true;
    textoBotaoOuvir.textContent = 'Carregando...';
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto }),
      });
      if (!r.ok) throw new Error('falha ao gerar áudio');

      const blob = await r.blob();
      audioAtual = new Audio(URL.createObjectURL(blob));
      audioAtual.onended = pararAudio;
      audioAtual.play();

      iconeOuvir.classList.add('oculto');
      iconeParar.classList.remove('oculto');
      textoBotaoOuvir.textContent = 'Parar';
      botaoOuvir.classList.add('tocando');
    } catch {
      textoBotaoOuvir.textContent = 'Ouvir';
    } finally {
      botaoOuvir.disabled = false;
    }
  }

  async function iniciarGravacao() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      enviarPergunta(new Blob(chunks, { type: 'audio/webm' }));
    };
    mediaRecorder.start();
    estado = 'gravando';
    botao.classList.add('gravando');
    status.textContent = 'Gravando... toque de novo pra parar';
  }

  function pararGravacao() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    botao.classList.remove('gravando');
  }

  async function enviarPergunta(blob) {
    estado = 'processando';
    botao.classList.add('processando');
    botao.disabled = true;
    status.textContent = 'Pensando...';
    cartao.classList.add('oculto');

    try {
      const form = new FormData();
      form.append('audio', blob, 'pergunta.webm');
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const dados = await r.json();
      if (!r.ok) throw new Error(dados.erro || 'Falha ao processar');

      pararAudio();
      perguntaTexto.textContent = `"${dados.pergunta}"`;
      respostaTexto.textContent = dados.resposta;
      botaoOuvir.onclick = () => tocarResposta(dados.resposta);
      cartao.classList.remove('oculto');
      status.textContent = 'Toque no microfone e pergunte qualquer coisa sobre sua empresa';
    } catch (err) {
      status.textContent = err.message || 'Algo deu errado. Tente de novo.';
    } finally {
      estado = 'ocioso';
      botao.classList.remove('processando');
      botao.disabled = false;
    }
  }

  botao.addEventListener('click', () => {
    if (estado === 'ocioso') iniciarGravacao().catch(() => {
      status.textContent = 'Não consegui acessar o microfone.';
    });
    else if (estado === 'gravando') pararGravacao();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  carregarSocio();
})();
