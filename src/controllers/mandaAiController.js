// MandaAI — assistente da Manda Bola ("manda aí a sua pergunta").
// O usuário fala ou digita; a IA entende o pedido e:
//  - leva para a aba certa do sistema (com filtros já preenchidos), ou
//  - responde na hora com dados (estoque, resumo do mês, manutenções...), ou
//  - prepara uma ação (ex: abrir manutenção) que o usuário confirma.
// Sem OPENAI_API_KEY ela continua funcionando em "modo básico" (regras locais).
import { Op } from "sequelize";
import {
  Loja,
  Maquina,
  EstoqueLoja,
  Produto,
  Manutencao,
  Roteiro,
  RoteiroLoja,
  Veiculo,
} from "../models/index.js";
import { resumoDashboard } from "../services/dashboardService.js";
import { temPermissao } from "../utils/permissoes.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELO = () =>
  process.env.MANDAAI_MODEL || process.env.OPENAI_ASSISTENTE_MODEL || "gpt-4.1-mini";
const TODAS_AS_LOJAS = "__TODAS_AS_LOJAS__";
const ASSISTENTE = {
  nome: "MandaAI",
  subtitulo: "manda aí a sua pergunta:",
};
const MEMORIA_TTL_MS = 1000 * 60 * 60 * 6;
const memorias = new Map();

// Abas do sistema que a MandaAI sabe abrir. "palavras" alimenta o modo básico.
export const DESTINOS = {
  dashboard: { rota: "/", nome: "Dashboard", palavras: ["dashboard", "inicio", "painel", "home", "tela inicial"] },
  lojas: { rota: "/lojas", nome: "Lojas / Pontos", palavras: ["lojas", "pontos", "ponto"] },
  nova_loja: { rota: "/lojas/nova", nome: "Cadastrar loja", palavras: ["nova loja", "cadastrar loja", "novo ponto"] },
  maquinas: { rota: "/maquinas", nome: "Máquinas", palavras: ["maquinas", "gruas"] },
  nova_maquina: { rota: "/maquinas/nova", nome: "Cadastrar máquina", palavras: ["nova maquina", "cadastrar maquina", "nova grua"] },
  produtos: { rota: "/produtos", nome: "Produtos", palavras: ["produtos", "pelucias", "premios"] },
  novo_produto: { rota: "/produtos/novo", nome: "Cadastrar produto", palavras: ["novo produto", "cadastrar produto"] },
  movimentacoes: { rota: "/movimentacoes", nome: "Arrecadação", palavras: ["arrecadacao", "arrecadacoes"] },
  roteiros_movimentacao: { rota: "/movimentacoes/roteiros", nome: "Movimentações por roteiro", palavras: ["movimentacoes", "movimentacao"] },
  roteiros: { rota: "/roteiros", nome: "Roteiros", palavras: ["roteiros", "roteiro", "rotas"] },
  gerenciar_roteiros: { rota: "/roteiros/gerenciar", nome: "Gerenciar roteiros", palavras: ["gerenciar roteiros", "montar roteiro"] },
  financeiro: { rota: "/financeiro", nome: "Financeiro", palavras: ["financeiro", "financas"] },
  compras: { rota: "/compras", nome: "Compras", palavras: ["compras", "comprar", "nova compra"] },
  compras_estoque: { rota: "/compras/estoque", nome: "Estoque da base", palavras: ["estoque da base", "estoque base", "deposito"] },
  compras_historico: { rota: "/compras/historico", nome: "Histórico de compras", palavras: ["historico de compras"] },
  reposicao: { rota: "/compras/reposicao", nome: "Produtos a comprar", palavras: ["reposicao", "a comprar", "lista de compras"] },
  conferencia: { rota: "/conferencia", nome: "Conferência", palavras: ["conferencia", "conferir"] },
  machine_pay: { rota: "/machine-pay", nome: "Machine Pay", palavras: ["machine pay", "pix", "cartao", "leitores"] },
  graficos: { rota: "/graficos", nome: "Gráficos", palavras: ["graficos", "grafico"] },
  alertas_estoque: { rota: "/alertas-estoque", nome: "Alertas de estoque", palavras: ["alertas", "alerta de estoque"] },
  relatorios: { rota: "/relatorios", nome: "Relatórios", palavras: ["relatorios", "relatorio"] },
  manutencoes: { rota: "/manutencoes", nome: "Manutenções", palavras: ["manutencoes", "manutencao", "conserto", "defeito"] },
  veiculos: { rota: "/veiculos", nome: "Veículos", palavras: ["veiculos", "veiculo", "carro", "carros", "frota"] },
  usuarios: { rota: "/usuarios", nome: "Usuários", palavras: ["usuarios", "funcionarios", "equipe"] },
  novo_usuario: { rota: "/usuarios/novo", nome: "Cadastrar usuário", palavras: ["novo usuario", "novo funcionario"] },
  carrinhos: { rota: "/carrinhos", nome: "Carrinhos", palavras: ["carrinhos", "carrinho"] },
  creditos_remotos: { rota: "/creditos-remotos", nome: "Créditos remotos / vouchers", palavras: ["vouchers", "voucher", "credito remoto", "creditos"] },
};

const INTENTS = [
  "NAVEGAR",
  "CONSULTAR_ESTOQUE",
  "ESTOQUE_BAIXO",
  "GERAR_RELATORIO_LOJA",
  "NOVA_MOVIMENTACAO",
  "ABRIR_LOJA",
  "ABRIR_MAQUINA",
  "REGISTRAR_MANUTENCAO",
  "LISTAR_MANUTENCOES",
  "RESUMO_OPERACAO",
  "STATUS_VEICULOS",
  "CONVERSA",
  "DESCONHECIDO",
];

const MESES_PT_BR = [
  ["janeiro", 0], ["fevereiro", 1], ["marco", 2], ["abril", 3], ["maio", 4], ["junho", 5],
  ["julho", 6], ["agosto", 7], ["setembro", 8], ["outubro", 9], ["novembro", 10], ["dezembro", 11],
];

const TERMOS_LOJA_IGNORADOS = new Set([
  "manda", "bola", "mandabola", "shopping", "loja", "ponto", "quiosque", "premium", "diversoes",
]);

const normalizar = (valor) =>
  String(valor || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const temPalavra = (texto, termo) =>
  new RegExp(`\\b${escaparRegex(normalizar(termo))}\\b`).test(texto);

const formatarMoeda = (valor) =>
  Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Datas no fuso de Brasília (o servidor roda em UTC na Render).
const agoraBR = () => new Date(Date.now() - 3 * 60 * 60 * 1000);
const hojeBR = () => agoraBR().toISOString().slice(0, 10);
const isoUTC = (ano, mes, dia) =>
  new Date(Date.UTC(ano, mes, dia)).toISOString().slice(0, 10);

// ---------------------------------------------------------------- OpenAI

const nulo = (tipo) => ({ type: [tipo, "null"] });

const schemaComando = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent", "destino", "lojaId", "lojaNome", "maquinaId", "maquinaNome",
    "contadorIn", "contadorOut", "quantidadeAbastecida", "descricao", "mes",
    "periodo", "resposta", "camposFaltantes",
  ],
  properties: {
    intent: { type: "string", enum: INTENTS },
    destino: { type: ["string", "null"], enum: [...Object.keys(DESTINOS), null] },
    lojaId: nulo("string"),
    lojaNome: nulo("string"),
    maquinaId: nulo("string"),
    maquinaNome: nulo("string"),
    contadorIn: nulo("integer"),
    contadorOut: nulo("integer"),
    quantidadeAbastecida: nulo("integer"),
    descricao: nulo("string"),
    mes: nulo("string"),
    periodo: {
      type: "object",
      additionalProperties: false,
      required: ["dataInicio", "dataFim", "descricao"],
      properties: {
        dataInicio: nulo("string"),
        dataFim: nulo("string"),
        descricao: nulo("string"),
      },
    },
    resposta: { type: "string" },
    camposFaltantes: { type: "array", items: { type: "string" } },
  },
};

const extrairTextoResposta = (resposta) => {
  if (typeof resposta?.output_text === "string") return resposta.output_text;
  const textos = [];
  for (const item of resposta?.output || []) {
    for (const c of item?.content || []) {
      if (c?.type === "output_text" && c?.text) textos.push(c.text);
    }
  }
  return textos.join("\n").trim();
};

const montarInstrucoes = ({ lojas, maquinas, usuario }) =>
  [
    "Voce e a MandaAI, assistente do sistema de gestao de gruas (maquinas de pelucia) da empresa Manda Bola Premium Diversoes.",
    "Seu bordao e 'manda ai a sua pergunta'. Fale portugues do Brasil, de forma simpatica, curta e direta.",
    "Interprete o pedido do usuario e retorne APENAS o JSON do schema.",
    `Usuario atual: ${usuario?.nome || "usuario"} (perfil ${usuario?.role || "?"}). Hoje e ${hojeBR()}.`,
    "",
    "Intents:",
    "- NAVEGAR: o usuario quer abrir/ir para uma aba. Preencha destino com uma das chaves disponiveis.",
    "- CONSULTAR_ESTOQUE: quantidade de produtos/pelucias em uma loja ou em todas (lojaId \"__TODAS_AS_LOJAS__\").",
    "- ESTOQUE_BAIXO: o que esta acabando / precisa repor / alertas de estoque.",
    "- GERAR_RELATORIO_LOJA: relatorio de uma loja em um periodo (dataInicio/dataFim YYYY-MM-DD). 'mes de abril' = 01/04 a 30/04 do ano atual se nao disser o ano.",
    "- NOVA_MOVIMENTACAO: fazer coleta/movimentacao/abastecer uma maquina. Entrada/IN -> contadorIn, saida/OUT -> contadorOut, abastecer/colocar/repor N pelucias -> quantidadeAbastecida.",
    "- ABRIR_LOJA / ABRIR_MAQUINA: ver detalhes de uma loja ou maquina especifica.",
    "- REGISTRAR_MANUTENCAO: abrir chamado/relatar defeito de uma maquina. descricao = o problema relatado, curto e claro.",
    "- LISTAR_MANUTENCOES: quais manutencoes estao pendentes/abertas.",
    "- RESUMO_OPERACAO: quanto faturou/vendeu, resumo do mes, melhores maquinas. mes no formato YYYY-MM (padrao mes atual).",
    "- STATUS_VEICULOS: quais veiculos estao em uso, combustivel, km.",
    "- CONVERSA: saudacao, duvida sobre como usar o sistema ou pergunta geral; responda em 'resposta'.",
    "- DESCONHECIDO: nao deu para entender.",
    "",
    "Regras:",
    "- Sempre escreva em 'resposta' uma frase curta para o usuario.",
    "- Resolva lojaId/maquinaId usando as listas abaixo; aceite nomes parciais ou parecidos (ex: 'loja do centro').",
    "- 'maquina 3' normalmente se refere ao codigo/nome com o numero 3 dentro da loja citada.",
    "- Use o historico da conversa para completar pedidos curtos (ex: 'e a de abril?' reaproveita a loja anterior).",
    "- Se faltar algo obrigatorio, liste em camposFaltantes (loja, maquina, periodo, descricao).",
    "",
    `Abas disponiveis (destino):\n${Object.entries(DESTINOS).map(([k, d]) => `- ${k}: ${d.nome}`).join("\n")}`,
    `Lojas:\n${lojas.map((l) => `- ${l.nome}${l.cidade ? ` (${l.cidade})` : ""} | id: ${l.id}`).join("\n") || "- nenhuma"}`,
    `Maquinas:\n${maquinas.map((m) => `- ${m.nome || m.codigo} | codigo: ${m.codigo} | id: ${m.id} | lojaId: ${m.lojaId}`).join("\n") || "- nenhuma"}`,
  ].join("\n");

const chamarOpenAI = async ({ texto, historico, lojas, maquinas, usuario }) => {
  const entrada = [
    ...historico.map((h) => ({
      role: h.autor === "usuario" ? "user" : "assistant",
      content: String(h.texto || "").slice(0, 600),
    })),
    { role: "user", content: texto },
  ];

  const resposta = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO(),
      instructions: montarInstrucoes({ lojas, maquinas, usuario }),
      input: entrada,
      text: {
        format: { type: "json_schema", name: "comando_mandaai", strict: true, schema: schemaComando },
      },
      max_output_tokens: 800,
    }),
  });

  const payload = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(payload?.error?.message || "Falha ao falar com a OpenAI");
    erro.status = resposta.status === 401 ? 503 : 502;
    throw erro;
  }
  const json = extrairTextoResposta(payload);
  if (!json) throw Object.assign(new Error("A IA não retornou resposta"), { status: 502 });
  return JSON.parse(json);
};

// ------------------------------------------------- Regras locais (fallback)

const pontuarLoja = (texto, loja) => {
  const nome = normalizar(loja.nome);
  if (!nome) return 0;
  if (texto.includes(nome)) return 100;
  return nome
    .split(" ")
    .filter((t) => t.length >= 4 && !TERMOS_LOJA_IGNORADOS.has(t))
    .reduce((s, t) => (temPalavra(texto, t) ? s + Math.min(t.length, 12) : s), 0);
};

const melhorCandidato = (lista) => {
  const ordenada = lista.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  if (!ordenada.length) return null;
  if (ordenada.length === 1 || ordenada[0].score > ordenada[1].score) return ordenada[0].item;
  return null;
};

const inferirLoja = (texto, lojas) =>
  melhorCandidato(lojas.map((item) => ({ item, score: pontuarLoja(normalizar(texto), item) })));

const pontuarMaquina = (texto, m) => {
  let score = 0;
  const codigo = normalizar(m.codigo);
  const numero = codigo.match(/\d+/)?.[0];
  if (codigo && temPalavra(texto, codigo)) score += 140;
  if (numero && new RegExp(`\\b(maquina|grua)\\s+(numero\\s+)?${Number(numero)}\\b`).test(texto)) score += 120;
  const nome = normalizar(m.nome);
  if (nome && nome.length >= 3 && temPalavra(texto, nome)) score += 80;
  return score;
};

const inferirMaquina = (texto, maquinas, loja) => {
  const elegiveis = loja && loja !== TODAS_AS_LOJAS ? maquinas.filter((m) => m.lojaId === loja.id) : maquinas;
  return melhorCandidato(elegiveis.map((item) => ({ item, score: pontuarMaquina(normalizar(texto), item) })));
};

const inferirPeriodo = (texto) => {
  const t = normalizar(texto);
  const hoje = agoraBR();
  const ano = hoje.getUTCFullYear();
  const mes = hoje.getUTCMonth();

  if (/\bhoje\b/.test(t)) return { dataInicio: hojeBR(), dataFim: hojeBR(), descricao: "hoje" };
  if (/\bontem\b/.test(t)) {
    const d = isoUTC(ano, mes, hoje.getUTCDate() - 1);
    return { dataInicio: d, dataFim: d, descricao: "ontem" };
  }
  if (/\b(esta|essa|nesta|nessa) semana\b|\bsemana atual\b/.test(t)) {
    const dow = (hoje.getUTCDay() + 6) % 7; // segunda = 0
    return { dataInicio: isoUTC(ano, mes, hoje.getUTCDate() - dow), dataFim: hojeBR(), descricao: "esta semana" };
  }
  if (/\bsemana passada\b/.test(t)) {
    const dow = (hoje.getUTCDay() + 6) % 7;
    return {
      dataInicio: isoUTC(ano, mes, hoje.getUTCDate() - dow - 7),
      dataFim: isoUTC(ano, mes, hoje.getUTCDate() - dow - 1),
      descricao: "semana passada",
    };
  }
  if (/\bmes passado\b/.test(t)) {
    return { dataInicio: isoUTC(ano, mes - 1, 1), dataFim: isoUTC(ano, mes, 0), descricao: "mês passado" };
  }
  if (/\b(este|esse|neste|nesse) mes\b|\bmes atual\b/.test(t)) {
    return { dataInicio: isoUTC(ano, mes, 1), dataFim: isoUTC(ano, mes + 1, 0), descricao: "este mês" };
  }
  for (const [nome, idx] of MESES_PT_BR) {
    if (!temPalavra(t, nome)) continue;
    const anoFalado = Number(t.match(new RegExp(`${nome}\\s+(?:de\\s+)?(20\\d{2})`))?.[1]) || ano;
    return {
      dataInicio: isoUTC(anoFalado, idx, 1),
      dataFim: isoUTC(anoFalado, idx + 1, 0),
      descricao: `${nome} de ${anoFalado}`,
    };
  }
  return null;
};

const numeroApos = (t, rotulos) => {
  for (const r of rotulos) {
    const m = t.match(new RegExp(`\\b${r}\\b\\s*(?:e|eh|de|=|:|-|com)?\\s*(\\d{1,9})\\b`));
    if (m) return Number(m[1]);
  }
  return null;
};

const inferirNumeros = (texto) => {
  const t = normalizar(texto);
  const abastecida =
    t.match(/\b(?:abastecer|abasteci|abastece|colocar|coloquei|coloca|adicionar|adicionei|repor|repus|completei|inserir|inseri)\b(?:\s+\w+){0,4}?\s+(\d{1,6})\b/)?.[1] ||
    t.match(/\b(\d{1,6})\s+(?:pelucias|pelucia|produtos|produto|unidades|itens|premios)\b/)?.[1];
  return {
    contadorIn: numeroApos(t, ["contador de entrada", "contador entrada", "contador in", "entrada", "in"]),
    contadorOut: numeroApos(t, ["contador de saida", "contador saida", "contador out", "saida", "out"]),
    quantidadeAbastecida: abastecida ? Number(abastecida) : null,
  };
};

const inferirDestino = (texto) => {
  const t = normalizar(texto);
  let melhor = null;
  for (const [chave, d] of Object.entries(DESTINOS)) {
    for (const p of d.palavras) {
      if (temPalavra(t, p) && (!melhor || p.length > melhor.tam)) melhor = { chave, tam: p.length };
    }
  }
  return melhor?.chave || null;
};

const inferirIntent = (texto) => {
  const t = normalizar(texto);
  if (/\b(oi|ola|bom dia|boa tarde|boa noite|ajuda|o que voce faz)\b/.test(t) && t.split(" ").length <= 5) return "CONVERSA";
  if (/\b(acabando|repor|baixo|faltando|falta)\b/.test(t) && /\b(estoque|pelucia|produto)/.test(t)) return "ESTOQUE_BAIXO";
  if (/\brelatorio\b/.test(t) && !/\b(abr|ir|vai|leva)/.test(t.split("relatorio")[0] || "")) return "GERAR_RELATORIO_LOJA";
  if (/\bestoque\b/.test(t) && !/\bestoque da base\b/.test(t)) return "CONSULTAR_ESTOQUE";
  if (/\b(quebr|defeito|travad|nao liga|parou|estragou|com problema|abrir manutencao|registrar manutencao|chamado)/.test(t)) return "REGISTRAR_MANUTENCAO";
  if (/\bmanutenc/.test(t) && /\b(pendente|aberta|quantas|quais|lista)/.test(t)) return "LISTAR_MANUTENCOES";
  if (/\b(fatur\w*|vend\w*|resumo|quanto entrou|arrecad\w*|lucro|ganhamos)\b/.test(t) && !/\babr\w*\b/.test(t)) return "RESUMO_OPERACAO";
  if (/\b(veiculo|veiculos|carro|carros|frota)\b/.test(t) && /\b(uso|status|combustivel|onde|quais)\b/.test(t)) return "STATUS_VEICULOS";
  if (/\b(movimentac|coleta|abastec|colocar|coloquei|repor|contador|entrada|saida)\b/.test(t) && !/\b(abr\w*|ir para|leva\w*|vai para)\b.*\bmovimentacoes$/.test(t)) return "NOVA_MOVIMENTACAO";
  if (inferirDestino(texto)) return "NAVEGAR";
  return null;
};

const interpretarLocal = (texto) => ({
  intent: inferirIntent(texto) || "DESCONHECIDO",
  destino: inferirDestino(texto),
  lojaId: null, lojaNome: null, maquinaId: null, maquinaNome: null,
  contadorIn: null, contadorOut: null, quantidadeAbastecida: null,
  descricao: null, mes: null,
  periodo: { dataInicio: null, dataFim: null, descricao: null },
  resposta: "",
  camposFaltantes: [],
});

// Completa o que a IA deixou em branco com regras locais + memória da conversa.
const completar = ({ interp, texto, lojas, maquinas, memoria }) => {
  const r = { ...interp, periodo: { ...(interp.periodo || {}) } };

  const intentLocal = inferirIntent(texto);
  if ((!r.intent || r.intent === "DESCONHECIDO") && intentLocal) r.intent = intentLocal;
  if (r.intent === "NAVEGAR" && !r.destino) r.destino = inferirDestino(texto);

  // Pedido curto de continuação ("e a máquina 2?") herda o contexto anterior.
  if ((!r.intent || ["DESCONHECIDO", "CONVERSA"].includes(r.intent)) && memoria?.intent && texto.split(" ").length <= 6) {
    r.intent = memoria.intent;
  }

  if (!r.lojaId) {
    const l = inferirLoja(texto, lojas);
    if (l) Object.assign(r, { lojaId: l.id, lojaNome: l.nome });
  }
  if (!r.lojaId && !r.lojaNome && memoria?.lojaId) Object.assign(r, { lojaId: memoria.lojaId, lojaNome: memoria.lojaNome });

  const lojaParaMaquina = resolverLoja(r, lojas);
  if (!r.maquinaId) {
    const m = inferirMaquina(texto, maquinas, lojaParaMaquina);
    if (m) Object.assign(r, { maquinaId: m.id, maquinaNome: m.nome || m.codigo });
  }
  if (!r.maquinaId && !r.maquinaNome && memoria?.maquinaId && r.intent === memoria.intent) {
    Object.assign(r, { maquinaId: memoria.maquinaId, maquinaNome: memoria.maquinaNome });
  }

  const nums = inferirNumeros(texto);
  for (const campo of ["contadorIn", "contadorOut", "quantidadeAbastecida"]) {
    if (!Number.isInteger(r[campo]) || r[campo] < 0) r[campo] = nums[campo];
  }

  if (!r.periodo.dataInicio || !r.periodo.dataFim) {
    const p = inferirPeriodo(texto);
    if (p) r.periodo = p;
    else if (memoria?.periodo?.dataInicio && r.intent === "GERAR_RELATORIO_LOJA") r.periodo = memoria.periodo;
  }

  if (r.intent === "REGISTRAR_MANUTENCAO" && !r.descricao) {
    r.descricao = texto.length <= 200 ? texto : texto.slice(0, 200);
  }
  return r;
};

const resolverLoja = (interp, lojas) => {
  if (interp.lojaId === TODAS_AS_LOJAS) return TODAS_AS_LOJAS;
  const porId = lojas.find((l) => l.id === interp.lojaId);
  if (porId) return porId;
  const alvo = normalizar(interp.lojaNome);
  if (!alvo) return null;
  return (
    lojas.find((l) => normalizar(l.nome) === alvo) ||
    lojas.find((l) => normalizar(l.nome).includes(alvo)) ||
    lojas.find((l) => alvo.includes(normalizar(l.nome))) ||
    inferirLoja(alvo, lojas)
  );
};

const resolverMaquina = (interp, maquinas, loja) => {
  const elegiveis = loja && loja !== TODAS_AS_LOJAS ? maquinas.filter((m) => m.lojaId === loja.id) : maquinas;
  const porId = elegiveis.find((m) => m.id === interp.maquinaId);
  if (porId) return porId;
  const alvo = normalizar(interp.maquinaNome);
  if (!alvo) return null;
  return (
    elegiveis.find((m) => normalizar(m.codigo) === alvo) ||
    elegiveis.find((m) => normalizar(m.nome) === alvo) ||
    elegiveis.find((m) => normalizar(`${m.codigo} ${m.nome} ${m.tipo}`).includes(alvo)) ||
    null
  );
};

// ------------------------------------------------------------- Executores

const pedir = (mensagem, campo, extra = {}) => ({
  status: "precisa_confirmacao",
  mensagem,
  camposFaltantes: [campo],
  ...extra,
});

const navegar = (rota, mensagem, extra = {}) => ({
  status: "executado",
  tipo: "navegacao",
  mensagem,
  acao: { tipo: "navegar", rota, ...extra },
});

const exec = {
  NAVEGAR: ({ interp }) => {
    const d = DESTINOS[interp.destino];
    if (!d) return pedir("Pra qual aba você quer ir? Ex: máquinas, manutenções, financeiro, relatórios...", "destino");
    return navegar(d.rota, `Abrindo ${d.nome}...`);
  },

  async CONSULTAR_ESTOQUE({ loja, lojas }) {
    const consultadas = loja === TODAS_AS_LOJAS ? lojas : [loja].filter(Boolean);
    if (!consultadas.length) {
      return pedir("De qual loja você quer ver o estoque? (ou diga \"todas as lojas\")", "loja");
    }
    const estoques = await EstoqueLoja.findAll({
      where: { ativo: true, lojaId: { [Op.in]: consultadas.map((l) => l.id) } },
      include: [{ model: Produto, as: "produto", attributes: ["id", "nome", "codigo", "emoji", "estoqueMinimo"] }],
    });
    const porLoja = new Map(consultadas.map((l) => [l.id, { loja: l, totalItens: 0, baixos: 0, produtos: [] }]));
    for (const e of estoques) {
      const g = porLoja.get(e.lojaId);
      if (!g) continue;
      const qtd = Number(e.quantidade || 0);
      const min = Number(e.estoqueMinimo || e.produto?.estoqueMinimo || 0);
      g.produtos.push({ nome: e.produto?.nome || "Produto", emoji: e.produto?.emoji || null, quantidade: qtd, estoqueMinimo: min, baixo: qtd <= min });
      g.totalItens += qtd;
      if (qtd <= min) g.baixos += 1;
    }
    const grupos = [...porLoja.values()].map((g) => ({
      ...g,
      produtos: g.produtos.sort((a, b) => a.nome.localeCompare(b.nome)),
    }));
    const total = grupos.reduce((s, g) => s + g.totalItens, 0);
    const mensagem =
      grupos.length === 1
        ? `${grupos[0].loja.nome} tem ${grupos[0].totalItens} itens em estoque${grupos[0].baixos ? ` (${grupos[0].baixos} produto(s) no mínimo ou abaixo)` : ""}.`
        : `As ${grupos.length} lojas somam ${total} itens em estoque.`;
    return {
      status: "executado",
      tipo: "estoque",
      mensagem,
      dados: {
        tabela: {
          colunas: grupos.length === 1 ? ["Produto", "Qtd", "Mín."] : ["Loja", "Itens", "Baixos"],
          linhas:
            grupos.length === 1
              ? grupos[0].produtos.map((p) => [`${p.emoji || ""} ${p.nome}`.trim(), p.quantidade, p.estoqueMinimo, p.baixo])
              : grupos.map((g) => [g.loja.nome, g.totalItens, g.baixos, g.baixos > 0]),
        },
      },
      atalhos: grupos.length === 1 ? [{ rotulo: "Ver loja", rota: `/lojas/${grupos[0].loja.id}` }] : [],
    };
  },

  async ESTOQUE_BAIXO({ loja, lojas }) {
    const where = { ativo: true };
    if (loja && loja !== TODAS_AS_LOJAS) where.lojaId = loja.id;
    const estoques = await EstoqueLoja.findAll({
      where,
      include: [{ model: Produto, as: "produto", attributes: ["nome", "emoji", "estoqueMinimo"] }],
    });
    const nomeLoja = new Map(lojas.map((l) => [l.id, l.nome]));
    const baixos = estoques
      .map((e) => ({
        loja: nomeLoja.get(e.lojaId) || "—",
        produto: `${e.produto?.emoji || ""} ${e.produto?.nome || "Produto"}`.trim(),
        qtd: Number(e.quantidade || 0),
        min: Number(e.estoqueMinimo || e.produto?.estoqueMinimo || 0),
      }))
      .filter((x) => x.qtd <= x.min)
      .sort((a, b) => a.qtd - a.min - (b.qtd - b.min));
    return {
      status: "executado",
      tipo: "estoque-baixo",
      mensagem: baixos.length
        ? `Tem ${baixos.length} produto(s) no mínimo ou abaixo${loja && loja !== TODAS_AS_LOJAS ? ` em ${loja.nome}` : ""}.`
        : "Tudo certo! Nenhum produto abaixo do mínimo. 🎉",
      dados: baixos.length
        ? { tabela: { colunas: ["Loja", "Produto", "Qtd", "Mín."], linhas: baixos.slice(0, 30).map((b) => [b.loja, b.produto, b.qtd, b.min, true]) } }
        : null,
      atalhos: [
        { rotulo: "Alertas de estoque", rota: "/alertas-estoque" },
        { rotulo: "Produtos a comprar", rota: "/compras/reposicao" },
      ],
    };
  },

  GERAR_RELATORIO_LOJA: ({ interp, loja }) => {
    if (!loja || loja === TODAS_AS_LOJAS) return pedir("De qual loja você quer o relatório?", "loja");
    const { dataInicio, dataFim, descricao } = interp.periodo || {};
    if (!dataInicio || !dataFim) {
      return pedir(`Qual período do relatório de ${loja.nome}? Ex: "mês passado", "outubro", "esta semana".`, "periodo");
    }
    const q = new URLSearchParams({ lojaId: loja.id, dataInicio, dataFim, autoGerar: "true" });
    return navegar(`/relatorios?${q}`, `Abrindo o relatório de ${loja.nome} (${descricao || `${dataInicio} a ${dataFim}`})...`);
  },

  async NOVA_MOVIMENTACAO({ interp, loja, maquina, usuario }) {
    if (!loja || loja === TODAS_AS_LOJAS) {
      return pedir("Em qual loja vai ser a movimentação?", "loja");
    }
    // A movimentação é feita dentro de um roteiro: procura o roteiro mais
    // recente que passa por essa loja (de preferência o do usuário).
    const vinculos = await RoteiroLoja.findAll({
      where: { lojaId: loja.id },
      attributes: ["roteiroId"],
      raw: true,
    });
    const ids = vinculos.map((v) => v.roteiroId);
    let roteiro = null;
    if (ids.length) {
      const candidatos = await Roteiro.findAll({
        where: { id: { [Op.in]: ids }, data: { [Op.lte]: hojeBR() } },
        order: [["data", "DESC"]],
        limit: 10,
        raw: true,
      });
      roteiro =
        candidatos.find((r) => r.funcionarioId === usuario?.id && r.status !== "concluido") ||
        candidatos.find((r) => r.status !== "concluido") ||
        candidatos[0] ||
        null;
    }
    const prefill = {
      maquinaId: maquina?.id || "",
      contadorIn: interp.contadorIn ?? "",
      contadorOut: interp.contadorOut ?? "",
      quantidadeAdicionada: interp.quantidadeAbastecida ?? "",
      origem: "MandaAI",
    };
    if (!roteiro) {
      return navegar(
        "/movimentacoes/roteiros",
        `${loja.nome} não está em nenhum roteiro ainda. Abri a seleção de roteiros pra você escolher.`,
      );
    }
    const partes = [
      maquina ? `máquina ${maquina.nome || maquina.codigo}` : null,
      Number.isInteger(interp.contadorIn) ? `IN ${interp.contadorIn}` : null,
      Number.isInteger(interp.contadorOut) ? `OUT ${interp.contadorOut}` : null,
      Number.isInteger(interp.quantidadeAbastecida) ? `+${interp.quantidadeAbastecida} pelúcias` : null,
    ].filter(Boolean);
    return navegar(
      `/movimentacoes/roteiro/${roteiro.id}/loja/${loja.id}`,
      `Abrindo a movimentação de ${loja.nome}${partes.length ? ` com ${partes.join(", ")}` : ""}. Confira e salve. 👍`,
      { state: prefill },
    );
  },

  ABRIR_LOJA: ({ loja }) => {
    if (!loja || loja === TODAS_AS_LOJAS) return navegar("/lojas", "Abrindo a lista de lojas...");
    return navegar(`/lojas/${loja.id}`, `Abrindo ${loja.nome}...`);
  },

  ABRIR_MAQUINA: ({ maquina, loja }) => {
    if (!maquina) {
      return pedir(`Qual máquina${loja && loja !== TODAS_AS_LOJAS ? ` de ${loja.nome}` : ""}? Diga o nome ou número.`, "maquina");
    }
    return navegar(`/maquinas/${maquina.id}`, `Abrindo a máquina ${maquina.nome || maquina.codigo}...`);
  },

  REGISTRAR_MANUTENCAO: ({ interp, loja, maquina }) => {
    if (!maquina) {
      return pedir(`Qual máquina está com problema${loja && loja !== TODAS_AS_LOJAS ? ` em ${loja.nome}` : ""}?`, "maquina");
    }
    const descricao = String(interp.descricao || "").trim();
    if (!descricao) return pedir("Qual é o problema da máquina?", "descricao");
    return {
      status: "confirmar_acao",
      tipo: "confirmacao",
      mensagem: `Abrir manutenção para ${maquina.nome || maquina.codigo}: "${descricao}"?`,
      acao: {
        tipo: "confirmar",
        operacao: "criar_manutencao",
        dados: { maquinaId: maquina.id, lojaId: maquina.lojaId, descricao },
      },
    };
  },

  async LISTAR_MANUTENCOES({ loja }) {
    const where = { status: { [Op.in]: ["pendente", "em_andamento"] } };
    if (loja && loja !== TODAS_AS_LOJAS) where.lojaId = loja.id;
    const lista = await Manutencao.findAll({
      where,
      include: [
        { model: Maquina, as: "maquina", attributes: ["nome", "codigo"] },
        { model: Loja, as: "loja", attributes: ["nome"] },
      ],
      order: [["createdAt", "ASC"]],
      limit: 30,
    });
    const dias = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
    return {
      status: "executado",
      tipo: "manutencoes",
      mensagem: lista.length
        ? `Tem ${lista.length} manutenção(ões) aberta(s). A mais antiga está há ${dias(lista[0].createdAt)} dia(s) esperando.`
        : "Nenhuma manutenção aberta. Tudo rodando! ✅",
      dados: lista.length
        ? {
            tabela: {
              colunas: ["Máquina", "Loja", "Problema", "Dias"],
              linhas: lista.map((m) => [
                m.maquina?.nome || m.maquina?.codigo || "—",
                m.loja?.nome || "—",
                m.descricao,
                dias(m.createdAt),
                dias(m.createdAt) >= 3,
              ]),
            },
          }
        : null,
      atalhos: [{ rotulo: "Abrir Manutenções", rota: "/manutencoes" }],
    };
  },

  async RESUMO_OPERACAO({ interp, usuario }) {
    const verValores = temPermissao(usuario, "dashboard.resumo", ["ADMIN", "FINANCEIRO"]);
    let mes = /^\d{4}-\d{2}$/.test(interp.mes || "") ? interp.mes : null;
    if (!mes && interp.periodo?.dataInicio) mes = interp.periodo.dataInicio.slice(0, 7);
    const r = await resumoDashboard({ usuario, mes, verValores });
    const [ano, m] = r.mes.split("-");
    const nomeMes = `${MESES_PT_BR[Number(m) - 1][0]}/${ano}`;
    if (!r.valores) {
      return {
        status: "executado",
        tipo: "resumo",
        mensagem: `Em ${nomeMes}: ${r.manutencoes.abertas} manutenção(ões) aberta(s). Valores financeiros só aparecem para admin/financeiro.`,
      };
    }
    const v = r.valores;
    const top = r.top?.maquinas?.[0];
    return {
      status: "executado",
      tipo: "resumo",
      mensagem: `Em ${nomeMes} as vendas somam ${formatarMoeda(v.vendasMes)} (${formatarMoeda(v.machinePay)} no Machine Pay e ${formatarMoeda(v.dinheiroFisico)} em dinheiro).${top ? ` Destaque: ${top.nome}${top.loja ? ` (${top.loja})` : ""} com ${formatarMoeda(top.total)}.` : ""}`,
      dados: {
        cards: [
          { rotulo: "Vendas do mês", valor: formatarMoeda(v.vendasMes) },
          { rotulo: "Machine Pay", valor: formatarMoeda(v.machinePay) },
          { rotulo: "Dinheiro", valor: formatarMoeda(v.dinheiroFisico) },
          { rotulo: "Gastos variáveis", valor: formatarMoeda(v.gastoVariavel) },
          { rotulo: "Manutenções abertas", valor: String(r.manutencoes.abertas) },
        ],
        tabela: r.top?.maquinas?.length
          ? { colunas: ["Top máquinas", "Loja", "Total"], linhas: r.top.maquinas.map((t) => [t.nome, t.loja || "—", formatarMoeda(t.total)]) }
          : null,
      },
      atalhos: [
        { rotulo: "Financeiro", rota: "/financeiro" },
        { rotulo: "Gráficos", rota: "/graficos" },
      ],
    };
  },

  async STATUS_VEICULOS() {
    const veiculos = await Veiculo.findAll({ order: [["nome", "ASC"]], raw: true });
    const emUso = veiculos.filter((v) => v.emUso);
    return {
      status: "executado",
      tipo: "veiculos",
      mensagem: veiculos.length
        ? `${emUso.length} de ${veiculos.length} veículo(s) em uso agora.`
        : "Nenhum veículo cadastrado ainda.",
      dados: veiculos.length
        ? {
            tabela: {
              colunas: ["Veículo", "Situação", "Combustível", "Km"],
              linhas: veiculos.map((v) => [
                `${v.emoji || ""} ${v.nome}`.trim(),
                v.parada ? "Parado" : v.emUso ? "Em uso" : "Livre",
                v.nivelCombustivel || "—",
                v.km ?? "—",
                Boolean(v.parada),
              ]),
            },
          }
        : null,
      atalhos: [{ rotulo: "Abrir Veículos", rota: "/veiculos" }],
    };
  },

  CONVERSA: ({ interp }) => ({
    status: "executado",
    tipo: "conversa",
    mensagem:
      interp.resposta ||
      "Oi! Eu sou a MandaAI. Manda aí: posso abrir qualquer aba, mostrar estoque, resumo do mês, manutenções, veículos, gerar relatório ou já abrir uma movimentação preenchida.",
  }),
};

// ---------------------------------------------------------------- Handlers

const buscarLojas = () =>
  Loja.findAll({ where: { ativo: true }, attributes: ["id", "nome", "cidade"], order: [["nome", "ASC"]], raw: true });

const buscarMaquinas = () =>
  Maquina.findAll({
    where: { ativo: true },
    attributes: ["id", "codigo", "nome", "tipo", "lojaId"],
    order: [["lojaId", "ASC"], ["codigo", "ASC"]],
    raw: true,
  });

const lerMemoria = (chave) => {
  const reg = memorias.get(chave);
  if (!reg) return null;
  if (Date.now() - reg.em > MEMORIA_TTL_MS) {
    memorias.delete(chave);
    return null;
  }
  return reg.memoria;
};

export const statusMandaAi = (req, res) =>
  res.json({
    assistente: ASSISTENTE,
    modo: process.env.OPENAI_API_KEY ? "ia" : "basico",
    sugestoes: [
      "Quanto vendemos este mês?",
      "Quais manutenções estão abertas?",
      "O que está acabando no estoque?",
      "Abre a aba de máquinas",
      "Relatório da loja do centro do mês passado",
      "Movimentação na máquina 2 da loja do centro, entrada 1500",
    ],
  });

export const processarComandoMandaAi = async (req, res) => {
  try {
    const texto = String(req.body?.texto || "").trim().slice(0, 800);
    if (!texto) return res.status(400).json({ error: "Manda aí a sua pergunta 🙂" });

    const historico = Array.isArray(req.body?.historico) ? req.body.historico.slice(-8) : [];
    const chave = req.usuario?.id || req.ip;
    const memoria = lerMemoria(chave);

    const [lojas, maquinas] = await Promise.all([buscarLojas(), buscarMaquinas()]);

    let interp;
    let modo = "ia";
    if (process.env.OPENAI_API_KEY) {
      try {
        interp = await chamarOpenAI({ texto, historico, lojas, maquinas, usuario: req.usuario });
      } catch (erro) {
        console.error("[MandaAI] OpenAI falhou, usando modo básico:", erro.message);
        interp = interpretarLocal(texto);
        modo = "basico";
      }
    } else {
      interp = interpretarLocal(texto);
      modo = "basico";
    }

    interp = completar({ interp, texto, lojas, maquinas, memoria });
    const loja = resolverLoja(interp, lojas);
    const maquina = resolverMaquina(interp, maquinas, loja);
    // Se só a máquina foi identificada, a loja vem dela.
    const lojaFinal = loja || (maquina ? lojas.find((l) => l.id === maquina.lojaId) || null : null);

    const executor = exec[interp.intent];
    const resultado = executor
      ? await executor({ interp, loja: lojaFinal, maquina, lojas, maquinas, usuario: req.usuario })
      : {
          status: "nao_entendido",
          mensagem:
            interp.resposta ||
            "Não entendi 🤔. Tenta assim: \"abre manutenções\", \"estoque da loja X\", \"resumo do mês\" ou \"relatório da loja X de outubro\".",
        };

    memorias.set(chave, {
      em: Date.now(),
      memoria: {
        intent: interp.intent,
        lojaId: lojaFinal && lojaFinal !== TODAS_AS_LOJAS ? lojaFinal.id : null,
        lojaNome: lojaFinal && lojaFinal !== TODAS_AS_LOJAS ? lojaFinal.nome : null,
        maquinaId: maquina?.id || null,
        maquinaNome: maquina?.nome || maquina?.codigo || null,
        periodo: interp.periodo?.dataInicio ? interp.periodo : null,
      },
    });

    return res.json({ assistente: ASSISTENTE, modo, intent: interp.intent, resultado });
  } catch (error) {
    console.error("[MandaAI] Erro:", error);
    return res.status(error.status || 500).json({
      error: "A MandaAI se enrolou aqui. Tenta de novo?",
      message: error.message,
    });
  }
};

// Executa uma ação que a MandaAI preparou e o usuário confirmou.
export const executarAcaoMandaAi = async (req, res) => {
  try {
    const { operacao, dados } = req.body || {};
    if (operacao === "criar_manutencao") {
      const descricao = String(dados?.descricao || "").trim().slice(0, 500);
      if (!descricao) return res.status(400).json({ error: "Descrição obrigatória" });
      const maquina = await Maquina.findByPk(dados?.maquinaId);
      if (!maquina) return res.status(404).json({ error: "Máquina não encontrada" });
      const manutencao = await Manutencao.create({
        maquinaId: maquina.id,
        lojaId: maquina.lojaId,
        descricao: `${descricao} (via MandaAI)`,
        funcionarioId: req.usuario?.role === "FUNCIONARIO" ? req.usuario.id : null,
        status: "pendente",
      });
      return res.status(201).json({
        mensagem: `Pronto! Manutenção aberta para ${maquina.nome || maquina.codigo}. 🔧`,
        manutencaoId: manutencao.id,
        atalhos: [{ rotulo: "Ver manutenções", rota: "/manutencoes" }],
      });
    }
    return res.status(400).json({ error: "Operação desconhecida" });
  } catch (error) {
    console.error("[MandaAI] Erro ao executar ação:", error);
    return res.status(500).json({ error: "Não consegui concluir a ação", message: error.message });
  }
};
