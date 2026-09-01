// Service worker mínimo — só existe pra permitir "adicionar à tela inicial" como PWA.
// Sem cache agressivo: dados financeiros sempre vêm da rede, nunca de cache.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('fetch', () => {});
