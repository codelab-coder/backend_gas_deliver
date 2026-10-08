/**
 * API do Gas OS (plataforma para revenda de GLP)
 * -------------------------------------------------------------
 * Node + Express, sem banco externo: os dados ficam em um arquivo
 * JSON (data.json), gravado de forma atômica. Para trocar por
 * Postgres/Mongo depois, substitua o bloco "BANCO DE DADOS": as
 * rotas só usam o objeto `banco`.
 *
 * Principais recursos (MVP comercial):
 *  - Multiempresa: todo dado pertence a uma revenda; o acesso é sempre
 *    derivado do usuário autenticado (nunca do que o app envia).
 *  - JWT de curta duração + refresh token rotativo, logout, limite de
 *    tentativas de login e auditoria de ações.
 *  - Pedido/entrega com pagamento, vasilhames, ordem de rota e
 *    idempotência (reenvio offline do app não duplica pedidos).
 *  - Estoque de cheios/vazios com baixa automática na entrega.
 *  - Radar de recompra, financeiro, dashboard e planos por revenda.
 *
 * Variáveis de ambiente:
 *  JWT_SECRET (obrigatório em produção), JWT_EXPIRES_IN (padrão 2h),
 *  REFRESH_DAYS (30), CORS_ORIGIN (lista separada por vírgula),
 *  DATA_FILE, ADMIN_NOME, ADMIN_EMAIL, SENHA_PADRAO, TZ_OFFSET_HORAS (-3),
 *  MIGRAR_ENTREGUES_COMO_PAGAS (true), PORT.
 *
 * Subir local:   npm install && npm run dev
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PRODUCAO = process.env.NODE_ENV === 'production';
const PORTA = process.env.PORT || 3000;
const EXPIRACAO = process.env.JWT_EXPIRES_IN || '2h';
const REFRESH_DIAS = Number(process.env.REFRESH_DAYS) || 30;
const OFFSET_HORAS = Number.isFinite(Number(process.env.TZ_OFFSET_HORAS))
  ? Number(process.env.TZ_OFFSET_HORAS)
  : -3;
const ARQUIVO_DADOS =
  process.env.DATA_FILE || path.join(__dirname, 'data.json');

if (!process.env.JWT_SECRET && PRODUCAO) {
  console.error('[erro] Defina JWT_SECRET antes de rodar em produção.');
  process.exit(1);
}
const SEGREDO = process.env.JWT_SECRET || 'dev-segredo-nao-usar-em-producao';
if (!process.env.JWT_SECRET) {
  console.warn('[aviso] JWT_SECRET não definido (use apenas em desenvolvimento).');
}

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render fica atrás de proxy
app.use(
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
      : '*',
    exposedHeaders: ['Idempotency-Key'],
  })
);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (PRODUCAO) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

// =============================================================
// CONSTANTES
// =============================================================

const PAPEIS = ['entregador', 'telemarketing', 'admin'];
const STATUS = ['pendente', 'separacao', 'em_rota', 'entregue', 'cancelada'];
const STATUS_ABERTOS = ['pendente', 'separacao', 'em_rota'];
const FORMAS = ['dinheiro', 'pix', 'cartao', 'a_prazo'];
const STATUS_PAGAMENTO = ['pendente', 'pago', 'cancelado'];
const TIPOS_CLIENTE = ['residencial', 'comercial', 'empresarial'];
const RESULTADOS = ['venda', 'retornar', 'sem_interesse', 'nao_atendeu'];
const CANAIS = ['ligacao', 'whatsapp'];
const TIPOS_BOTIJAO = ['P13', 'P20', 'P45', 'P90', 'Granel'];
const TIPOS_ESTOQUE = ['P13', 'P20', 'P45', 'P90'];

/** Limites por plano (null = ilimitado). Plano "piloto" não limita. */
const PLANOS = {
  piloto: { usuarios: null, clientes: null, pedidosMes: null },
  essencial: { usuarios: 5, clientes: 300, pedidosMes: 500 },
  profissional: { usuarios: 15, clientes: 2000, pedidosMes: 3000 },
  operacao: { usuarios: null, clientes: null, pedidosMes: null },
};

// =============================================================
// BANCO DE DADOS (arquivo JSON)
// =============================================================

let banco = vazio();

function vazio() {
  return {
    revendas: [],
    usuarios: [],
    clientes: [],
    entregas: [],
    contatos: [],
    produtos: [],
    estoque: [],
    movimentosEstoque: [],
    sessoes: [],
    auditoria: [],
  };
}

function novoId() {
  return crypto.randomUUID();
}

function agora() {
  return new Date().toISOString();
}

function carregar() {
  try {
    if (fs.existsSync(ARQUIVO_DADOS)) {
      const lido = JSON.parse(fs.readFileSync(ARQUIVO_DADOS, 'utf8'));
      banco = { ...vazio(), ...lido };
      for (const chave of Object.keys(vazio())) {
        if (!Array.isArray(banco[chave])) banco[chave] = [];
      }
      console.log(`Dados carregados de ${ARQUIVO_DADOS}`);
      if (migrar()) salvar();
      return;
    }
  } catch (erro) {
    console.error('Falha ao ler o arquivo de dados:', erro.message);
  }
  semear();
}

/** Gravação atômica: escreve em arquivo temporário e renomeia. */
function salvar() {
  try {
    const temporario = `${ARQUIVO_DADOS}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(banco));
    fs.renameSync(temporario, ARQUIVO_DADOS);
  } catch (erro) {
    // No Render gratuito o disco é efêmero e pode estar em modo leitura.
    console.error('Não foi possível gravar os dados:', erro.message);
  }
}

function diasAtras(dias) {
  const data = new Date();
  data.setDate(data.getDate() - dias);
  return data.toISOString();
}

/**
 * Converte a base da versão antiga (sem revenda) para o modelo
 * multiempresa. Retorna true se algo foi alterado.
 */
function migrar() {
  let mudou = false;

  if (banco.revendas.length === 0) {
    banco.revendas.push({
      id: novoId(),
      nome: process.env.REVENDA_NOME || 'Minha Revenda',
      cnpj: '',
      cidade: '',
      status: 'ativa',
      plano: 'piloto',
      precoTravado: false,
      criadaEm: agora(),
    });
    mudou = true;
  }
  const padrao = banco.revendas[0].id;
  const pagarEntregues = process.env.MIGRAR_ENTREGUES_COMO_PAGAS !== 'false';

  banco.usuarios.forEach((u, i) => {
    if (!u.revendaId) {
      u.revendaId = padrao;
      mudou = true;
    }
    if (u.adminGlobal === undefined) {
      u.adminGlobal = u.papel === 'admin' && i === banco.usuarios.findIndex((x) => x.papel === 'admin');
      mudou = true;
    }
  });
  for (const c of banco.clientes) {
    if (!c.revendaId) {
      c.revendaId = padrao;
      c.tipo = c.tipo || 'residencial';
      c.produtoHabitual = c.produtoHabitual || '';
      c.quantidadeHabitual = c.quantidadeHabitual || 1;
      mudou = true;
    }
  }
  for (const e of banco.entregas) {
    if (!e.revendaId) {
      e.revendaId = padrao;
      e.endereco = e.endereco || '';
      e.vasilhamesRecolhidos = e.vasilhameDevolvido ? e.quantidade : 0;
      e.formaPagamento = e.formaPagamento || 'dinheiro';
      e.statusPagamento =
        e.status === 'cancelada'
          ? 'cancelado'
          : e.status === 'entregue' && pagarEntregues
            ? 'pago'
            : 'pendente';
      e.pagoEm = e.statusPagamento === 'pago' ? e.entregueEm || e.criadaEm : null;
      e.recebidoPor = e.recebidoPor || '';
      e.ordemRota = e.ordemRota || 0;
      e.entregadorId = e.entregadorId || null;
      mudou = true;
    }
  }
  for (const c of banco.contatos) {
    if (!c.revendaId) {
      c.revendaId = padrao;
      c.proximaAcao = c.proximaAcao || null;
      c.canal = c.canal || 'ligacao';
      mudou = true;
    }
  }
  return mudou;
}

/** Cria a base inicial com uma revenda de demonstração. */
function semear() {
  const senhaPadrao = process.env.SENHA_PADRAO || '123456';
  const hash = bcrypt.hashSync(senhaPadrao, 10);
  const revenda = {
    id: novoId(),
    nome: 'Revenda Demo Gás Sul',
    cnpj: '',
    cidade: 'São Paulo',
    status: 'ativa',
    plano: 'piloto',
    precoTravado: false,
    criadaEm: agora(),
  };
  banco.revendas = [revenda];

  const usuario = (nome, email, papel, extra = {}) => ({
    id: novoId(),
    revendaId: revenda.id,
    nome,
    email: email.toLowerCase(),
    papel,
    ativo: true,
    adminGlobal: false,
    senhaHash: hash,
    criadoEm: agora(),
    ...extra,
  });

  const entregador = usuario('João Ribeiro', 'entregador@app.com', 'entregador');
  banco.usuarios = [
    usuario(
      process.env.ADMIN_NOME || 'Administrador',
      process.env.ADMIN_EMAIL || 'admin@app.com',
      'admin',
      { adminGlobal: true }
    ),
    entregador,
    usuario('Maria Duarte', 'telemarketing@app.com', 'telemarketing'),
  ];

  const cliente = (nome, telefone, endereco, cidade, dias, intervalo, tipo, prod, qtd, obs = '') => ({
    id: novoId(),
    revendaId: revenda.id,
    nome,
    telefone,
    endereco,
    cidade,
    ultimaCompra: dias === null ? null : diasAtras(dias),
    intervaloDias: intervalo,
    observacoes: obs,
    tipo,
    produtoHabitual: prod,
    quantidadeHabitual: qtd,
  });

  banco.clientes = [
    cliente('Padaria Estrela', '11987654321', 'Rua das Acácias, 120', 'São Paulo', 28, 30, 'comercial', 'P45', 4, 'Entregar sempre antes das 9h.'),
    cliente('Mercearia do Zé', '11991234567', 'Av. Brasil, 890', 'Guarulhos', 35, 30, 'comercial', 'P13', 8),
    cliente('Café Central', '11944445555', 'Praça da Sé, 10', 'São Paulo', 5, 21, 'comercial', 'P13', 3),
  ];

  banco.produtos = TIPOS_ESTOQUE.map((tipo, i) => ({
    id: novoId(),
    revendaId: revenda.id,
    tipo,
    nome: `Botijão de gás ${tipo}`,
    preco: [115, 145, 210, 420][i],
    ativo: true,
  }));

  banco.estoque = [
    ['P13', 40, 12, 20],
    ['P20', 6, 4, 8],
    ['P45', 10, 3, 5],
    ['P90', 3, 1, 2],
  ].map(([tipo, cheios, vazios, minimo]) => ({
    revendaId: revenda.id,
    tipo,
    cheios,
    vazios,
    minimo,
  }));

  const pedido = (c, produto, quantidade, valor, status, dias, extra = {}) => ({
    id: novoId(),
    revendaId: revenda.id,
    clienteId: c.id,
    clienteNome: c.nome,
    produto,
    quantidade,
    valor,
    status,
    criadaEm: diasAtras(dias),
    entregueEm: status === 'entregue' ? diasAtras(dias) : null,
    observacao: '',
    endereco: [c.endereco, c.cidade].filter(Boolean).join(', '),
    entregadorId: entregador.id,
    entregadorNome: entregador.nome,
    vasilhamesRecolhidos: 0,
    formaPagamento: 'dinheiro',
    statusPagamento: 'pendente',
    pagoEm: null,
    recebidoPor: '',
    ordemRota: 0,
    chaveIdempotencia: null,
    ...extra,
  });

  banco.entregas = [
    pedido(banco.clientes[0], 'Botijão de gás P45', 4, 210, 'entregue', 2, {
      vasilhamesRecolhidos: 4,
      formaPagamento: 'pix',
      statusPagamento: 'pago',
      pagoEm: diasAtras(2),
      recebidoPor: 'Sr. Antônio',
    }),
    pedido(banco.clientes[2], 'Botijão de gás P13', 3, 115, 'pendente', 0, { ordemRota: 1 }),
  ];

  banco.contatos = [];
  salvar();
  console.log(`Base criada. Entre com admin@app.com e a senha "${senhaPadrao}".`);
}

// =============================================================
// AUXILIARES
// =============================================================

class ErroHttp extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Envolve rotas async para que erros caiam no handler central. */
const rota = (funcao) => (req, res, next) =>
  Promise.resolve(funcao(req, res, next)).catch(next);

function texto(valor, padrao = '') {
  if (valor === undefined || valor === null) return padrao;
  return String(valor).trim();
}

function numero(valor, padrao = 0) {
  const convertido = Number(
    typeof valor === 'string' ? valor.replace(',', '.') : valor
  );
  return Number.isFinite(convertido) ? convertido : padrao;
}

function inteiro(valor, padrao = 0) {
  return Math.round(numero(valor, padrao));
}

function exigir(condicao, mensagem, status = 400) {
  if (!condicao) throw new ErroHttp(status, mensagem);
}

function dataValida(valor) {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

function semSenha(usuario) {
  if (!usuario) return null;
  const { senhaHash, ...resto } = usuario;
  const revenda = banco.revendas.find((r) => r.id === usuario.revendaId);
  return { ...resto, revendaNome: revenda ? revenda.nome : '' };
}

/** Busca dentro da revenda do pedido; devolve 404 mesmo se for de outra. */
function acharOu404(lista, id, nome, req) {
  const item = lista.find(
    (i) => i.id === id && (!req || !i.revendaId || i.revendaId === req.revendaId)
  );
  if (!item) throw new ErroHttp(404, `${nome} não encontrado.`);
  return item;
}

const daRevenda = (lista, req) => lista.filter((i) => i.revendaId === req.revendaId);

// ---- datas no fuso da revenda ----

function chaveDia(data) {
  const base = new Date(data).getTime() + OFFSET_HORAS * 3600000;
  return new Date(base).toISOString().slice(0, 10);
}

const hojeChave = () => chaveDia(Date.now());

function diferencaDias(deChave, ateChave) {
  return Math.round(
    (Date.parse(`${ateChave}T00:00:00Z`) - Date.parse(`${deChave}T00:00:00Z`)) /
      86400000
  );
}

function corteDoPeriodo(dias) {
  const corte = new Date(Date.parse(`${hojeChave()}T00:00:00Z`));
  corte.setUTCDate(corte.getUTCDate() - (dias - 1));
  return corte.toISOString().slice(0, 10);
}

/** dias = número de dias (1 = hoje); null/"tudo" = sem filtro. */
function noPeriodo(lista, dias) {
  if (!dias) return lista;
  const corte = corteDoPeriodo(dias);
  return lista.filter((e) => chaveDia(e.criadaEm) >= corte);
}

function lerPeriodo(valor, padrao = 7) {
  if (valor === 'tudo' || valor === 'todos') return null;
  const n = inteiro(valor, padrao);
  return n > 0 ? n : padrao;
}

// ---- regras de negócio ----

function tipoDoProduto(produto) {
  const t = String(produto || '').toUpperCase();
  const achado = TIPOS_BOTIJAO.find((tipo) => t.includes(tipo.toUpperCase()));
  return achado || 'Outro';
}

const totalDoPedido = (e) => e.valor * e.quantidade;

function vasilhamesPendentes(e) {
  if (e.status !== 'entregue') return 0;
  return Math.max(0, e.quantidade - (e.vasilhamesRecolhidos || 0));
}

function valorPendente(e) {
  if (e.status === 'cancelada' || e.statusPagamento === 'pago') return 0;
  return totalDoPedido(e);
}

function saidaEntrega(e) {
  return {
    ...e,
    total: Number(totalDoPedido(e).toFixed(2)),
    vasilhameDevolvido: (e.vasilhamesRecolhidos || 0) >= e.quantidade,
    vasilhamesPendentes: vasilhamesPendentes(e),
  };
}

function diasParaRecompra(cliente) {
  if (!cliente.ultimaCompra) return null;
  const previsao =
    new Date(cliente.ultimaCompra).getTime() + cliente.intervaloDias * 86400000;
  return diferencaDias(hojeChave(), chaveDia(previsao));
}

function prioridadeRecompra(cliente) {
  const dias = diasParaRecompra(cliente);
  if (dias === null) return 'sem_historico';
  if (dias <= -cliente.intervaloDias) return 'recuperacao';
  if (dias <= 0) return 'hoje';
  if (dias <= 3) return 'proximos3';
  if (dias <= 7) return 'proximos7';
  return 'em_dia';
}

function saidaCliente(c) {
  const dias = diasParaRecompra(c);
  return {
    ...c,
    diasParaRecompra: dias,
    proximaCompra: c.ultimaCompra
      ? new Date(new Date(c.ultimaCompra).getTime() + c.intervaloDias * 86400000).toISOString()
      : null,
    prioridade: prioridadeRecompra(c),
  };
}

const temPedidoAberto = (clienteId, req) =>
  banco.entregas.some(
    (e) =>
      e.revendaId === req.revendaId &&
      e.clienteId === clienteId &&
      STATUS_ABERTOS.includes(e.status)
  );

/** Retorno combinado com o cliente, se ainda estiver no futuro. */
function retornoAgendado(clienteId, req) {
  const ultimo = banco.contatos
    .filter((c) => c.revendaId === req.revendaId && c.clienteId === clienteId)
    .sort((a, b) => new Date(b.data) - new Date(a.data))[0];
  if (!ultimo || !ultimo.proximaAcao) return null;
  return chaveDia(ultimo.proximaAcao) > hojeChave() ? ultimo.proximaAcao : null;
}

// ---- estoque ----

function itemEstoque(revendaId, tipo) {
  return banco.estoque.find((i) => i.revendaId === revendaId && i.tipo === tipo);
}

function registrarMovimento(revendaId, item, deltaCheios, deltaVazios, motivo, usuario, referencia = null) {
  banco.movimentosEstoque.push({
    id: novoId(),
    revendaId,
    tipo: item.tipo,
    cheios: deltaCheios,
    vazios: deltaVazios,
    motivo,
    referencia,
    usuarioId: usuario ? usuario.id : null,
    data: agora(),
  });
  if (banco.movimentosEstoque.length > 20000) banco.movimentosEstoque.splice(0, 2000);
}

/** Só movimenta se o controle de estoque do tipo já foi iniciado. */
function movimentarEstoque(revendaId, tipo, cheios, vazios, motivo, usuario, referencia) {
  const item = itemEstoque(revendaId, tipo);
  if (!item) return;
  const novoCheios = Math.max(0, item.cheios + cheios);
  const novoVazios = Math.max(0, item.vazios + vazios);
  registrarMovimento(revendaId, item, novoCheios - item.cheios, novoVazios - item.vazios, motivo, usuario, referencia);
  item.cheios = novoCheios;
  item.vazios = novoVazios;
}

/** Efeitos de uma entrega: estoque e última compra do cliente. */
function aplicarEfeitos(antes, depois, usuario) {
  const eraEntregue = antes && antes.status === 'entregue';
  const ficouEntregue = depois.status === 'entregue';
  const tipo = tipoDoProduto(depois.produto);

  if (!eraEntregue && ficouEntregue) {
    movimentarEstoque(depois.revendaId, tipo, -depois.quantidade, depois.vasilhamesRecolhidos || 0, 'entrega', usuario, depois.id);
    const cliente = banco.clientes.find((c) => c.id === depois.clienteId);
    if (cliente) {
      const data = depois.entregueEm || agora();
      if (!cliente.ultimaCompra || new Date(data) > new Date(cliente.ultimaCompra)) {
        cliente.ultimaCompra = data;
      }
    }
  } else if (eraEntregue && !ficouEntregue) {
    movimentarEstoque(antes.revendaId, tipoDoProduto(antes.produto), antes.quantidade, -(antes.vasilhamesRecolhidos || 0), 'estorno_entrega', usuario, antes.id);
  } else if (eraEntregue && ficouEntregue) {
    const diferenca = (depois.vasilhamesRecolhidos || 0) - (antes.vasilhamesRecolhidos || 0);
    if (diferenca !== 0) {
      movimentarEstoque(depois.revendaId, tipo, 0, diferenca, 'ajuste_vasilhame', usuario, depois.id);
    }
  }
}

// ---- planos ----

function exigirLimite(revendaId, recurso, quantidadeAtual) {
  const revenda = banco.revendas.find((r) => r.id === revendaId);
  const limite = (PLANOS[revenda && revenda.plano] || PLANOS.piloto)[recurso];
  if (limite !== null && limite !== undefined && quantidadeAtual >= limite) {
    throw new ErroHttp(403, `Limite do plano atingido (${recurso}: ${limite}). Fale com o suporte para ampliar.`);
  }
}

// ---- auditoria ----

function auditar(req, acao, entidade, entidadeId, detalhes = {}) {
  banco.auditoria.push({
    id: novoId(),
    revendaId: req.revendaId,
    usuarioId: req.usuario.id,
    usuarioNome: req.usuario.nome,
    acao,
    entidade,
    entidadeId,
    detalhes,
    ip: req.ip,
    data: agora(),
  });
  if (banco.auditoria.length > 5000) banco.auditoria.splice(0, 500);
}

// =============================================================
// AUTENTICAÇÃO
// =============================================================

const tentativasLogin = new Map();
const JANELA_LOGIN_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 10;

function checarLimiteLogin(chave) {
  const registro = tentativasLogin.get(chave);
  if (!registro) return;
  if (Date.now() - registro.inicio > JANELA_LOGIN_MS) {
    tentativasLogin.delete(chave);
    return;
  }
  if (registro.n >= MAX_TENTATIVAS) {
    throw new ErroHttp(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  }
}

function registrarFalhaLogin(chave) {
  const registro = tentativasLogin.get(chave);
  if (!registro || Date.now() - registro.inicio > JANELA_LOGIN_MS) {
    tentativasLogin.set(chave, { n: 1, inicio: Date.now() });
  } else {
    registro.n += 1;
  }
}

function emitirTokens(usuario) {
  const access_token = jwt.sign(
    {
      sub: usuario.id,
      papel: usuario.papel,
      email: usuario.email,
      revendaId: usuario.revendaId,
    },
    SEGREDO,
    { expiresIn: EXPIRACAO }
  );

  const refresh_token = crypto.randomBytes(48).toString('base64url');
  const agoraMs = Date.now();
  banco.sessoes = banco.sessoes.filter((s) => new Date(s.expiraEm).getTime() > agoraMs);
  banco.sessoes.push({
    id: novoId(),
    usuarioId: usuario.id,
    hash: sha256(refresh_token),
    criadaEm: agora(),
    expiraEm: new Date(agoraMs + REFRESH_DIAS * 86400000).toISOString(),
  });
  return { access_token, refresh_token };
}

function revendaDoUsuario(usuario) {
  const revenda = banco.revendas.find((r) => r.id === usuario.revendaId);
  if (!revenda) throw new ErroHttp(403, 'Revenda não encontrada.');
  if (revenda.status !== 'ativa') {
    throw new ErroHttp(403, 'Revenda suspensa. Fale com o suporte.');
  }
  return revenda;
}

function autenticar(req, res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) {
    return next(new ErroHttp(401, 'Envie o token de acesso.'));
  }

  let conteudo;
  try {
    conteudo = jwt.verify(token, SEGREDO);
  } catch (erro) {
    return next(new ErroHttp(401, 'Sessão expirada. Entre novamente.'));
  }

  const usuario = banco.usuarios.find((u) => u.id === conteudo.sub);
  if (!usuario || !usuario.ativo) {
    return next(new ErroHttp(401, 'Sessão inválida. Entre novamente.'));
  }

  try {
    revendaDoUsuario(usuario);
    req.usuario = usuario;
    req.revendaId = usuario.revendaId;

    // Somente o administrador global pode operar outra revenda.
    const alvo = texto(req.headers['x-revenda-id'] || req.query.revendaId);
    if (alvo && alvo !== usuario.revendaId) {
      exigir(usuario.adminGlobal, 'Você não tem permissão para esta revenda.', 403);
      exigir(banco.revendas.some((r) => r.id === alvo), 'Revenda não encontrada.', 404);
      req.revendaId = alvo;
    }
    next();
  } catch (erro) {
    next(erro);
  }
}

/** Libera a rota apenas para os papéis informados (admin sempre passa). */
function exigirPapel(...papeis) {
  return (req, res, next) => {
    if (req.usuario.papel === 'admin' || papeis.includes(req.usuario.papel)) {
      return next();
    }
    next(new ErroHttp(403, 'Você não tem permissão para esta ação.'));
  };
}

function exigirGlobal(req, res, next) {
  if (req.usuario.adminGlobal) return next();
  next(new ErroHttp(403, 'Apenas o administrador global pode fazer isso.'));
}

// =============================================================
// ROTAS PÚBLICAS
// =============================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '2.0.0', horario: agora() });
});

app.get('/', (req, res) => {
  res.json({
    nome: 'API Gas OS',
    versao: '2.0.0',
    rotas: [
      '/health', '/auth/login', '/auth/refresh', '/auth/logout', '/auth/me',
      '/revendas', '/usuarios', '/clientes', '/pedidos|/entregas', '/produtos',
      '/estoque', '/vasilhames', '/contatos', '/recompra/radar', '/pagamentos',
      '/financeiro/resumo', '/dashboard/resumo', '/dashboard/series', '/auditoria',
    ],
  });
});

app.post(
  '/auth/login',
  rota(async (req, res) => {
    const email = texto(req.body.email).toLowerCase();
    const senha = texto(req.body.senha || req.body.password);
    exigir(email && senha, 'Informe e-mail e senha.');

    const chave = `${req.ip}|${email}`;
    checarLimiteLogin(chave);

    const usuario = banco.usuarios.find((u) => u.email === email);
    const confere = usuario && (await bcrypt.compare(senha, usuario.senhaHash || ''));
    if (!confere) {
      registrarFalhaLogin(chave);
      throw new ErroHttp(401, 'E-mail ou senha inválidos.');
    }
    if (!usuario.ativo) throw new ErroHttp(403, 'Usuário desativado.');
    const revenda = revendaDoUsuario(usuario);

    tentativasLogin.delete(chave);
    const tokens = emitirTokens(usuario);
    usuario.ultimoLoginEm = agora();
    salvar();

    res.json({
      ...tokens,
      usuario: semSenha(usuario),
      revenda: { id: revenda.id, nome: revenda.nome, plano: revenda.plano },
    });
  })
);

/** Troca o refresh token por um novo par (o antigo deixa de valer). */
app.post(
  '/auth/refresh',
  rota((req, res) => {
    const recebido = texto(req.body.refreshToken || req.body.refresh_token);
    exigir(recebido, 'Informe o refresh token.', 401);

    const hash = sha256(recebido);
    const indice = banco.sessoes.findIndex((s) => s.hash === hash);
    if (indice < 0) throw new ErroHttp(401, 'Sessão inválida. Entre novamente.');

    const sessao = banco.sessoes[indice];
    banco.sessoes.splice(indice, 1);
    if (new Date(sessao.expiraEm).getTime() < Date.now()) {
      salvar();
      throw new ErroHttp(401, 'Sessão expirada. Entre novamente.');
    }

    const usuario = banco.usuarios.find((u) => u.id === sessao.usuarioId);
    if (!usuario || !usuario.ativo) {
      throw new ErroHttp(401, 'Sessão inválida. Entre novamente.');
    }
    revendaDoUsuario(usuario);

    const tokens = emitirTokens(usuario);
    salvar();
    res.json(tokens);
  })
);

// A partir daqui, tudo exige token.
app.use(autenticar);

/** Encerra a sessão: revoga o refresh informado ou todos do usuário. */
app.post(
  '/auth/logout',
  rota((req, res) => {
    const recebido = texto(req.body && (req.body.refreshToken || req.body.refresh_token));
    if (recebido) {
      const hash = sha256(recebido);
      banco.sessoes = banco.sessoes.filter((s) => s.hash !== hash);
    } else {
      banco.sessoes = banco.sessoes.filter((s) => s.usuarioId !== req.usuario.id);
    }
    salvar();
    res.status(204).end();
  })
);

app.get('/auth/me', (req, res) => {
  const revenda = banco.revendas.find((r) => r.id === req.usuario.revendaId);
  res.json({ ...semSenha(req.usuario), revenda });
});

app.patch(
  '/auth/senha',
  rota(async (req, res) => {
    const atual = texto(req.body.senhaAtual);
    const nova = texto(req.body.novaSenha);
    exigir(nova.length >= 6, 'A nova senha precisa ter ao menos 6 caracteres.');

    const confere = await bcrypt.compare(atual, req.usuario.senhaHash || '');
    if (!confere) throw new ErroHttp(400, 'Senha atual incorreta.');

    req.usuario.senhaHash = await bcrypt.hash(nova, 10);
    // Derruba as outras sessões após a troca de senha.
    banco.sessoes = banco.sessoes.filter((s) => s.usuarioId !== req.usuario.id);
    auditar(req, 'senha_alterada', 'usuario', req.usuario.id);
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// REVENDAS (SaaS)
// =============================================================

app.get('/revendas', (req, res) => {
  const lista = req.usuario.adminGlobal
    ? banco.revendas
    : banco.revendas.filter((r) => r.id === req.usuario.revendaId);
  res.json(lista);
});

app.get('/revendas/:id', (req, res) => {
  const revenda = banco.revendas.find((r) => r.id === req.params.id);
  if (!revenda || (!req.usuario.adminGlobal && revenda.id !== req.usuario.revendaId)) {
    throw new ErroHttp(404, 'Revenda não encontrada.');
  }
  res.json({
    ...revenda,
    uso: {
      usuarios: banco.usuarios.filter((u) => u.revendaId === revenda.id).length,
      clientes: banco.clientes.filter((c) => c.revendaId === revenda.id).length,
    },
    limites: PLANOS[revenda.plano] || PLANOS.piloto,
  });
});

app.post(
  '/revendas',
  exigirGlobal,
  rota(async (req, res) => {
    const nome = texto(req.body.nome);
    exigir(nome.length >= 2, 'Informe o nome da revenda.');
    const plano = PLANOS[req.body.plano] ? req.body.plano : 'piloto';

    const dono = req.body.admin || {};
    const email = texto(dono.email).toLowerCase();
    exigir(texto(dono.nome).length >= 2, 'Informe o nome do administrador da revenda.');
    exigir(EMAIL_VALIDO.test(email), 'E-mail do administrador inválido.');
    exigir(texto(dono.senha).length >= 6, 'A senha do administrador precisa ter ao menos 6 caracteres.');
    exigir(!banco.usuarios.some((u) => u.email === email), 'Já existe um usuário com este e-mail.');

    const revenda = {
      id: novoId(),
      nome,
      cnpj: texto(req.body.cnpj),
      cidade: texto(req.body.cidade),
      status: 'ativa',
      plano,
      precoTravado: false,
      criadaEm: agora(),
    };
    banco.revendas.push(revenda);

    const admin = {
      id: novoId(),
      revendaId: revenda.id,
      nome: texto(dono.nome),
      email,
      papel: 'admin',
      ativo: true,
      adminGlobal: false,
      senhaHash: await bcrypt.hash(texto(dono.senha), 10),
      criadoEm: agora(),
    };
    banco.usuarios.push(admin);

    banco.produtos.push(
      ...TIPOS_ESTOQUE.map((tipo) => ({
        id: novoId(),
        revendaId: revenda.id,
        tipo,
        nome: `Botijão de gás ${tipo}`,
        preco: 0,
        ativo: true,
      }))
    );

    auditar(req, 'revenda_criada', 'revenda', revenda.id, { nome, plano });
    salvar();
    res.status(201).json({ revenda, admin: semSenha(admin) });
  })
);

app.patch(
  '/revendas/:id',
  exigirPapel(),
  rota((req, res) => {
    const revenda = banco.revendas.find((r) => r.id === req.params.id);
    const propria = revenda && revenda.id === req.usuario.revendaId;
    if (!revenda || (!req.usuario.adminGlobal && !propria)) {
      throw new ErroHttp(404, 'Revenda não encontrada.');
    }

    if (req.body.nome !== undefined) {
      exigir(texto(req.body.nome).length >= 2, 'Informe o nome da revenda.');
      revenda.nome = texto(req.body.nome);
    }
    if (req.body.cidade !== undefined) revenda.cidade = texto(req.body.cidade);
    if (req.body.cnpj !== undefined) revenda.cnpj = texto(req.body.cnpj);
    if (req.body.precoTravado !== undefined) revenda.precoTravado = Boolean(req.body.precoTravado);

    // Plano e situação (cobrança) só o administrador global altera.
    if (req.usuario.adminGlobal) {
      if (req.body.plano !== undefined) {
        exigir(PLANOS[req.body.plano], 'Plano inválido.');
        revenda.plano = req.body.plano;
      }
      if (req.body.status !== undefined) {
        exigir(['ativa', 'suspensa'].includes(req.body.status), 'Situação inválida.');
        revenda.status = req.body.status;
      }
    }

    auditar(req, 'revenda_atualizada', 'revenda', revenda.id, req.body);
    salvar();
    res.json(revenda);
  })
);

// =============================================================
// CLIENTES
// =============================================================

function montarCliente(corpo, base = {}, req) {
  const nome = texto(corpo.nome ?? base.nome);
  exigir(nome.length >= 2, 'Informe o nome do cliente.');

  const tipo = corpo.tipo ?? corpo.segmento ?? base.tipo ?? 'residencial';
  exigir(TIPOS_CLIENTE.includes(tipo), 'Tipo de cliente inválido.');

  return {
    id: base.id || novoId(),
    revendaId: base.revendaId || req.revendaId,
    nome,
    telefone: texto(corpo.telefone ?? base.telefone),
    endereco: texto(corpo.endereco ?? base.endereco),
    cidade: texto(corpo.cidade ?? base.cidade),
    ultimaCompra: dataValida(corpo.ultimaCompra) ?? base.ultimaCompra ?? null,
    intervaloDias: Math.max(1, inteiro(corpo.intervaloDias ?? base.intervaloDias, 30)),
    observacoes: texto(corpo.observacoes ?? base.observacoes),
    tipo,
    produtoHabitual: texto(corpo.produtoHabitual ?? base.produtoHabitual),
    quantidadeHabitual: Math.max(1, inteiro(corpo.quantidadeHabitual ?? base.quantidadeHabitual, 1)),
  };
}

app.get('/clientes', (req, res) => {
  const busca = texto(req.query.busca).toLowerCase();
  let lista = daRevenda(banco.clientes, req);

  if (busca) {
    lista = lista.filter((c) =>
      [c.nome, c.cidade, c.telefone, c.endereco].join(' ').toLowerCase().includes(busca)
    );
  }
  if (req.query.tipo) lista = lista.filter((c) => c.tipo === req.query.tipo);

  res.json([...lista].sort((a, b) => a.nome.localeCompare(b.nome)).map(saidaCliente));
});

app.get('/clientes/:id', (req, res) => {
  res.json(saidaCliente(acharOu404(banco.clientes, req.params.id, 'Cliente', req)));
});

/** Linha do tempo do cliente: pedidos + contatos + métricas. */
app.get('/clientes/:id/historico', (req, res) => {
  const cliente = acharOu404(banco.clientes, req.params.id, 'Cliente', req);
  const pedidos = daRevenda(banco.entregas, req)
    .filter((e) => e.clienteId === cliente.id)
    .sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
  const contatos = daRevenda(banco.contatos, req)
    .filter((c) => c.clienteId === cliente.id)
    .sort((a, b) => new Date(b.data) - new Date(a.data));

  const validos = pedidos.filter((e) => e.status !== 'cancelada');
  const totalComprado = validos.reduce((s, e) => s + totalDoPedido(e), 0);

  const linhaDoTempo = [
    ...pedidos.map((e) => ({ tipo: 'pedido', data: e.criadaEm, item: saidaEntrega(e) })),
    ...contatos.map((c) => ({ tipo: 'contato', data: c.data, item: c })),
  ].sort((a, b) => new Date(b.data) - new Date(a.data));

  res.json({
    cliente: saidaCliente(cliente),
    metricas: {
      pedidos: validos.length,
      totalComprado: Number(totalComprado.toFixed(2)),
      ticketMedio: validos.length ? Number((totalComprado / validos.length).toFixed(2)) : 0,
      vasilhamesPendentes: pedidos.reduce((s, e) => s + vasilhamesPendentes(e), 0),
      pedidoEmAberto: pedidos.some((e) => STATUS_ABERTOS.includes(e.status)),
    },
    linhaDoTempo,
  });
});

app.post(
  '/clientes',
  rota((req, res) => {
    exigirLimite(req.revendaId, 'clientes', daRevenda(banco.clientes, req).length);
    const cliente = montarCliente(req.body, {}, req);
    banco.clientes.push(cliente);
    auditar(req, 'cliente_criado', 'cliente', cliente.id, { nome: cliente.nome });
    salvar();
    res.status(201).json(saidaCliente(cliente));
  })
);

app.patch(
  '/clientes/:id',
  rota((req, res) => {
    const atual = acharOu404(banco.clientes, req.params.id, 'Cliente', req);
    Object.assign(atual, montarCliente(req.body, atual, req));

    // Mantém o nome do cliente em dia dentro dos pedidos já gravados.
    banco.entregas
      .filter((e) => e.clienteId === atual.id)
      .forEach((e) => {
        e.clienteNome = atual.nome;
      });

    auditar(req, 'cliente_atualizado', 'cliente', atual.id);
    salvar();
    res.json(saidaCliente(atual));
  })
);

app.delete(
  '/clientes/:id',
  exigirPapel(),
  rota((req, res) => {
    const cliente = acharOu404(banco.clientes, req.params.id, 'Cliente', req);
    const temEntregas = banco.entregas.some((e) => e.clienteId === cliente.id);
    exigir(!temEntregas, 'Este cliente tem pedidos registrados e não pode ser removido.');
    banco.clientes = banco.clientes.filter((c) => c.id !== cliente.id);
    auditar(req, 'cliente_removido', 'cliente', cliente.id, { nome: cliente.nome });
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// PRODUTOS (catálogo e preços)
// =============================================================

app.get('/produtos', (req, res) => {
  res.json(daRevenda(banco.produtos, req));
});

/** Define preço/ativo de um tipo (cria o produto se não existir). */
app.put(
  '/produtos/:tipo',
  exigirPapel(),
  rota((req, res) => {
    const tipo = texto(req.params.tipo).toUpperCase() === 'GRANEL' ? 'Granel' : texto(req.params.tipo).toUpperCase();
    exigir(TIPOS_BOTIJAO.includes(tipo), 'Tipo de produto inválido.');

    let produto = banco.produtos.find((p) => p.revendaId === req.revendaId && p.tipo === tipo);
    if (!produto) {
      produto = { id: novoId(), revendaId: req.revendaId, tipo, nome: `Botijão de gás ${tipo}`, preco: 0, ativo: true };
      banco.produtos.push(produto);
    }
    if (req.body.preco !== undefined) {
      const preco = numero(req.body.preco, -1);
      exigir(preco >= 0, 'Preço inválido.');
      produto.preco = preco;
    }
    if (req.body.nome !== undefined) produto.nome = texto(req.body.nome, produto.nome);
    if (req.body.ativo !== undefined) produto.ativo = Boolean(req.body.ativo);

    auditar(req, 'produto_atualizado', 'produto', produto.id, { tipo, preco: produto.preco });
    salvar();
    res.json(produto);
  })
);

// =============================================================
// PEDIDOS / ENTREGAS  (/pedidos é apelido de /entregas)
// =============================================================

const visivelParaEntregador = (e, usuario) =>
  usuario.papel !== 'entregador' || !e.entregadorId || e.entregadorId === usuario.id;

function entregasVisiveis(req) {
  return daRevenda(banco.entregas, req).filter((e) => visivelParaEntregador(e, req.usuario));
}

function acharEntrega(req) {
  const entrega = acharOu404(banco.entregas, req.params.id, 'Pedido', req);
  if (!visivelParaEntregador(entrega, req.usuario)) {
    throw new ErroHttp(404, 'Pedido não encontrado.');
  }
  return entrega;
}

function listarEntregas(req, res) {
  const { status, clienteId, de, ate, pagamento } = req.query;
  let lista = entregasVisiveis(req);

  if (status) lista = lista.filter((e) => e.status === status);
  if (clienteId) lista = lista.filter((e) => e.clienteId === clienteId);
  if (pagamento) lista = lista.filter((e) => e.statusPagamento === pagamento);
  if (de) lista = lista.filter((e) => new Date(e.criadaEm) >= new Date(de));
  if (ate) lista = lista.filter((e) => new Date(e.criadaEm) <= new Date(ate));

  lista.sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
  res.json(lista.map(saidaEntrega));
}

function criarEntrega(req, res) {
  // Reenvio offline: a mesma chave devolve o pedido já criado.
  const chave = texto(req.body.chaveIdempotencia || req.headers['idempotency-key']) || null;
  if (chave) {
    const existente = banco.entregas.find(
      (e) => e.revendaId === req.revendaId && e.chaveIdempotencia === chave
    );
    if (existente) return res.status(200).json(saidaEntrega(existente));
  }

  const hoje = hojeChave();
  const doMes = daRevenda(banco.entregas, req).filter((e) => chaveDia(e.criadaEm).slice(0, 7) === hoje.slice(0, 7));
  exigirLimite(req.revendaId, 'pedidosMes', doMes.length);

  const cliente = acharOu404(banco.clientes, texto(req.body.clienteId), 'Cliente', req);
  const produto = texto(req.body.produto);
  exigir(produto, 'Informe o produto.');

  const quantidade = inteiro(req.body.quantidade, 1);
  exigir(quantidade > 0 && quantidade <= 1000, 'Quantidade inválida.');

  let valor = numero(req.body.valor, 0);
  exigir(valor >= 0, 'Valor inválido.');

  // Preço travado: o servidor impõe o preço do catálogo.
  const revenda = banco.revendas.find((r) => r.id === req.revendaId);
  if (revenda && revenda.precoTravado) {
    const catalogo = banco.produtos.find(
      (p) => p.revendaId === req.revendaId && p.tipo === tipoDoProduto(produto) && p.preco > 0
    );
    if (catalogo) valor = catalogo.preco;
  }

  const status = STATUS.includes(req.body.status) ? req.body.status : 'pendente';
  const forma = FORMAS.includes(req.body.formaPagamento) ? req.body.formaPagamento : 'dinheiro';
  let statusPagamento = STATUS_PAGAMENTO.includes(req.body.statusPagamento) ? req.body.statusPagamento : 'pendente';
  if (status === 'cancelada') statusPagamento = 'cancelado';
  if (forma === 'a_prazo' && statusPagamento === 'pago') statusPagamento = 'pendente';

  // Quem entrega: o próprio entregador, ou quem o admin/atendente indicar.
  let responsavel = null;
  if (req.usuario.papel === 'entregador') {
    responsavel = req.usuario;
  } else if (req.body.entregadorId) {
    responsavel = banco.usuarios.find(
      (u) => u.id === req.body.entregadorId && u.revendaId === req.revendaId && u.papel === 'entregador'
    ) || null;
  }

  const criadaEm = dataValida(req.body.criadaEm);
  const entregueEm = status === 'entregue' ? dataValida(req.body.entregueEm) || agora() : null;

  const entrega = {
    id: novoId(),
    revendaId: req.revendaId,
    clienteId: cliente.id,
    clienteNome: cliente.nome,
    produto,
    quantidade,
    valor,
    status,
    criadaEm: criadaEm && new Date(criadaEm) <= new Date(Date.now() + 86400000) ? criadaEm : agora(),
    entregueEm,
    observacao: texto(req.body.observacao),
    endereco: texto(req.body.endereco) || [cliente.endereco, cliente.cidade].filter(Boolean).join(', '),
    entregadorId: responsavel ? responsavel.id : null,
    entregadorNome: responsavel ? responsavel.nome : '',
    vasilhamesRecolhidos: status === 'entregue' ? Math.min(999, Math.max(0, inteiro(req.body.vasilhamesRecolhidos, req.body.vasilhameDevolvido ? quantidade : 0))) : 0,
    formaPagamento: forma,
    statusPagamento,
    pagoEm: statusPagamento === 'pago' ? agora() : null,
    recebidoPor: texto(req.body.recebidoPor),
    ordemRota: Math.max(0, inteiro(req.body.ordemRota, 0)),
    chaveIdempotencia: chave,
    criadoPor: req.usuario.id,
  };

  banco.entregas.push(entrega);
  aplicarEfeitos(null, entrega, req.usuario);
  auditar(req, 'pedido_criado', 'pedido', entrega.id, { cliente: cliente.nome, total: totalDoPedido(entrega) });
  salvar();
  res.status(201).json(saidaEntrega(entrega));
}

function atualizarEntrega(req, res) {
  const entrega = acharEntrega(req);
  const antes = { ...entrega };
  const corpo = req.body;
  const eAdmin = req.usuario.papel === 'admin';

  if (corpo.status !== undefined) {
    exigir(STATUS.includes(corpo.status), 'Status inválido.');
    entrega.status = corpo.status;
    entrega.entregueEm =
      corpo.status === 'entregue'
        ? dataValida(corpo.entregueEm) || entrega.entregueEm || agora()
        : null;
  }

  // Produto, quantidade e valor só o administrador altera.
  if (corpo.produto !== undefined || corpo.quantidade !== undefined || corpo.valor !== undefined) {
    exigir(eAdmin, 'Somente o administrador altera produto, quantidade ou valor.', 403);
    if (corpo.produto !== undefined) entrega.produto = texto(corpo.produto, entrega.produto);
    if (corpo.quantidade !== undefined) {
      const q = inteiro(corpo.quantidade, entrega.quantidade);
      exigir(q > 0 && q <= 1000, 'Quantidade inválida.');
      entrega.quantidade = q;
    }
    if (corpo.valor !== undefined) {
      const v = numero(corpo.valor, -1);
      exigir(v >= 0, 'Valor inválido.');
      entrega.valor = v;
    }
  }

  if (corpo.entregadorId !== undefined) {
    exigir(eAdmin, 'Somente o administrador troca o entregador.', 403);
    const novo = corpo.entregadorId
      ? banco.usuarios.find((u) => u.id === corpo.entregadorId && u.revendaId === req.revendaId && u.papel === 'entregador')
      : null;
    exigir(!corpo.entregadorId || novo, 'Entregador não encontrado.', 404);
    entrega.entregadorId = novo ? novo.id : null;
    entrega.entregadorNome = novo ? novo.nome : '';
  }

  if (corpo.observacao !== undefined) entrega.observacao = texto(corpo.observacao);
  if (corpo.endereco !== undefined) entrega.endereco = texto(corpo.endereco);
  if (corpo.recebidoPor !== undefined) entrega.recebidoPor = texto(corpo.recebidoPor);
  if (corpo.ordemRota !== undefined) entrega.ordemRota = Math.max(0, inteiro(corpo.ordemRota, 0));

  if (corpo.vasilhamesRecolhidos !== undefined) {
    entrega.vasilhamesRecolhidos = Math.min(999, Math.max(0, inteiro(corpo.vasilhamesRecolhidos, 0)));
  } else if (corpo.vasilhameDevolvido !== undefined) {
    entrega.vasilhamesRecolhidos = corpo.vasilhameDevolvido ? entrega.quantidade : 0;
  }

  if (corpo.formaPagamento !== undefined) {
    exigir(FORMAS.includes(corpo.formaPagamento), 'Forma de pagamento inválida.');
    entrega.formaPagamento = corpo.formaPagamento;
  }
  if (corpo.statusPagamento !== undefined) {
    exigir(STATUS_PAGAMENTO.includes(corpo.statusPagamento), 'Situação do pagamento inválida.');
    entrega.statusPagamento = corpo.statusPagamento;
  } else if (entrega.status === 'cancelada') {
    entrega.statusPagamento = 'cancelado';
  } else if (antes.status === 'cancelada' && entrega.statusPagamento === 'cancelado') {
    entrega.statusPagamento = 'pendente';
  }
  if (entrega.statusPagamento === 'pago') {
    entrega.pagoEm = entrega.pagoEm || agora();
  } else {
    entrega.pagoEm = null;
  }

  aplicarEfeitos(antes, entrega, req.usuario);

  const mudouPagamento =
    antes.statusPagamento !== entrega.statusPagamento ||
    antes.formaPagamento !== entrega.formaPagamento;
  if (antes.status !== entrega.status) {
    auditar(req, 'pedido_status', 'pedido', entrega.id, { de: antes.status, para: entrega.status });
  }
  if (mudouPagamento) {
    auditar(req, 'pedido_pagamento', 'pedido', entrega.id, {
      forma: entrega.formaPagamento,
      status: entrega.statusPagamento,
    });
  }
  salvar();
  res.json(saidaEntrega(entrega));
}

for (const base of ['/entregas', '/pedidos']) {
  app.get(base, listarEntregas);
  app.get(`${base}/:id`, (req, res) => res.json(saidaEntrega(acharEntrega(req))));
  app.post(base, rota(criarEntrega));
  app.patch(`${base}/:id`, exigirPapel('entregador'), rota(atualizarEntrega));
  app.patch(`${base}/:id/status`, exigirPapel('entregador'), rota((req, res) => {
    exigir(req.body.status !== undefined, 'Informe o status.');
    req.body = { status: req.body.status, entregueEm: req.body.entregueEm };
    return atualizarEntrega(req, res);
  }));
}

/** Prova de entrega: registra quem recebeu e devolve o comprovante. */
app.post(
  '/entregas/:id/comprovante',
  exigirPapel('entregador'),
  rota((req, res) => {
    const entrega = acharEntrega(req);
    exigir(entrega.status === 'entregue', 'O comprovante só existe para pedidos entregues.');

    if (req.body.recebidoPor !== undefined) entrega.recebidoPor = texto(req.body.recebidoPor);
    entrega.comprovanteEm = entrega.comprovanteEm || agora();
    auditar(req, 'comprovante_gerado', 'pedido', entrega.id);
    salvar();

    res.json({
      pedido: entrega.id,
      cliente: entrega.clienteNome,
      endereco: entrega.endereco,
      produto: entrega.produto,
      quantidade: entrega.quantidade,
      total: Number(totalDoPedido(entrega).toFixed(2)),
      formaPagamento: entrega.formaPagamento,
      statusPagamento: entrega.statusPagamento,
      vasilhamesRecolhidos: entrega.vasilhamesRecolhidos,
      recebidoPor: entrega.recebidoPor,
      entregador: entrega.entregadorNome,
      entregueEm: entrega.entregueEm,
      emitidoEm: entrega.comprovanteEm,
    });
  })
);

for (const base of ['/entregas', '/pedidos']) {
  app.delete(
    `${base}/:id`,
    exigirPapel(),
    rota((req, res) => {
      const entrega = acharEntrega(req);
      // Estorna estoque antes de apagar, para não deixar saldo inconsistente.
      aplicarEfeitos(entrega, { ...entrega, status: 'cancelada' }, req.usuario);
      banco.entregas = banco.entregas.filter((e) => e.id !== entrega.id);
      auditar(req, 'pedido_removido', 'pedido', entrega.id, { cliente: entrega.clienteNome });
      salvar();
      res.status(204).end();
    })
  );
}

// =============================================================
// ESTOQUE E VASILHAMES
// =============================================================

app.get('/estoque', exigirPapel('telemarketing'), (req, res) => {
  res.json(daRevenda(banco.estoque, req));
});

app.get('/estoque/movimentos', exigirPapel(), (req, res) => {
  const limite = Math.min(500, Math.max(1, inteiro(req.query.limite, 100)));
  let lista = daRevenda(banco.movimentosEstoque, req);
  if (req.query.tipo) lista = lista.filter((m) => m.tipo === req.query.tipo);
  res.json(lista.slice(-limite).reverse());
});

/** Movimento (deltas) — também inicia o controle de um tipo. */
app.post(
  '/estoque/movimentos',
  exigirPapel(),
  rota((req, res) => {
    const tipo = texto(req.body.tipo || req.body.produtoId).toUpperCase();
    exigir(TIPOS_ESTOQUE.includes(tipo), 'Tipo de estoque inválido.');

    let item = itemEstoque(req.revendaId, tipo);
    if (!item) {
      item = { revendaId: req.revendaId, tipo, cheios: 0, vazios: 0, minimo: 0 };
      banco.estoque.push(item);
    }

    const deltaCheios = inteiro(req.body.cheios, 0);
    const deltaVazios = inteiro(req.body.vazios, 0);
    const novoCheios = item.cheios + deltaCheios;
    const novoVazios = item.vazios + deltaVazios;
    exigir(novoCheios >= 0 && novoVazios >= 0, 'O movimento deixaria o estoque negativo.');

    if (req.body.minimo !== undefined) {
      item.minimo = Math.max(0, inteiro(req.body.minimo, item.minimo));
    }
    item.cheios = novoCheios;
    item.vazios = novoVazios;

    const motivo = texto(req.body.motivo, 'ajuste');
    registrarMovimento(req.revendaId, item, deltaCheios, deltaVazios, motivo, req.usuario);
    auditar(req, 'estoque_movimento', 'estoque', tipo, { deltaCheios, deltaVazios, motivo });
    salvar();
    res.status(201).json(item);
  })
);

/** Define o saldo exato (inventário). */
app.patch(
  '/estoque/:tipo',
  exigirPapel(),
  rota((req, res) => {
    const tipo = texto(req.params.tipo).toUpperCase();
    exigir(TIPOS_ESTOQUE.includes(tipo), 'Tipo de estoque inválido.');

    let item = itemEstoque(req.revendaId, tipo);
    if (!item) {
      item = { revendaId: req.revendaId, tipo, cheios: 0, vazios: 0, minimo: 0 };
      banco.estoque.push(item);
    }
    const cheios = req.body.cheios !== undefined ? inteiro(req.body.cheios, item.cheios) : item.cheios;
    const vazios = req.body.vazios !== undefined ? inteiro(req.body.vazios, item.vazios) : item.vazios;
    exigir(cheios >= 0 && vazios >= 0, 'Os saldos não podem ser negativos.');

    registrarMovimento(req.revendaId, item, cheios - item.cheios, vazios - item.vazios, 'inventario', req.usuario);
    item.cheios = cheios;
    item.vazios = vazios;
    if (req.body.minimo !== undefined) item.minimo = Math.max(0, inteiro(req.body.minimo, item.minimo));

    auditar(req, 'estoque_inventario', 'estoque', tipo, { cheios, vazios, minimo: item.minimo });
    salvar();
    res.json(item);
  })
);

/** Vasilhames que ficaram com clientes (entregues sem troca completa). */
app.get('/vasilhames', exigirPapel('telemarketing'), (req, res) => {
  const porCliente = new Map();
  for (const e of daRevenda(banco.entregas, req)) {
    const pendentes = vasilhamesPendentes(e);
    if (pendentes <= 0) continue;
    const atual = porCliente.get(e.clienteId) || {
      clienteId: e.clienteId,
      clienteNome: e.clienteNome,
      pendentes: 0,
      pedidos: [],
    };
    atual.pendentes += pendentes;
    atual.pedidos.push({ id: e.id, data: e.entregueEm || e.criadaEm, tipo: tipoDoProduto(e.produto), pendentes });
    porCliente.set(e.clienteId, atual);
  }
  const lista = [...porCliente.values()].sort((a, b) => b.pendentes - a.pendentes);
  res.json({
    total: lista.reduce((s, c) => s + c.pendentes, 0),
    clientes: lista,
  });
});

// =============================================================
// CONTATOS (TELEMARKETING) E RADAR DE RECOMPRA
// =============================================================

app.get('/contatos', exigirPapel('telemarketing'), (req, res) => {
  const { clienteId } = req.query;
  let lista = daRevenda(banco.contatos, req);
  if (clienteId) lista = lista.filter((c) => c.clienteId === clienteId);
  lista = [...lista].sort((a, b) => new Date(b.data) - new Date(a.data));
  res.json(lista);
});

app.post(
  '/contatos',
  exigirPapel('telemarketing'),
  rota((req, res) => {
    const cliente = acharOu404(banco.clientes, texto(req.body.clienteId), 'Cliente', req);
    const resultado = RESULTADOS.includes(req.body.resultado) ? req.body.resultado : 'nao_atendeu';
    const proximaAcao = dataValida(req.body.proximaAcao);
    exigir(
      !proximaAcao || new Date(proximaAcao) > new Date(Date.now() - 86400000),
      'A próxima tentativa não pode estar no passado.'
    );

    const contato = {
      id: novoId(),
      revendaId: req.revendaId,
      clienteId: cliente.id,
      clienteNome: cliente.nome,
      resultado,
      anotacao: texto(req.body.anotacao),
      data: dataValida(req.body.data) || agora(),
      proximaAcao,
      canal: CANAIS.includes(req.body.canal) ? req.body.canal : 'ligacao',
      operadorId: req.usuario.id,
      operadorNome: req.usuario.nome,
    };

    // A última compra só muda quando o pedido é entregue.
    banco.contatos.push(contato);
    auditar(req, 'contato_registrado', 'contato', contato.id, { cliente: cliente.nome, resultado });
    salvar();
    res.status(201).json(contato);
  })
);

/**
 * Radar de Reposição: clientes por prioridade, sem pedido em aberto.
 * ?faixa=hoje|proximos3|proximos7|recuperacao|agendados
 */
app.get('/recompra/radar', exigirPapel('telemarketing'), (req, res) => {
  const entregasValidas = daRevenda(banco.entregas, req).filter((e) => e.status !== 'cancelada');
  const ordem = ['hoje', 'proximos3', 'proximos7', 'recuperacao'];

  const itens = daRevenda(banco.clientes, req)
    .map((cliente) => ({ cliente, prioridade: prioridadeRecompra(cliente) }))
    .filter(({ prioridade }) => ordem.includes(prioridade))
    .filter(({ cliente }) => !temPedidoAberto(cliente.id, req))
    .map(({ cliente, prioridade }) => {
      const pedidos = entregasValidas
        .filter((e) => e.clienteId === cliente.id)
        .sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
      const ultimoContato = banco.contatos
        .filter((c) => c.revendaId === req.revendaId && c.clienteId === cliente.id)
        .sort((a, b) => new Date(b.data) - new Date(a.data))[0] || null;
      const ticket = pedidos.length
        ? pedidos.reduce((s, e) => s + totalDoPedido(e), 0) / pedidos.length
        : 0;
      return {
        ...saidaCliente(cliente),
        prioridade,
        ultimoPedido: pedidos[0]
          ? { produto: pedidos[0].produto, quantidade: pedidos[0].quantidade, data: pedidos[0].criadaEm }
          : null,
        ticketMedio: Number(ticket.toFixed(2)),
        ultimoContato,
        retornoAgendado: retornoAgendado(cliente.id, req),
      };
    })
    .sort((a, b) => {
      const porFaixa = ordem.indexOf(a.prioridade) - ordem.indexOf(b.prioridade);
      return porFaixa !== 0 ? porFaixa : (a.diasParaRecompra ?? 0) - (b.diasParaRecompra ?? 0);
    });

  const agendados = itens.filter((i) => i.retornoAgendado);
  const ativos = itens.filter((i) => !i.retornoAgendado);
  const contagens = { total: ativos.length, agendados: agendados.length };
  ordem.forEach((f) => {
    contagens[f] = ativos.filter((i) => i.prioridade === f).length;
  });

  const faixa = texto(req.query.faixa);
  const resposta = faixa === 'agendados' ? agendados : ordem.includes(faixa) ? ativos.filter((i) => i.prioridade === faixa) : ativos;
  res.json({ contagens, itens: resposta });
});

/** Compatibilidade com a versão anterior do app. */
app.get('/clientes-para-contato', exigirPapel('telemarketing'), (req, res) => {
  const limite = inteiro(req.query.dias, 3);
  const lista = daRevenda(banco.clientes, req)
    .map(saidaCliente)
    .filter((c) => c.diasParaRecompra !== null && c.diasParaRecompra <= limite)
    .sort((a, b) => a.diasParaRecompra - b.diasParaRecompra);
  res.json(lista);
});

// =============================================================
// FINANCEIRO E DASHBOARD (dono / admin)
// =============================================================

function resumoFinanceiro(lista) {
  const validas = lista.filter((e) => e.status !== 'cancelada');
  const canceladas = lista.filter((e) => e.status === 'cancelada');
  const soma = (itens, fn) => itens.reduce((s, e) => s + fn(e), 0);
  const recebido = soma(validas.filter((e) => e.statusPagamento === 'pago'), totalDoPedido);
  const vendas = soma(validas, totalDoPedido);

  const porForma = {};
  FORMAS.forEach((f) => {
    porForma[f] = Number(
      soma(validas.filter((e) => e.statusPagamento === 'pago' && e.formaPagamento === f), totalDoPedido).toFixed(2)
    );
  });

  return {
    pedidos: validas.length,
    vendas: Number(vendas.toFixed(2)),
    recebido: Number(recebido.toFixed(2)),
    pendente: Number(soma(validas, valorPendente).toFixed(2)),
    cancelado: Number(soma(canceladas, totalDoPedido).toFixed(2)),
    ticketMedio: validas.length ? Number((vendas / validas.length).toFixed(2)) : 0,
    recebidoPorForma: porForma,
  };
}

app.get('/financeiro/resumo', exigirPapel(), (req, res) => {
  const dias = lerPeriodo(req.query.dias, 7);
  res.json({ periodoDias: dias, ...resumoFinanceiro(noPeriodo(daRevenda(banco.entregas, req), dias)) });
});

app.get('/pagamentos', exigirPapel(), (req, res) => {
  const { status, formaPagamento, de, ate } = req.query;
  let lista = daRevenda(banco.entregas, req).filter((e) => e.status !== 'cancelada');

  if (status) lista = lista.filter((e) => e.statusPagamento === status);
  if (formaPagamento) lista = lista.filter((e) => e.formaPagamento === formaPagamento);
  if (de) lista = lista.filter((e) => new Date(e.criadaEm) >= new Date(de));
  if (ate) lista = lista.filter((e) => new Date(e.criadaEm) <= new Date(ate));

  lista = [...lista].sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
  res.json(
    lista.map((e) => ({
      pedidoId: e.id,
      clienteId: e.clienteId,
      clienteNome: e.clienteNome,
      valor: Number(totalDoPedido(e).toFixed(2)),
      formaPagamento: e.formaPagamento,
      status: e.statusPagamento,
      statusPedido: e.status,
      criadoEm: e.criadaEm,
      pagoEm: e.pagoEm,
    }))
  );
});

app.get('/dashboard/resumo', exigirPapel(), (req, res) => {
  const todas = daRevenda(banco.entregas, req);
  const hoje = hojeChave();
  const deHoje = todas.filter((e) => chaveDia(e.criadaEm) === hoje && e.status !== 'cancelada');
  const concluidasHoje = todas.filter(
    (e) => e.status === 'entregue' && chaveDia(e.entregueEm || e.criadaEm) === hoje
  );

  const clientesParaRecompra = daRevenda(banco.clientes, req).filter((c) => {
    const dias = diasParaRecompra(c);
    return dias !== null && dias <= 3 && !temPedidoAberto(c.id, req);
  }).length;

  const porStatus = {};
  STATUS.forEach((s) => {
    porStatus[s] = todas.filter((e) => e.status === s).length;
  });

  res.json({
    vendasHoje: Number(deHoje.reduce((s, e) => s + totalDoPedido(e), 0).toFixed(2)),
    pedidosHoje: deHoje.length,
    entregasConcluidasHoje: concluidasHoje.length,
    clientesParaRecompra,
    pagamentosPendentes: Number(todas.reduce((s, e) => s + valorPendente(e), 0).toFixed(2)),
    vasilhamesPendentes: todas.reduce((s, e) => s + vasilhamesPendentes(e), 0),
    pedidosPorStatus: porStatus,
    estoqueEmAlerta: daRevenda(banco.estoque, req).filter((i) => i.minimo > 0 && i.cheios <= i.minimo),
    pedidosAtrasados: todas.filter((e) => STATUS_ABERTOS.includes(e.status) && chaveDia(e.criadaEm) < hoje).length,
  });
});

/** Série diária (pedidos, entregas concluídas e vendas) dos últimos dias. */
app.get('/dashboard/series', exigirPapel(), (req, res) => {
  const dias = Math.min(90, Math.max(1, inteiro(req.query.dias, 7)));
  const todas = daRevenda(banco.entregas, req);
  const serie = [];

  for (let i = dias - 1; i >= 0; i -= 1) {
    const dia = new Date(Date.parse(`${hojeChave()}T00:00:00Z`));
    dia.setUTCDate(dia.getUTCDate() - i);
    const chave = dia.toISOString().slice(0, 10);
    const doDia = todas.filter((e) => chaveDia(e.criadaEm) === chave && e.status !== 'cancelada');
    serie.push({
      dia: chave,
      pedidos: doDia.length,
      entregues: doDia.filter((e) => e.status === 'entregue').length,
      vendas: Number(doDia.reduce((s, e) => s + totalDoPedido(e), 0).toFixed(2)),
    });
  }
  res.json(serie);
});

/** Resumo da versão anterior. */
app.get('/relatorios/resumo', exigirPapel(), (req, res) => {
  const todas = daRevenda(banco.entregas, req);
  const porStatus = {};
  STATUS.forEach((s) => {
    porStatus[s] = todas.filter((e) => e.status === s).length;
  });
  const faturamento = todas
    .filter((e) => e.status === 'entregue')
    .reduce((s, e) => s + totalDoPedido(e), 0);

  res.json({
    totalEntregas: todas.length,
    porStatus,
    faturamentoEntregue: Number(faturamento.toFixed(2)),
    totalClientes: daRevenda(banco.clientes, req).length,
    totalUsuarios: daRevenda(banco.usuarios, req).length,
    contatosRegistrados: daRevenda(banco.contatos, req).length,
  });
});

// =============================================================
// USUÁRIOS (ADMIN DA REVENDA)
// =============================================================

const adminsAtivos = (req, ignorarId) =>
  banco.usuarios.filter(
    (u) => u.revendaId === req.revendaId && u.papel === 'admin' && u.ativo && u.id !== ignorarId
  ).length;

app.get('/usuarios', exigirPapel(), (req, res) => {
  res.json(daRevenda(banco.usuarios, req).map(semSenha));
});

app.post(
  '/usuarios',
  exigirPapel(),
  rota(async (req, res) => {
    exigirLimite(req.revendaId, 'usuarios', daRevenda(banco.usuarios, req).length);

    const nome = texto(req.body.nome);
    const email = texto(req.body.email).toLowerCase();
    const senha = texto(req.body.senha || req.body.password);
    const papel = PAPEIS.includes(req.body.papel) ? req.body.papel : 'entregador';

    exigir(nome.length >= 2, 'Informe o nome.');
    exigir(EMAIL_VALIDO.test(email), 'E-mail inválido.');
    exigir(senha.length >= 6, 'A senha precisa ter ao menos 6 caracteres.');
    exigir(!banco.usuarios.some((u) => u.email === email), 'Já existe um usuário com este e-mail.');

    const usuario = {
      id: novoId(),
      revendaId: req.revendaId, // sempre a revenda do solicitante
      nome,
      email,
      papel,
      ativo: req.body.ativo !== false,
      adminGlobal: false,
      senhaHash: await bcrypt.hash(senha, 10),
      criadoEm: agora(),
    };

    banco.usuarios.push(usuario);
    auditar(req, 'usuario_criado', 'usuario', usuario.id, { email, papel });
    salvar();
    res.status(201).json(semSenha(usuario));
  })
);

app.patch(
  '/usuarios/:id',
  exigirPapel(),
  rota(async (req, res) => {
    const usuario = acharOu404(banco.usuarios, req.params.id, 'Usuário', req);
    const eraAdminAtivo = usuario.papel === 'admin' && usuario.ativo;

    if (req.body.nome !== undefined) usuario.nome = texto(req.body.nome, usuario.nome);
    if (req.body.email !== undefined) {
      const email = texto(req.body.email).toLowerCase();
      exigir(EMAIL_VALIDO.test(email), 'E-mail inválido.');
      exigir(
        !banco.usuarios.some((u) => u.email === email && u.id !== usuario.id),
        'Já existe um usuário com este e-mail.'
      );
      usuario.email = email;
    }
    if (req.body.papel !== undefined && PAPEIS.includes(req.body.papel)) {
      usuario.papel = req.body.papel;
    }
    if (req.body.ativo !== undefined) {
      exigir(
        !(usuario.id === req.usuario.id && req.body.ativo === false),
        'Você não pode desativar a própria conta.'
      );
      usuario.ativo = Boolean(req.body.ativo);
    }
    // Nunca deixa a revenda sem administrador ativo.
    if (eraAdminAtivo && !(usuario.papel === 'admin' && usuario.ativo)) {
      exigir(adminsAtivos(req, usuario.id) > 0, 'A revenda precisa de ao menos um administrador ativo.');
    }
    if (req.body.senha) {
      exigir(texto(req.body.senha).length >= 6, 'A senha precisa ter ao menos 6 caracteres.');
      usuario.senhaHash = await bcrypt.hash(texto(req.body.senha), 10);
    }
    // Desativação, troca de papel ou senha derrubam as sessões.
    if (!usuario.ativo || req.body.senha || req.body.papel !== undefined) {
      banco.sessoes = banco.sessoes.filter((s) => s.usuarioId !== usuario.id);
    }

    auditar(req, 'usuario_atualizado', 'usuario', usuario.id, {
      campos: Object.keys(req.body).filter((c) => c !== 'senha'),
    });
    salvar();
    res.json(semSenha(usuario));
  })
);

app.delete(
  '/usuarios/:id',
  exigirPapel(),
  rota((req, res) => {
    const usuario = acharOu404(banco.usuarios, req.params.id, 'Usuário', req);
    exigir(usuario.id !== req.usuario.id, 'Você não pode remover a própria conta.');
    if (usuario.papel === 'admin' && usuario.ativo) {
      exigir(adminsAtivos(req, usuario.id) > 0, 'A revenda precisa de ao menos um administrador ativo.');
    }
    banco.usuarios = banco.usuarios.filter((u) => u.id !== usuario.id);
    banco.sessoes = banco.sessoes.filter((s) => s.usuarioId !== usuario.id);
    auditar(req, 'usuario_removido', 'usuario', usuario.id, { email: usuario.email });
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// AUDITORIA
// =============================================================

app.get('/auditoria', exigirPapel(), (req, res) => {
  const limite = Math.min(500, Math.max(1, inteiro(req.query.limite, 100)));
  let lista = daRevenda(banco.auditoria, req);
  if (req.query.entidade) lista = lista.filter((a) => a.entidade === req.query.entidade);
  if (req.query.usuarioId) lista = lista.filter((a) => a.usuarioId === req.query.usuarioId);
  res.json(lista.slice(-limite).reverse());
});

// =============================================================
// ERROS
// =============================================================

app.use((req, res) => {
  res.status(404).json({ statusCode: 404, message: 'Rota não encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((erro, req, res, next) => {
  // JSON inválido enviado pelo cliente
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ statusCode: 400, message: 'JSON inválido.' });
  }
  if (erro.type === 'entity.too.large') {
    return res.status(413).json({ statusCode: 413, message: 'Requisição grande demais.' });
  }
  const status = erro.status || 500;
  if (status >= 500) console.error(erro);
  res.status(status).json({
    statusCode: status,
    message: status >= 500 && PRODUCAO ? 'Erro interno no servidor.' : erro.message || 'Erro interno no servidor.',
  });
});

// =============================================================
// INÍCIO
// =============================================================

carregar();

const servidor = app.listen(PORTA, () => {
  console.log(`API do Gas OS ouvindo na porta ${PORTA}`);
});

// Encerramento limpo (Render envia SIGTERM ao reiniciar).
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    console.log(`Recebido ${sinal}, gravando dados e encerrando...`);
    salvar();
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
