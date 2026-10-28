const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/temp', express.static('/tmp'));

// ==================== FILA DE PROCESSAMENTO SEQUENCIAL ====================
const queue = [];
let isProcessingQueue = false;
// Jobs temporários dos Reels; não interferem na fila antiga de cards.
const reelJobs = new Map();

async function processQueue() {
  if (isProcessingQueue || queue.length === 0) return;
  isProcessingQueue = true;

  const item = queue.shift();
  try {
    await processarCardEInstagramEmSegundoPlano(item.body, item.protocol, item.host);
  } catch (err) {
    console.error("❌ Erro ao processar item da fila:", err);
  }

  isProcessingQueue = false;
  // Aguarda 3 segundos antes de processar o próximo card para evitar sobrecarga
  setTimeout(processQueue, 3000);
}
// ============================================================================

function limparTextoLixo(str) {
  if (!str) return "";
  let limpo = str
    .replace(/<!\[CDATA\[/gi, '') .replace(/\]\]>/gi, '')
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\b(Aparecida de Goiânia|Eleições APURAÇÃO \d+|Apuração ao Vivo|Candidatos por Goiás\d*|Apuração 2º turno\d*|Votação por ci[a-z]*|Veja o resultado|Confira a apuração)\b/gi, '')
    .replace(/\s*[-|–—]\s*(G1|Jornal Opção|Diário de Goiás|Badiinho|Zap Catalão|Portal Catalão|Blog da Verdade|Diante do Fato|SD News|TV Sudeste|Metrópoles|Poder360|O Antagonista).*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpo;
}

function formatarSubtituloInteligente(texto, limiteMax = 130) {
  if (!texto) return "Acompanhe os detalhes e os desdobramentos desta notícia";
  let textoLimpo = limparTextoLixo(texto);
  if (textoLimpo.length <= limiteMax) return textoLimpo;
  let subCortado = textoLimpo.substring(0, limiteMax);
  let ultimoEspaco = subCortado.lastIndexOf(' ');
  if (ultimoEspaco > 40) {
    subCortado = subCortado.substring(0, ultimoEspaco);
  }
  return subCortado.trim() + "...";
}

function extrairApenasLegenda(textoBruto) {
  if (!textoBruto) return "";
  const match = textoBruto.match(/<legenda>([\s\S]*?)<\/legenda>/i);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  let limpo = textoBruto.replace(/<\/?legenda>/gi, '').trim();
  return limpo;
}

async function gerarLegendaGeminiOficial(tituloLimpo, textoCompletoMateria, apiKeyGemini) {
  if (!apiKeyGemini) {
    console.error("⚠️ ERRO: GEMINI_API_KEY não configurada no Render!");
    return "";
  }

  let modelos = ['gemini-1.5-flash', 'gemini-1.5-pro'];
  try {
    const resModels = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKeyGemini}`);
    if (resModels.ok) {
      const dataModels = await resModels.json();
      if (dataModels.models && Array.isArray(dataModels.models)) {
        let disponiveis = dataModels.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
          .map(m => m.name.replace('models/', ''))
          // Alteração pontual: impede usar Nano Banana para gerar legendas.
          .filter(name => !/nano-banana/i.test(name))
          .sort((a, b) => b.localeCompare(a));
        if (disponiveis.length > 0) modelos = disponiveis;
      }
    }
  } catch (e) {}

  const prompt = `Escreva uma legenda em Português do Brasil com base estrita na matéria abaixo, sem inventar fatos.

DIRETRIZES DE ESTILO E ESTRUTURA:
1. Tom estritamente jornalístico, formal, sóbrio e informativo.
2. NÃO utilize emojis.
3. Divida o texto principal em parágrafos menores, dinâmicos e bem distribuídos para facilitar a leitura rápida no Instagram.
4. Adicione duas hashtags correspondentes ao tema específico da matéria logo após #Noticias.

ESTRUTURA OBRIGATÓRIA DO RODAPÉ (coloque exatamente este bloco ao final):
Para mais informações, acesse: www.centralgoiano.com.br

Tem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.

#CentralGoiano #Noticias [hashtag1] [hashtag2]

REGRA OBRIGATÓRIA DE SAÍDA:
Coloque o texto final da legenda ESTRITAMENTE dentro das tags <legenda> e </legenda>. Não escreva nada fora delas.

Título da Matéria: ${tituloLimpo}
Conteúdo da Matéria: ${textoCompletoMateria.substring(0, 4000)}`;

  for (const modelo of modelos) {
    try {
      const URL_API = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKeyGemini}`;

      const response = await fetch(URL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: {
            parts: [{
              text: "Você é um jornalista e editor do portal Central Goiano. Sua escrita é jornalística, dividida em parágrafos menores, sem emojis. Sua única saída deve ser a legenda contida estritamente entre <legenda> e </legenda>."
            }]
          },
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        })
      });

      const data = await response.json();

      if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
        let textoBruto = data.candidates[0].content.parts[0].text;
        let resultado = extrairApenasLegenda(textoBruto);
        if (resultado && resultado.length > 20) {
          console.log(`✅ Legenda gerada com sucesso via Gemini (${modelo})!`);
          return resultado;
        }
      }
    } catch (err) {}
  }

  return "";
}

async function processarCardEInstagramEmSegundoPlano(reqBody, protocol, host) {
  const { titulo, subtitulo, imagemUrl, textoMateria } = reqBody;

  const tituloLimpo = limparTextoLixo(titulo).replace(/^["“'«]|["”'»]$/g, '');
  const imagemFinalCard = imagemUrl;
  let subtituloBruto = subtitulo || textoMateria || "";
  let subtituloLimpo = formatarSubtituloInteligente(subtituloBruto, 130);
  let textoBaseMateria = limparTextoLixo(textoMateria || subtitulo || tituloLimpo);

  const API_KEY_GEMINI = process.env.GEMINI_API_KEY;
  const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
  const IG_USER_ID = process.env.INSTAGRAM_ACCOUNT_ID;

  let browser = null;
  try {
    console.log(`🚀 [Fila] Iniciando processamento para: "${tituloLimpo}"`);
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: { width: 1080, height: 1350, deviceScaleFactor: 2 },
      executablePath: executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,700;0,800;0,900;1,700;1,800;1,900&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { width: 1080px; height: 1350px; background-color: #1a1a1a; font-family: 'Montserrat', Arial, sans-serif; overflow: hidden; position: relative; -webkit-font-smoothing: antialiased; }
        #cgn-card { position: relative; width: 1080px; height: 1350px; background-color: #1a1a1a; overflow: hidden; }
        .cgn-final-bg-wrapper { position: absolute; top: 0; left: 0; width: 1080px; height: 1350px; overflow: hidden; z-index: 1; background-color: #111111; }
        .cgn-final-bg-wrapper img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .cgn-final-gradient-overlay { position: absolute; top: 0; left: 0; width: 1080px; height: 1350px; background: radial-gradient(circle at 12% 12%, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0) 40%), linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0) 15%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.8) 83%, rgba(0,0,0,0.95) 100%); z-index: 2; }
        .cgn-final-logo-wrapper { position: absolute; top: 55px; left: 75px; z-index: 10; }
        .cgn-final-logo-img { width: 230px; height: auto; display: block; filter: drop-shadow(0px 3px 6px rgba(0, 0, 0, 0.4)); }
        .cgn-final-content-box { position: absolute; bottom: 0; left: 0; width: 1080px; padding: 0 75px 40px 75px; z-index: 5; display: flex; flex-direction: column; }
        .cgn-final-title { font-size: 42px; font-weight: 900; color: #ffffff; line-height: 1.18; margin: 0 0 16px 0; letter-spacing: -0.2px; text-shadow: 0px 2px 8px rgba(0, 0, 0, 0.8); text-align: left; }
        .cgn-final-subtitle { font-size: 26px; font-style: italic; font-weight: 800; color: #ffffff; line-height: 1.25; margin: 0 0 24px 0; letter-spacing: -0.2px; text-shadow: 0px 2px 8px rgba(0, 0, 0, 0.8); text-align: left; }
        .cgn-final-subtitle-link { color: #e30613; font-style: italic; font-weight: 800; }
        .cgn-final-social-row { display: flex; align-items: center; width: 100%; margin-bottom: 18px; }
        .cgn-final-line { flex: 1; height: 2.5px; background-color: #e30613; }
        .cgn-final-icons-group { display: flex; gap: 12px; padding: 0 16px; }
        .cgn-final-icon-circle { width: 30px; height: 30px; border-radius: 50%; background-color: #ffffff; display: flex; align-items: center; justify-content: center; }
        .cgn-final-icon-circle svg { fill: #000000; width: 16px; height: 16px; }
        .cgn-final-domain { text-align: center; width: 100%; font-size: 27px; font-weight: 800; color: #ffffff; letter-spacing: 0.3px; }
      </style>
    </head>
    <body>
      <div id="cgn-card">
        <div class="cgn-final-bg-wrapper"><img id="bg-image" src="${imagemFinalCard}" crossorigin="anonymous" /></div>
        <div class="cgn-final-gradient-overlay"></div>
        <div class="cgn-final-logo-wrapper"><img class="cgn-final-logo-img" crossorigin="anonymous" src="https://blogger.googleusercontent.com/img/a/AVvXsEi4E2jKp6G8IUFdI5IlJdn0NQr1A_DlfyUe0r3RrlfS2AGJ73-6WGm65u81BwsXKg7bGVvGrysbpuTd6uiAppXhzWoPgCP89xanRbdSjUtttLCALl4PEzqbTrIxhe8c9tDwquZYMQj-pjK9ew7zRUF5qEaHoAIwgFW8Nn7mbhmuffn9JEbpqDtbqlugZIYy" /></div>
        <div class="cgn-final-content-box">
          <h1 class="cgn-final-title">${tituloLimpo}</h1>
          <div class="cgn-final-subtitle">${subtituloLimpo} <span class="cgn-final-subtitle-link">materia completa em: www.centralgoiano.com.br</span></div>
          <div class="cgn-final-social-row">
            <div class="cgn-final-line"></div>
            <div class="cgn-final-icons-group">
              <div class="cgn-final-icon-circle"><svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></div>
              <div class="cgn-final-icon-circle"><svg viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg></div>
              <div class="cgn-final-icon-circle"><svg viewBox="0 0 24 24"><path d="M9 8H6v4h3v12h5V12h3.642L18 8h-4V6.333C14 5.374 14.5 5 15.5 5H18V0h-3.808C10.592 0 9 1.815 9 5.234V8z"/></svg></div>
            </div>
            <div class="cgn-final-line"></div>
          </div>
          <div class="cgn-final-domain">www.centralgoiano.com.br</div>
        </div>
      </div>
    </body>
    </html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 25000 });

    try {
      await page.waitForFunction(() => {
        const img = document.getElementById('bg-image');
        return img && img.complete && img.naturalWidth !== 0;
      }, { timeout: 8000 });
    } catch (e) {}

    await new Promise(r => setTimeout(r, 1000));
    const imageBuffer = await page.screenshot({ type: 'png' });
    await browser.close();

    const fileName = `card-${Date.now()}.png`;
    const tempFilePath = path.join('/tmp', fileName);
    fs.writeFileSync(tempFilePath, imageBuffer);
    const publicImageUrl = `${protocol}://${host}/temp/${fileName}`;

    console.log("🤖 Gerando legenda com Gemini Oficial...");
    let legendaFinal = await gerarLegendaGeminiOficial(tituloLimpo, textoBaseMateria, API_KEY_GEMINI);

    if (!legendaFinal || legendaFinal.length < 20) {
      legendaFinal = `${tituloLimpo}\n\n${textoBaseMateria.substring(0, 300)}...\n\nPara mais informações, acesse: www.centralgoiano.com.br\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.\n\n#CentralGoiano #Noticias`;
    }

    if (IG_ACCESS_TOKEN && IG_USER_ID) {
      const mediaUrl = `https://graph.facebook.com/v18.0/${IG_USER_ID}/media`;
      const resMedia = await fetch(mediaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: publicImageUrl,
          caption: legendaFinal,
          access_token: IG_ACCESS_TOKEN
        })
      });
      const dataMedia = await resMedia.json();

      if (dataMedia.id) {
        const creationId = dataMedia.id;
        await new Promise(r => setTimeout(r, 4000));

        const publishUrl = `https://graph.facebook.com/v18.0/${IG_USER_ID}/media_publish`;
        await fetch(publishUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: creationId, access_token: IG_ACCESS_TOKEN })
        });
        console.log("🎉 Publicado com Sucesso no Instagram!");
      }
    }
  } catch (err) {
    if (browser) await browser.close();
    console.error("❌ Erro no processamento em segundo plano:", err);
  }
}

// ============================================================================
// EXTENSÃO ADITIVA: PUBLICAÇÃO DE REELS A PARTIR DO EDITOR DE VÍDEO
// Não altera a rota /gerar-card nem a fila de publicação de cards.
// ============================================================================
const reelCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Reel-Caption-Encoded, X-Reel-Job-Token'
};

function reelRespostaErro(res, status, error) {
  return res.status(status).set(reelCors).json({ sucesso: false, error });
}

function reelAutenticar(req, res) {
  const esperado = String(process.env.REEL_PUBLISH_SECRET || "");
  const recebido = String(req.get('X-Studio-Reel-Secret') || "");
  if (!esperado) {
    reelRespostaErro(res, 503, 'REEL_PUBLISH_SECRET não configurado no Render.');
    return false;
  }
  const a = Buffer.from(esperado);
  const b = Buffer.from(recebido);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    reelRespostaErro(res, 401, 'Autorização inválida para a rota de Reels.');
    return false;
  }
  return true;
}

function reelJobValido(req, containerId) {
  const job = reelJobs.get(String(containerId || ''));
  const supplied = String(req.get('X-Reel-Job-Token') || '');
  if (!job || !supplied || supplied !== job.token) return null;
  return job;
}

function reelLimparJobsAntigos() {
  const agora = Date.now();
  for (const [id, job] of reelJobs.entries()) {
    if (agora - job.createdAt > 60 * 60 * 1000) {
      try { if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch (e) {}
      reelJobs.delete(id);
    }
  }
}

app.options('/postar-reel', (req, res) => res.status(204).set(reelCors).end());
app.options('/status-reel', (req, res) => res.status(204).set(reelCors).end());
app.options('/publicar-reel', (req, res) => res.status(204).set(reelCors).end());

app.post('/postar-reel', express.raw({ type: ['video/mp4', 'video/quicktime'], limit: '150mb' }), async (req, res) => {
  res.set(reelCors);
  if (!reelAutenticar(req, res)) return;
  reelLimparJobsAntigos();
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (!token || !igUserId) return reelRespostaErro(res, 503, 'INSTAGRAM_ACCESS_TOKEN ou INSTAGRAM_ACCOUNT_ID não configurados no Render.');
  if (!Buffer.isBuffer(req.body) || req.body.length < 1024) return reelRespostaErro(res, 400, 'Envie o MP4 exportado como corpo binário da requisição.');
  if (req.body.length > 150 * 1024 * 1024) return reelRespostaErro(res, 413, 'O vídeo excede o limite de 150 MB desta rota.');
  const contentType = String(req.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['video/mp4', 'video/quicktime'].includes(contentType)) return reelRespostaErro(res, 415, 'Formato não suportado. Exporte MP4 (H.264/AAC) ou MOV.');

  let caption = '';
  try { caption = decodeURIComponent(String(req.get('X-Reel-Caption-Encoded') || '')); }
  catch (e) { caption = String(req.get('X-Reel-Caption-Encoded') || ''); }
  caption = caption.slice(0, 2200);
  const extension = contentType === 'video/quicktime' ? 'mov' : 'mp4';
  const fileName = `studio-reel-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${extension}`;
  const filePath = path.join('/tmp', fileName);
  try {
    fs.writeFileSync(filePath, req.body);
    // Render publica /temp; o Meta precisa buscar o arquivo por URL HTTPS pública.
    const videoUrl = `https://${req.get('host')}/temp/${encodeURIComponent(fileName)}`;
    const version = String(process.env.META_GRAPH_API_VERSION || 'v26.0').replace(/^v?/, 'v');
    const graphForm = new URLSearchParams({
      media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true', access_token: token
    });
    const createResp = await fetch(`https://graph.facebook.com/${version}/${igUserId}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: graphForm.toString()
    });
    const created = await createResp.json().catch(() => ({}));
    if (!createResp.ok || !created.id) {
      try { fs.unlinkSync(filePath); } catch (e) {}
      return reelRespostaErro(res, 502, created.error?.message || 'O Instagram não criou o contêiner do Reel. Verifique permissões, token e formato do vídeo.');
    }
    const jobToken = crypto.randomBytes(24).toString('hex');
    reelJobs.set(String(created.id), { token: jobToken, fileName, filePath, createdAt: Date.now(), version, igUserId });
    return res.status(202).json({ sucesso: true, containerId: String(created.id), jobToken, mensagem: 'Vídeo recebido; o Instagram está processando o Reel.' });
  } catch (err) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
    return reelRespostaErro(res, 502, 'Erro ao enviar o Reel: ' + (err && err.message ? err.message : 'erro desconhecido.'));
  }
});

app.get('/status-reel', async (req, res) => {
  res.set(reelCors);
  if (!reelAutenticar(req, res)) return;
  const containerId = String(req.query.containerId || '');
  const job = reelJobValido(req, containerId);
  if (!job) return reelRespostaErro(res, 404, 'Trabalho de Reel não encontrado ou token inválido/expirado.');
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  try {
    const url = new URL(`https://graph.facebook.com/${job.version}/${encodeURIComponent(containerId)}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', token || '');
    const statusResp = await fetch(url.toString());
    const data = await statusResp.json().catch(() => ({}));
    if (!statusResp.ok) return reelRespostaErro(res, 502, data.error?.message || 'Não foi possível consultar o processamento do Reel.');
    return res.json({ sucesso: true, status_code: data.status_code || 'IN_PROGRESS', status: data.status || '' });
  } catch (err) {
    return reelRespostaErro(res, 502, 'Erro ao consultar o status: ' + err.message);
  }
});

app.post('/publicar-reel', express.json({ limit: '20kb' }), async (req, res) => {
  res.set(reelCors);
  if (!reelAutenticar(req, res)) return;
  const containerId = String((req.body || {}).containerId || '');
  const job = reelJobValido(req, containerId);
  if (!job) return reelRespostaErro(res, 404, 'Trabalho de Reel não encontrado ou token inválido/expirado.');
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  try {
    const statusUrl = new URL(`https://graph.facebook.com/${job.version}/${encodeURIComponent(containerId)}`);
    statusUrl.searchParams.set('fields', 'status_code,status');
    statusUrl.searchParams.set('access_token', token || '');
    const statusResp = await fetch(statusUrl.toString());
    const statusData = await statusResp.json().catch(() => ({}));
    if (!statusResp.ok) return reelRespostaErro(res, 502, statusData.error?.message || 'Não foi possível verificar o contêiner antes de publicar.');
    if (String(statusData.status_code || '').toUpperCase() !== 'FINISHED') {
      return res.status(409).json({ sucesso: false, status_code: statusData.status_code || 'IN_PROGRESS', error: 'O Instagram ainda está processando o vídeo.' });
    }
    const publishForm = new URLSearchParams({ creation_id: containerId, access_token: token || '' });
    const publishResp = await fetch(`https://graph.facebook.com/${job.version}/${job.igUserId}/media_publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: publishForm.toString()
    });
    const published = await publishResp.json().catch(() => ({}));
    if (!publishResp.ok || !published.id) return reelRespostaErro(res, 502, published.error?.message || 'O Instagram não confirmou a publicação do Reel.');
    try { if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch (e) {}
    reelJobs.delete(containerId);
    return res.json({ sucesso: true, id: published.id, mensagem: 'Reel publicado com sucesso.' });
  } catch (err) {
    return reelRespostaErro(res, 502, 'Erro ao publicar o Reel: ' + (err && err.message ? err.message : 'erro desconhecido.'));
  }
});

app.post('/gerar-card', (req, res) => {
  const { titulo, imagemUrl } = req.body;

  if (!titulo) {
    return res.status(400).json({ error: 'Título é obrigatório' });
  }

  if (!imagemUrl || typeof imagemUrl !== 'string' || !imagemUrl.startsWith("http")) {
    return res.json({
      sucesso: false,
      mensagem: "Nenhuma imagem válida encontrada."
    });
  }

  // Responde IMEDIATAMENTE ao Apps Script
  res.json({
    sucesso: true,
    mensagem: "Processamento enfileirado com sucesso."
  });

  // Adiciona o pedido à fila de execução sequencial
  queue.push({
    body: req.body,
    protocol: req.protocol,
    host: req.get('host')
  });

  processQueue();
});

// Apenas a rota GET adicionada para o UptimeRobot manter o Render acordado
app.get('/', (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
