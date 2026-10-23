'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use('/temp', express.static('/tmp', { fallthrough: false, maxAge: 0 }));

const PORT = process.env.PORT || 10000;
const GRAPH_VERSION_RAW = process.env.INSTAGRAM_GRAPH_API_VERSION || 'v26.0';
const GRAPH_VERSION = /^v/i.test(GRAPH_VERSION_RAW) ? GRAPH_VERSION_RAW : `v${GRAPH_VERSION_RAW}`;
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_CAPTION_LENGTH = 2200;

// Fila sequencial: processa um card por vez e aguarda o resultado real.
const queue = [];
let isProcessingQueue = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function limparTextoLixo(str) {
  if (!str) return '';

  return String(str)
    .replace(/<!\[CDATA\[/gi, '')
    .replace(/\]\]>/gi, '')
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\b(Aparecida de Goiânia|Eleições APURAÇÃO \d+|Apuração ao Vivo|Candidatos por Goiás\d*|Apuração 2º turno\d*|Votação por ci[a-z]*|Veja o resultado|Confira a apuração)\b/gi, '')
    .replace(/\s*[-|–—]\s*(G1|Jornal Opção|Diário de Goiás|Badiinho|Zap Catalão|Portal Catalão|Blog da Verdade|Diante do Fato|SD News|TV Sudeste|Metrópoles|Poder360|O Antagonista).*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatarSubtituloInteligente(texto, limiteMax = 130) {
  if (!texto) {
    return 'Acompanhe os detalhes e os desdobramentos desta notícia';
  }

  const textoLimpo = limparTextoLixo(texto);

  if (textoLimpo.length <= limiteMax) {
    return textoLimpo;
  }

  let subCortado = textoLimpo.substring(0, limiteMax);
  const ultimoEspaco = subCortado.lastIndexOf(' ');

  if (ultimoEspaco > 40) {
    subCortado = subCortado.substring(0, ultimoEspaco);
  }

  return `${subCortado.trim()}...`;
}

function extrairApenasLegenda(textoBruto) {
  if (!textoBruto) return '';

  const match = String(textoBruto).match(/<legenda>([\s\S]*?)<\/legenda>/i);

  if (match && match[1].trim()) {
    return match[1].trim();
  }

  return String(textoBruto).replace(/<\/?legenda>/gi, '').trim();
}

function prepararLegenda(texto, titulo, textoMateria) {
  let legenda = String(texto || '').trim();

  legenda = legenda
    .replace(/^```(?:text|plaintext)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/\[hashtag\d+\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!legenda || legenda.length < 20) {
    const trecho = String(textoMateria || '').trim().slice(0, 700).trim();

    legenda =
      `${titulo}${trecho ? `\n\n${trecho}${String(textoMateria || '').length > 700 ? '...' : ''}` : ''}` +
      '\n\nPara mais informações, acesse: www.centralgoiano.com.br' +
      '\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.' +
      '\n\n#CentralGoiano #Noticias';
  }

  if (!legenda.includes('www.centralgoiano.com.br')) {
    legenda += '\n\nPara mais informações, acesse: www.centralgoiano.com.br';
  }

  if (!legenda.includes('(64) 9 8179-1016')) {
    legenda += '\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.';
  }

  if (!/#CentralGoiano\b/i.test(legenda)) {
    legenda += '\n\n#CentralGoiano';
  }

  if (!/#Noticias\b/i.test(legenda)) {
    legenda += ' #Noticias';
  }

  if (legenda.length > MAX_CAPTION_LENGTH) {
    const rodape =
      '\n\nPara mais informações, acesse: www.centralgoiano.com.br' +
      '\n\nTem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.' +
      '\n\n#CentralGoiano #Noticias';

    const espacoCorpo = Math.max(0, MAX_CAPTION_LENGTH - rodape.length - 5);

    legenda = `${legenda.slice(0, espacoCorpo).trimEnd()}...${rodape}`;

    if (legenda.length > MAX_CAPTION_LENGTH) {
      legenda = legenda.slice(0, MAX_CAPTION_LENGTH);
    }
  }

  return legenda;
}

async function listarModelosGemini(apiKeyGemini) {
  const padrao = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash'
  ];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKeyGemini)}`
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !Array.isArray(data.models)) {
      return padrao;
    }

    const disponiveis = data.models
      .filter((model) =>
        Array.isArray(model.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes('generateContent')
      )
      .map((model) => String(model.name || '').replace(/^models\//, ''))
      .filter((name) =>
        /^gemini-/i.test(name) &&
        !/(embedding|aqa|tts|robotics|experimental|preview|latest)/i.test(name)
      );

    const priorizados = padrao.filter((name) => disponiveis.includes(name));

    const demais = disponiveis
      .filter((name) => !priorizados.includes(name))
      .sort((a, b) => b.localeCompare(a));

    const resultado = [...priorizados, ...demais];

    return resultado.length ? resultado : padrao;
  } catch (error) {
    console.warn(
      '⚠️ Não foi possível consultar os modelos Gemini; usando lista de fallback.'
    );

    return padrao;
  }
}

async function gerarLegendaGeminiOficial(
  tituloLimpo,
  textoCompletoMateria,
  apiKeyGemini
) {
  if (!apiKeyGemini) {
    console.warn(
      '⚠️ GEMINI_API_KEY não configurada. A legenda será montada com texto de fallback.'
    );

    return '';
  }

  const modelos = await listarModelosGemini(apiKeyGemini);

  const prompt = `Escreva uma legenda em Português do Brasil com base estrita na matéria abaixo, sem inventar fatos.

DIRETRIZES DE ESTILO E ESTRUTURA:
1. Tom estritamente jornalístico, formal, sóbrio e informativo.
2. NÃO utilize emojis.
3. Divida o texto principal em parágrafos menores, dinâmicos e bem distribuídos para facilitar a leitura rápida no Instagram.
4. Adicione duas hashtags correspondentes ao tema específico da matéria logo após #Noticias.
5. Não deixe marcadores literais como [hashtag1] ou [hashtag2] na resposta.

ESTRUTURA OBRIGATÓRIA DO RODAPÉ (coloque exatamente este bloco ao final):
Para mais informações, acesse: www.centralgoiano.com.br

Tem uma informação ou vídeo exclusivo? Envie para o Central Goiano pelo WhatsApp (64) 9 8179-1016.

#CentralGoiano #Noticias [hashtag1] [hashtag2]

REGRA OBRIGATÓRIA DE SAÍDA:
Coloque o texto final da legenda ESTRITAMENTE dentro das tags <legenda> e </legenda>. Não escreva nada fora delas.

Título da Matéria: ${tituloLimpo}
Conteúdo da Matéria: ${String(textoCompletoMateria || '').substring(0, 4000)}`;

  for (const modelo of modelos) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(apiKeyGemini)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: 'Você é jornalista e editor do portal Central Goiano. Escreva em português brasileiro, em parágrafos curtos e sem emojis. Retorne somente a legenda entre as tags <legenda> e </legenda>.'
                }
              ]
            },
            contents: [
              {
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 2048
            }
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.warn(
          `⚠️ Gemini ${modelo} respondeu HTTP ${response.status}: ${data.error?.message || 'erro sem detalhe'}`
        );

        continue;
      }

      const partes = data.candidates?.[0]?.content?.parts;

      const textoBruto = Array.isArray(partes)
        ? partes.map((parte) => parte.text || '').join('\n').trim()
        : '';

      const resultado = extrairApenasLegenda(textoBruto);

      if (resultado && resultado.length > 20) {
        console.log(`✅ Legenda gerada com Gemini (${modelo}).`);

        return resultado;
      }
    } catch (error) {
      console.warn(
        `⚠️ Falha ao gerar legenda com Gemini ${modelo}: ${error.message}`
      );
    }
  }

  console.warn(
    '⚠️ Nenhum modelo Gemini gerou uma legenda válida; será usada a legenda de fallback.'
  );

  return '';
}

function obterBasePublica(req) {
  const configurada =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL;

  if (configurada && /^https?:\/\//i.test(configurada)) {
    return configurada.replace(/\/+$/, '');
  }

  const host = String(req.get('host') || '').trim();

  if (!host) {
    throw new Error(
      'Não foi possível determinar o endereço público do Render. Configure PUBLIC_BASE_URL.'
    );
  }

  // O Instagram precisa conseguir acessar a imagem publicamente por HTTPS.
  return `https://${host}`.replace(/\/+$/, '');
}

async function metaGraphRequest(
  endpoint,
  method,
  params,
  accessToken
) {
  const url = new URL(`${GRAPH_BASE_URL}${endpoint}`);
  const values = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) {
      values.set(key, String(value));
    }
  }

  values.set('access_token', accessToken);

  const options = {
    method,
    headers: {},
    signal: AbortSignal.timeout(30000)
  };

  if (method === 'GET') {
    url.search = values.toString();
  } else {
    options.headers['Content-Type'] =
      'application/x-www-form-urlencoded';

    options.body = values.toString();
  }

  const response = await fetch(url.toString(), options);
  const rawText = await response.text();

  let data;

  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    data = { raw: rawText };
  }

  if (!response.ok || data.error) {
    const detail =
      data.error?.message ||
      data.error?.error_user_msg ||
      data.raw ||
      `HTTP ${response.status}`;

    const code = data.error?.code
      ? ` (código ${data.error.code}${data.error.error_subcode ? `/${data.error.error_subcode}` : ''})`
      : '';

    throw new Error(
      `Instagram/Meta ${endpoint}: ${detail}${code}`
    );
  }

  return data;
}

async function aguardarContainerPronto(
  containerId,
  accessToken
) {
  const maxTentativas = 30;
  let ultimoStatus = 'DESCONHECIDO';

  for (
    let tentativa = 1;
    tentativa <= maxTentativas;
    tentativa++
  ) {
    const statusData = await metaGraphRequest(
      `/${encodeURIComponent(containerId)}`,
      'GET',
      {
        fields: 'status_code,status'
      },
      accessToken
    );

    ultimoStatus = String(
      statusData.status_code || 'DESCONHECIDO'
    ).toUpperCase();

    console.log(
      `📦 Instagram container ${containerId}: ${ultimoStatus}${statusData.status ? ` — ${statusData.status}` : ''}`
    );

    if (ultimoStatus === 'FINISHED') {
      return statusData;
    }

    if (ultimoStatus === 'PUBLISHED') {
      return statusData;
    }

    if (
      ultimoStatus === 'ERROR' ||
      ultimoStatus === 'EXPIRED'
    ) {
      throw new Error(
        `Instagram não concluiu o processamento da imagem. Status: ${ultimoStatus}. ${statusData.status || ''}`.trim()
      );
    }

    await sleep(2000);
  }

  throw new Error(
    `Tempo esgotado aguardando o processamento do Instagram. Último status: ${ultimoStatus}. O card não foi publicado por este processo.`
  );
}

function gerarHtmlCard(
  tituloLimpo,
  subtituloLimpo,
  imagemFinalCard
) {
  const tituloHtml = escapeHtml(tituloLimpo);
  const subtituloHtml = escapeHtml(subtituloLimpo);
  const imagemHtml = escapeHtml(imagemFinalCard);

  const logoUrl =
    'https://blogger.googleusercontent.com/img/a/AVvXsEi4E2jKp6G8IUFdI5IlJdn0NQr1A_DlfyUe0r3RrlfS2AGJ73-6WGm65u81BwsXKg7bGVvGrysbpuTd6uiAppXhzWoPgCP89xanRbdSjUtttLCALl4PEzqbTrIxhe8c9tDwquZYMQj-pjK9ew7zRUF5qEaHoAIwgFW8Nn7mbhmuffn9JEbpqDtbqlugZIYy';

  return `
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
        <div class="cgn-final-bg-wrapper">
          <img id="bg-image" src="${imagemHtml}" crossorigin="anonymous" />
        </div>

        <div class="cgn-final-gradient-overlay"></div>

        <div class="cgn-final-logo-wrapper">
          <img class="cgn-final-logo-img" crossorigin="anonymous" src="${logoUrl}" />
        </div>

        <div class="cgn-final-content-box">
          <h1 class="cgn-final-title">${tituloHtml}</h1>

          <div class="cgn-final-subtitle">
            ${subtituloHtml}
            <span class="cgn-final-subtitle-link">materia completa em: www.centralgoiano.com.br</span>
          </div>

          <div class="cgn-final-social-row">
            <div class="cgn-final-line"></div>

            <div class="cgn-final-icons-group">
              <div class="cgn-final-icon-circle">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                </svg>
              </div>

              <div class="cgn-final-icon-circle">
                <svg viewBox="0 0 24 24">
                  <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                </svg>
              </div>

              <div class="cgn-final-icon-circle">
                <svg viewBox="0 0 24 24">
                  <path d="M9 8H6v4h3v12h5V12h3.642L18 8h-4V6.333C14 5.374 14.5 5 15.5 5H18V0h-3.808C10.592 0 9 1.815 9 5.234V8z"/>
                </svg>
              </div>
            </div>

            <div class="cgn-final-line"></div>
          </div>

          <div class="cgn-final-domain">www.centralgoiano.com.br</div>
        </div>
      </div>
    </body>
    </html>
  `;
}

async function verificarImagemPublica(publicImageUrl) {
  const response = await fetch(publicImageUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `A imagem do card não está acessível publicamente pelo Render (HTTP ${response.status}). URL usada pelo Instagram: ${publicImageUrl}`
    );
  }

  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('image/')) {
    throw new Error(
      `A URL pública do card não respondeu como imagem (Content-Type: ${contentType || 'ausente'}).`
    );
  }
}

async function processarCardEInstagram(
  reqBody,
  publicBaseUrl
) {
  const {
    titulo,
    subtitulo,
    imagemUrl,
    textoMateria
  } = reqBody;

  const tituloLimpo = limparTextoLixo(titulo)
    .replace(/^["“'«]|["”'»]$/g, '');

  const imagemFinalCard = String(imagemUrl || '').trim();

  const subtituloBruto = subtitulo || textoMateria || '';

  const subtituloLimpo = formatarSubtituloInteligente(
    subtituloBruto,
    130
  );

  const textoBaseMateria = limparTextoLixo(
    textoMateria || subtitulo || tituloLimpo
  );

  const apiKeyGemini = process.env.GEMINI_API_KEY;
  const igAccessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID;

  if (!igAccessToken || !igUserId) {
    throw new Error(
      'Configuração do Instagram incompleta no Render. Verifique INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_ACCOUNT_ID nas variáveis de ambiente.'
    );
  }

  if (!tituloLimpo) {
    throw new Error(
      'O título ficou vazio depois da limpeza do texto.'
    );
  }

  if (!/^https?:\/\//i.test(imagemFinalCard)) {
    throw new Error(
      'A imagem original não contém uma URL HTTP/HTTPS válida.'
    );
  }

  let browser = null;
  let tempFilePath = null;
  let containerId = null;

  console.log(
    `🚀 Iniciando processamento real para: "${tituloLimpo}"`
  );

  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ],
      defaultViewport: {
        width: 1080,
        height: 1350,
        deviceScaleFactor: 2
      },
      executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1080,
      height: 1350,
      deviceScaleFactor: 2
    });

    await page.setContent(
      gerarHtmlCard(
        tituloLimpo,
        subtituloLimpo,
        imagemFinalCard
      ),
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );

    // Confirma que a imagem principal realmente carregou.
    await page.waitForFunction(() => {
      const img = document.getElementById('bg-image');

      return img &&
        img.complete &&
        img.naturalWidth > 0 &&
        img.naturalHeight > 0;
    }, {
      timeout: 20000
    });

    // Aguarda as fontes, mas não deixa a espera travar indefinidamente.
    await Promise.race([
      page.evaluate(() =>
        document.fonts
          ? document.fonts.ready
          : Promise.resolve()
      ),
      sleep(4000)
    ]);

    const imageBuffer = await page.screenshot({
      type: 'png'
    });

    await browser.close();
    browser = null;

    const fileName =
      `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;

    tempFilePath = path.join('/tmp', fileName);

    fs.writeFileSync(tempFilePath, imageBuffer);

    const publicImageUrl =
      `${publicBaseUrl}/temp/${encodeURIComponent(fileName)}`;

    // O Instagram precisa conseguir baixar a imagem do Render.
    await verificarImagemPublica(publicImageUrl);

    console.log('🤖 Gerando legenda para o Instagram...');

    const legendaGerada = await gerarLegendaGeminiOficial(
      tituloLimpo,
      textoBaseMateria,
      apiKeyGemini
    );

    const legendaFinal = prepararLegenda(
      legendaGerada,
      tituloLimpo,
      textoBaseMateria
    );

    console.log(
      `📝 Legenda pronta (${legendaFinal.length} caracteres).`
    );

    // Cria o container da publicação no Instagram.
    const mediaData = await metaGraphRequest(
      `/${encodeURIComponent(igUserId)}/media`,
      'POST',
      {
        image_url: publicImageUrl,
        caption: legendaFinal
      },
      igAccessToken
    );

    if (!mediaData.id) {
      throw new Error(
        `Meta não retornou o ID do container da imagem: ${JSON.stringify(mediaData)}`
      );
    }

    containerId = String(mediaData.id);

    console.log(
      `📨 Container criado no Instagram: ${containerId}. Aguardando processamento...`
    );

    // Não tenta publicar enquanto o Instagram ainda processa a imagem.
    const statusContainer = await aguardarContainerPronto(
      containerId,
      igAccessToken
    );

    if (
      String(statusContainer.status_code).toUpperCase() === 'PUBLISHED'
    ) {
      console.log(
        `✅ O Instagram já confirmou o container ${containerId} como publicado.`
      );

      return {
        sucesso: true,
        publicado: true,
        mensagem: 'O Instagram confirmou que a mídia já está publicada.',
        instagramMediaId: containerId,
        containerId,
        legenda: legendaFinal,
        imagemUrlCard: publicImageUrl
      };
    }

    console.log(
      `📤 Publicando container ${containerId} no Instagram...`
    );

    // A publicação só é considerada confirmada se a Meta retornar um ID.
    const publishData = await metaGraphRequest(
      `/${encodeURIComponent(igUserId)}/media_publish`,
      'POST',
      {
        creation_id: containerId
      },
      igAccessToken
    );

    if (!publishData.id) {
      throw new Error(
        `A Meta não confirmou a publicação: ${JSON.stringify(publishData)}`
      );
    }

    console.log(
      `🎉 Instagram confirmou a publicação. ID da mídia: ${publishData.id}`
    );

    return {
      sucesso: true,
      publicado: true,
      mensagem: 'Publicado no Instagram e confirmado pela API da Meta.',
      instagramMediaId: String(publishData.id),
      containerId,
      legenda: legendaFinal,
      imagemUrlCard: publicImageUrl
    };

  } catch (error) {
    if (containerId) {
      error.containerId = containerId;
    }

    throw error;

  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }

    // Remove o arquivo temporário depois que o processamento termina.
    if (tempFilePath) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (_) {}
    }
  }
}

function enfileirar(body, publicBaseUrl) {
  return new Promise((resolve, reject) => {
    queue.push({
      body,
      publicBaseUrl,
      resolve,
      reject
    });

    void processQueue();
  });
}

async function processQueue() {
  if (isProcessingQueue || queue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  const item = queue.shift();

  try {
    const resultado = await processarCardEInstagram(
      item.body,
      item.publicBaseUrl
    );

    item.resolve(resultado);

  } catch (error) {
    console.error(
      '❌ Falha real no card/Instagram:',
      error.message
    );

    item.reject(error);

  } finally {
    isProcessingQueue = false;

    if (queue.length > 0) {
      setTimeout(() => {
        void processQueue();
      }, 3000);
    }
  }
}

app.post('/gerar-card', async (req, res) => {
  const {
    titulo,
    imagemUrl
  } = req.body || {};

  if (
    !titulo ||
    typeof titulo !== 'string' ||
    !titulo.trim()
  ) {
    return res.status(400).json({
      sucesso: false,
      publicado: false,
      error: 'Título é obrigatório.'
    });
  }

  // Valida a URL original da imagem.
  let imagem;

  try {
    imagem = new URL(String(imagemUrl || ''));

    if (!['http:', 'https:'].includes(imagem.protocol)) {
      throw new Error('Protocolo inválido');
    }

  } catch (_) {
    return res.status(400).json({
      sucesso: false,
      publicado: false,
      error: 'Imagem ausente ou URL inválida. Informe uma URL HTTP/HTTPS acessível publicamente.'
    });
  }

  let publicBaseUrl;

  try {
    publicBaseUrl = obterBasePublica(req);

  } catch (error) {
    return res.status(500).json({
      sucesso: false,
      publicado: false,
      error: error.message
    });
  }

  try {
    console.log(
      `📥 Pedido do Script Studio IA recebido. Itens antes deste: ${queue.length}.`
    );

    // IMPORTANTE:
    // Só responde sucesso depois que a Meta confirmar a publicação.
    const resultado = await enfileirar(
      req.body,
      publicBaseUrl
    );

    return res.status(200).json(resultado);

  } catch (error) {
    return res.status(502).json({
      sucesso: false,
      publicado: false,
      mensagem: 'O card não teve publicação confirmada pelo Instagram.',
      error: error.message,
      containerId: error.containerId || null
    });
  }
});

// Rota de saúde para o Render/UptimeRobot.
app.get('/', (_req, res) => {
  res.status(200).send(
    'CGN Instagram Studio IA - serviço online'
  );
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    online: true,
    servico: 'CGN Instagram Studio IA',
    instagramConfigurado: Boolean(
      process.env.INSTAGRAM_ACCESS_TOKEN &&
      process.env.INSTAGRAM_ACCOUNT_ID
    ),
    geminiConfigurado: Boolean(
      process.env.GEMINI_API_KEY
    ),
    graphApiVersion: GRAPH_VERSION
  });
});

app.listen(PORT, () => {
  console.log(
    `Servidor CGN Instagram Studio IA rodando na porta ${PORT}. Graph API ${GRAPH_VERSION}.`
  );
});
