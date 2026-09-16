/**
 * API do App Entregas
 * -------------------------------------------------------------
 * Node + Express, sem banco externo: os dados ficam em um arquivo
 * JSON (data.json). Para trocar por Postgres/Mongo depois, basta
 * substituir as funções do bloco "BANCO DE DADOS" — o resto das
 * rotas não muda.
 *
 * Subir local:   npm install && npm run dev
 * Subir no Render: veja o README.md
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORTA = process.env.PORT || 3000;
const SEGREDO = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';
const EXPIRACAO = process.env.JWT_EXPIRES_IN || '7d';
const ARQUIVO_DADOS =
  process.env.DATA_FILE || path.join(__dirname, 'data.json');

if (!process.env.JWT_SECRET) {
  console.warn(
    '[aviso] JWT_SECRET não definido. Defina a variável no Render antes de usar em produção.'
  );
}

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

// =============================================================
// BANCO DE DADOS (arquivo JSON)
// =============================================================

let banco = {
  usuarios: [],
  clientes: [],
  entregas: [],
  contatos: [],
};

function novoId() {
  return crypto.randomUUID();
}

function carregar() {
  try {
    if (fs.existsSync(ARQUIVO_DADOS)) {
      const bruto = fs.readFileSync(ARQUIVO_DADOS, 'utf8');
      const lido = JSON.parse(bruto);
      banco = {
        usuarios: lido.usuarios || [],
        clientes: lido.clientes || [],
        entregas: lido.entregas || [],
        contatos: lido.contatos || [],
      };
      console.log(`Dados carregados de ${ARQUIVO_DADOS}`);
      return;
    }
  } catch (erro) {
    console.error('Falha ao ler o arquivo de dados:', erro.message);
  }
  semear();
}

function salvar() {
  try {
    fs.writeFileSync(ARQUIVO_DADOS, JSON.stringify(banco, null, 2));
  } catch (erro) {
    // No Render, o disco é efêmero e pode estar em modo leitura.
    console.error('Não foi possível gravar os dados:', erro.message);
  }
}

function diasAtras(dias) {
  const data = new Date();
  data.setDate(data.getDate() - dias);
  return data.toISOString();
}

/** Cria a base inicial com um admin e alguns registros de exemplo. */
function semear() {
  const senhaPadrao = process.env.SENHA_PADRAO || '123456';
  const hash = bcrypt.hashSync(senhaPadrao, 10);

  banco.usuarios = [
    {
      id: novoId(),
      nome: process.env.ADMIN_NOME || 'Administrador',
      email: (process.env.ADMIN_EMAIL || 'admin@app.com').toLowerCase(),
      papel: 'admin',
      ativo: true,
      senhaHash: hash,
    },
    {
      id: novoId(),
      nome: 'João Ribeiro',
      email: 'entregador@app.com',
      papel: 'entregador',
      ativo: true,
      senhaHash: hash,
    },
    {
      id: novoId(),
      nome: 'Maria Duarte',
      email: 'telemarketing@app.com',
      papel: 'telemarketing',
      ativo: true,
      senhaHash: hash,
    },
  ];

  banco.clientes = [
    {
      id: novoId(),
      nome: 'Padaria Estrela',
      telefone: '11987654321',
      endereco: 'Rua das Acácias, 120',
      cidade: 'São Paulo',
      ultimaCompra: diasAtras(28),
      intervaloDias: 30,
      observacoes: 'Entregar sempre antes das 9h.',
    },
    {
      id: novoId(),
      nome: 'Mercearia do Zé',
      telefone: '11991234567',
      endereco: 'Av. Brasil, 890',
      cidade: 'Guarulhos',
      ultimaCompra: diasAtras(35),
      intervaloDias: 30,
      observacoes: '',
    },
    {
      id: novoId(),
      nome: 'Café Central',
      telefone: '11944445555',
      endereco: 'Praça da Sé, 10',
      cidade: 'São Paulo',
      ultimaCompra: diasAtras(5),
      intervaloDias: 21,
      observacoes: '',
    },
  ];

  banco.entregas = [
    {
      id: novoId(),
      clienteId: banco.clientes[0].id,
      clienteNome: banco.clientes[0].nome,
      produto: 'Farinha de trigo 25kg',
      quantidade: 4,
      valor: 92.5,
      status: 'entregue',
      criadaEm: diasAtras(2),
      entregueEm: diasAtras(2),
      observacao: '',
      entregadorNome: 'João Ribeiro',
    },
    {
      id: novoId(),
      clienteId: banco.clientes[2].id,
      clienteNome: banco.clientes[2].nome,
      produto: 'Café torrado 1kg',
      quantidade: 12,
      valor: 34.9,
      status: 'pendente',
      criadaEm: new Date().toISOString(),
      entregueEm: null,
      observacao: '',
      entregadorNome: 'João Ribeiro',
    },
  ];

  banco.contatos = [];
  salvar();
  console.log(
    `Base criada. Entre com admin@app.com e a senha "${senhaPadrao}".`
  );
}

// =============================================================
// AUXILIARES
// =============================================================

const PAPEIS = ['entregador', 'telemarketing', 'admin'];
const STATUS = ['pendente', 'em_rota', 'entregue', 'cancelada'];

class ErroHttp extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Envolve rotas async para que erros caiam no handler central. */
const rota = (funcao) => (req, res, next) =>
  Promise.resolve(funcao(req, res, next)).catch(next);

function semSenha(usuario) {
  if (!usuario) return null;
  const { senhaHash, ...resto } = usuario;
  return resto;
}

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

function exigir(condicao, mensagem) {
  if (!condicao) throw new ErroHttp(400, mensagem);
}

function acharOu404(lista, id, nome) {
  const item = lista.find((i) => i.id === id);
  if (!item) throw new ErroHttp(404, `${nome} não encontrado.`);
  return item;
}

// =============================================================
// AUTENTICAÇÃO
// =============================================================

function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const [tipo, token] = cabecalho.split(' ');

  if (tipo !== 'Bearer' || !token) {
    return next(new ErroHttp(401, 'Envie o token de acesso.'));
  }

  try {
    const conteudo = jwt.verify(token, SEGREDO);
    const usuario = banco.usuarios.find((u) => u.id === conteudo.sub);
    if (!usuario || !usuario.ativo) {
      return next(new ErroHttp(401, 'Sessão inválida. Entre novamente.'));
    }
    req.usuario = usuario;
    next();
  } catch (erro) {
    next(new ErroHttp(401, 'Sessão expirada. Entre novamente.'));
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

// =============================================================
// ROTAS PÚBLICAS
// =============================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    versao: '1.0.0',
    horario: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    nome: 'API App Entregas',
    documentacao: '/health, /auth/login, /clientes, /entregas, /contatos, /usuarios',
  });
});

app.post(
  '/auth/login',
  rota(async (req, res) => {
    const email = texto(req.body.email).toLowerCase();
    const senha = texto(req.body.senha || req.body.password);

    exigir(email && senha, 'Informe e-mail e senha.');

    const usuario = banco.usuarios.find((u) => u.email === email);
    const confere =
      usuario && (await bcrypt.compare(senha, usuario.senhaHash || ''));

    if (!confere) throw new ErroHttp(401, 'E-mail ou senha inválidos.');
    if (!usuario.ativo) throw new ErroHttp(403, 'Usuário desativado.');

    const access_token = jwt.sign(
      { sub: usuario.id, papel: usuario.papel, email: usuario.email },
      SEGREDO,
      { expiresIn: EXPIRACAO }
    );

    res.json({ access_token, usuario: semSenha(usuario) });
  })
);

// A partir daqui, tudo exige token.
app.use(autenticar);

app.get('/auth/me', (req, res) => res.json(semSenha(req.usuario)));

app.patch(
  '/auth/senha',
  rota(async (req, res) => {
    const atual = texto(req.body.senhaAtual);
    const nova = texto(req.body.novaSenha);
    exigir(nova.length >= 6, 'A nova senha precisa ter ao menos 6 caracteres.');

    const confere = await bcrypt.compare(atual, req.usuario.senhaHash || '');
    if (!confere) throw new ErroHttp(400, 'Senha atual incorreta.');

    req.usuario.senhaHash = await bcrypt.hash(nova, 10);
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// CLIENTES
// =============================================================

function montarCliente(corpo, base = {}) {
  const nome = texto(corpo.nome ?? base.nome);
  exigir(nome.length >= 2, 'Informe o nome do cliente.');

  return {
    id: base.id || novoId(),
    nome,
    telefone: texto(corpo.telefone ?? base.telefone),
    endereco: texto(corpo.endereco ?? base.endereco),
    cidade: texto(corpo.cidade ?? base.cidade),
    ultimaCompra: corpo.ultimaCompra ?? base.ultimaCompra ?? null,
    intervaloDias: Math.max(
      1,
      Math.round(numero(corpo.intervaloDias ?? base.intervaloDias, 30))
    ),
    observacoes: texto(corpo.observacoes ?? base.observacoes),
  };
}

app.get('/clientes', (req, res) => {
  const busca = texto(req.query.busca).toLowerCase();
  let lista = banco.clientes;

  if (busca) {
    lista = lista.filter((c) =>
      [c.nome, c.cidade, c.telefone, c.endereco]
        .join(' ')
        .toLowerCase()
        .includes(busca)
    );
  }

  res.json([...lista].sort((a, b) => a.nome.localeCompare(b.nome)));
});

app.get('/clientes/:id', (req, res) => {
  res.json(acharOu404(banco.clientes, req.params.id, 'Cliente'));
});

app.post(
  '/clientes',
  rota((req, res) => {
    const cliente = montarCliente(req.body);
    banco.clientes.push(cliente);
    salvar();
    res.status(201).json(cliente);
  })
);

app.patch(
  '/clientes/:id',
  rota((req, res) => {
    const atual = acharOu404(banco.clientes, req.params.id, 'Cliente');
    const atualizado = montarCliente(req.body, atual);
    Object.assign(atual, atualizado);

    // Mantém o nome do cliente em dia dentro das entregas já gravadas.
    banco.entregas
      .filter((e) => e.clienteId === atual.id)
      .forEach((e) => {
        e.clienteNome = atual.nome;
      });

    salvar();
    res.json(atual);
  })
);

app.delete(
  '/clientes/:id',
  exigirPapel('admin'),
  rota((req, res) => {
    const cliente = acharOu404(banco.clientes, req.params.id, 'Cliente');
    const temEntregas = banco.entregas.some((e) => e.clienteId === cliente.id);
    if (temEntregas) {
      throw new ErroHttp(
        400,
        'Este cliente tem entregas registradas e não pode ser removido.'
      );
    }
    banco.clientes = banco.clientes.filter((c) => c.id !== cliente.id);
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// ENTREGAS
// =============================================================

app.get('/entregas', (req, res) => {
  const { status, clienteId, de, ate } = req.query;
  let lista = [...banco.entregas];

  if (status) lista = lista.filter((e) => e.status === status);
  if (clienteId) lista = lista.filter((e) => e.clienteId === clienteId);
  if (de) lista = lista.filter((e) => new Date(e.criadaEm) >= new Date(de));
  if (ate) lista = lista.filter((e) => new Date(e.criadaEm) <= new Date(ate));

  lista.sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
  res.json(lista);
});

app.get('/entregas/:id', (req, res) => {
  res.json(acharOu404(banco.entregas, req.params.id, 'Entrega'));
});

app.post(
  '/entregas',
  exigirPapel('entregador'),
  rota((req, res) => {
    const clienteId = texto(req.body.clienteId);
    exigir(clienteId, 'Informe o cliente da entrega.');

    const cliente = acharOu404(banco.clientes, clienteId, 'Cliente');
    const produto = texto(req.body.produto);
    exigir(produto, 'Informe o produto.');

    const quantidade = Math.round(numero(req.body.quantidade, 1));
    exigir(quantidade > 0, 'Quantidade inválida.');

    const valor = numero(req.body.valor, 0);
    exigir(valor >= 0, 'Valor inválido.');

    const status = STATUS.includes(req.body.status)
      ? req.body.status
      : 'pendente';

    const entrega = {
      id: novoId(),
      clienteId: cliente.id,
      clienteNome: cliente.nome,
      produto,
      quantidade,
      valor,
      status,
      criadaEm: req.body.criadaEm || new Date().toISOString(),
      entregueEm: status === 'entregue' ? new Date().toISOString() : null,
      observacao: texto(req.body.observacao),
      entregadorId: req.usuario.id,
      entregadorNome: texto(req.body.entregadorNome, req.usuario.nome),
    };

    banco.entregas.push(entrega);
    if (entrega.status === 'entregue') {
      cliente.ultimaCompra = entrega.entregueEm;
    }

    salvar();
    res.status(201).json(entrega);
  })
);

app.patch(
  '/entregas/:id',
  exigirPapel('entregador'),
  rota((req, res) => {
    const entrega = acharOu404(banco.entregas, req.params.id, 'Entrega');

    if (req.body.status !== undefined) {
      exigir(STATUS.includes(req.body.status), 'Status inválido.');
      entrega.status = req.body.status;
      entrega.entregueEm =
        req.body.status === 'entregue'
          ? req.body.entregueEm || new Date().toISOString()
          : null;

      if (entrega.status === 'entregue') {
        const cliente = banco.clientes.find((c) => c.id === entrega.clienteId);
        if (cliente) cliente.ultimaCompra = entrega.entregueEm;
      }
    }

    if (req.body.produto !== undefined) {
      entrega.produto = texto(req.body.produto, entrega.produto);
    }
    if (req.body.quantidade !== undefined) {
      entrega.quantidade = Math.round(
        numero(req.body.quantidade, entrega.quantidade)
      );
    }
    if (req.body.valor !== undefined) {
      entrega.valor = numero(req.body.valor, entrega.valor);
    }
    if (req.body.observacao !== undefined) {
      entrega.observacao = texto(req.body.observacao);
    }

    salvar();
    res.json(entrega);
  })
);

app.delete(
  '/entregas/:id',
  exigirPapel('admin'),
  rota((req, res) => {
    acharOu404(banco.entregas, req.params.id, 'Entrega');
    banco.entregas = banco.entregas.filter((e) => e.id !== req.params.id);
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// CONTATOS (TELEMARKETING)
// =============================================================

const RESULTADOS = ['venda', 'retornar', 'sem_interesse', 'nao_atendeu'];

app.get('/contatos', (req, res) => {
  const { clienteId } = req.query;
  let lista = [...banco.contatos];
  if (clienteId) lista = lista.filter((c) => c.clienteId === clienteId);
  lista.sort((a, b) => new Date(b.data) - new Date(a.data));
  res.json(lista);
});

app.post(
  '/contatos',
  exigirPapel('telemarketing'),
  rota((req, res) => {
    const cliente = acharOu404(
      banco.clientes,
      texto(req.body.clienteId),
      'Cliente'
    );
    const resultado = RESULTADOS.includes(req.body.resultado)
      ? req.body.resultado
      : 'nao_atendeu';

    const contato = {
      id: novoId(),
      clienteId: cliente.id,
      clienteNome: cliente.nome,
      resultado,
      anotacao: texto(req.body.anotacao),
      data: req.body.data || new Date().toISOString(),
      operadorId: req.usuario.id,
      operadorNome: req.usuario.nome,
    };

    banco.contatos.push(contato);

    // Venda fechada empurra a próxima recompra do cliente.
    if (resultado === 'venda') cliente.ultimaCompra = contato.data;

    salvar();
    res.status(201).json(contato);
  })
);

/** Clientes que entram em recompra nos próximos dias. */
app.get('/clientes-para-contato', (req, res) => {
  const limite = Math.round(numero(req.query.dias, 3));
  const hoje = Date.now();

  const lista = banco.clientes
    .map((cliente) => {
      if (!cliente.ultimaCompra) return { ...cliente, diasParaRecompra: null };
      const prevista =
        new Date(cliente.ultimaCompra).getTime() +
        cliente.intervaloDias * 86400000;
      return {
        ...cliente,
        proximaCompra: new Date(prevista).toISOString(),
        diasParaRecompra: Math.ceil((prevista - hoje) / 86400000),
      };
    })
    .filter((c) => c.diasParaRecompra !== null && c.diasParaRecompra <= limite)
    .sort((a, b) => a.diasParaRecompra - b.diasParaRecompra);

  res.json(lista);
});

// =============================================================
// USUÁRIOS (ADMIN)
// =============================================================

app.get('/usuarios', exigirPapel('admin'), (req, res) => {
  res.json(banco.usuarios.map(semSenha));
});

app.post(
  '/usuarios',
  exigirPapel('admin'),
  rota(async (req, res) => {
    const nome = texto(req.body.nome);
    const email = texto(req.body.email).toLowerCase();
    const senha = texto(req.body.senha || req.body.password);
    const papel = PAPEIS.includes(req.body.papel) ? req.body.papel : 'entregador';

    exigir(nome.length >= 2, 'Informe o nome.');
    exigir(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'E-mail inválido.');
    exigir(senha.length >= 6, 'A senha precisa ter ao menos 6 caracteres.');
    exigir(
      !banco.usuarios.some((u) => u.email === email),
      'Já existe um usuário com este e-mail.'
    );

    const usuario = {
      id: novoId(),
      nome,
      email,
      papel,
      ativo: req.body.ativo !== false,
      senhaHash: await bcrypt.hash(senha, 10),
    };

    banco.usuarios.push(usuario);
    salvar();
    res.status(201).json(semSenha(usuario));
  })
);

app.patch(
  '/usuarios/:id',
  exigirPapel('admin'),
  rota(async (req, res) => {
    const usuario = acharOu404(banco.usuarios, req.params.id, 'Usuário');

    if (req.body.nome !== undefined) usuario.nome = texto(req.body.nome, usuario.nome);
    if (req.body.email !== undefined) {
      const email = texto(req.body.email).toLowerCase();
      exigir(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'E-mail inválido.');
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
    if (req.body.senha) {
      exigir(
        texto(req.body.senha).length >= 6,
        'A senha precisa ter ao menos 6 caracteres.'
      );
      usuario.senhaHash = await bcrypt.hash(texto(req.body.senha), 10);
    }

    salvar();
    res.json(semSenha(usuario));
  })
);

app.delete(
  '/usuarios/:id',
  exigirPapel('admin'),
  rota((req, res) => {
    const usuario = acharOu404(banco.usuarios, req.params.id, 'Usuário');
    exigir(usuario.id !== req.usuario.id, 'Você não pode remover a própria conta.');
    banco.usuarios = banco.usuarios.filter((u) => u.id !== usuario.id);
    salvar();
    res.status(204).end();
  })
);

// =============================================================
// RELATÓRIOS
// =============================================================

app.get('/relatorios/resumo', exigirPapel('admin'), (req, res) => {
  const porStatus = {};
  STATUS.forEach((s) => {
    porStatus[s] = banco.entregas.filter((e) => e.status === s).length;
  });

  const faturamento = banco.entregas
    .filter((e) => e.status === 'entregue')
    .reduce((soma, e) => soma + e.valor * e.quantidade, 0);

  res.json({
    totalEntregas: banco.entregas.length,
    porStatus,
    faturamentoEntregue: Number(faturamento.toFixed(2)),
    totalClientes: banco.clientes.length,
    totalUsuarios: banco.usuarios.length,
    contatosRegistrados: banco.contatos.length,
  });
});

// =============================================================
// ERROS
// =============================================================

app.use((req, res) => {
  res.status(404).json({ statusCode: 404, message: 'Rota não encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((erro, req, res, next) => {
  const status = erro.status || 500;
  if (status >= 500) console.error(erro);
  res.status(status).json({
    statusCode: status,
    message: erro.message || 'Erro interno no servidor.',
  });
});

// =============================================================
// INÍCIO
// =============================================================

carregar();

app.listen(PORTA, () => {
  console.log(`API do App Entregas ouvindo na porta ${PORTA}`);
});
