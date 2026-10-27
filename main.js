const crypto = require("crypto");

const MASTER = { useMasterKey: true };

const DEPOSITOS = ["Depósito A", "Depósito B", "Depósito C"];

const UNIDADE = "chapas";
const TZ = "America/Recife";

const CATEGORIAS = [
  "Granitos",
  "Mármores",
  "Quartzitos",
  "Sintéticos",
  "Dolomíticos",
];

const TIPOS = ["Escovado", "Acetinado", "Polido"];

const MIN_VALIDADE = { verificacao: 30, reset: 15 };
const MAX_TENTATIVAS = 5;
const INTERVALO_REENVIO_SEG = 60;

function fail(erro, campos, codigo) {
  throw new Parse.Error(141, JSON.stringify({ erro, campos, codigo }));
}

function auth(req) {
  if (!req.user) {
    throw new Parse.Error(209, JSON.stringify({ erro: "Não autenticado" }));
  }

  if (req.user.get("emailVerificado") === false) {
    fail(
      "E-mail ainda não verificado",
      { email: "Confirme seu e-mail para continuar" },
      "EMAIL_NAO_VERIFICADO",
    );
  }

  return req.user;
}

function agora() {
  const d = new Date();

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const valores = Object.fromEntries(partes.map((p) => [p.type, p.value]));

  const data = `${valores.year}-${valores.month}-${valores.day}`;

  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  return { data, hora };
}

function dataHora(data) {
  const atual = agora();

  return {
    data: /^\d{4}-\d{2}-\d{2}$/.test(data || "") ? data : atual.data,
    hora: atual.hora,
  };
}

function calcStatus(estoque, minimo) {
  const e = Number(estoque) || 0;
  const m = Number(minimo) || 0;

  if (m <= 0 || e >= m) {
    return "ok";
  }

  if (e < m * 0.6) {
    return "crítico";
  }

  return "baixo";
}

const num = (v) => Number(String(v).replace(",", "."));

function quantidadeValida(v) {
  const q = num(v);

  if (
    v === undefined ||
    v === null ||
    String(v).trim() === "" ||
    !Number.isSafeInteger(q) ||
    q <= 0
  ) {
    fail("Quantidade inválida", {
      quantidade: "Informe uma quantidade inteira de chapas maior que zero",
    });
  }

  return q;
}

function minimoValido(v) {
  const n = num(v);

  if (
    v === undefined ||
    v === null ||
    String(v).trim() === "" ||
    !Number.isSafeInteger(n) ||
    n < 0
  ) {
    fail("Estoque mínimo inválido", {
      minimo: "Informe um número inteiro maior ou igual a zero",
    });
  }

  return n;
}

function exigirUnidadeChapas(m) {
  if (m.get("unidade") !== UNIDADE) {
    fail("A unidade do material precisa ser atualizada no Back4App", {
      material:
        "Verifique a unidade e o estoque cadastrado antes de movimentar chapas",
    });
  }
}

const fmtQtd = (tipo, q, un) =>
  tipo === "Entrada"
    ? `+${q} ${un}`
    : tipo === "Saída"
      ? `-${q} ${un}`
      : `${q} ${un}`;

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function todos(className, ordenar) {
  const itens = [];
  const tamanhoPagina = 1000;
  let skip = 0;

  while (true) {
    const q = new Parse.Query(className);

    q.limit(tamanhoPagina);
    q.skip(skip);

    if (ordenar) {
      q.ascending(ordenar);
    } else {
      q.ascending("createdAt");
    }

    const pagina = await q.find(MASTER);

    itens.push(...pagina);

    if (pagina.length < tamanhoPagina) {
      break;
    }

    skip += tamanhoPagina;
  }

  return itens;
}

async function buscarMaterial({ codigo, material } = {}) {
  const q = new Parse.Query("Material");

  if (codigo) {
    q.equalTo("cod", String(codigo));
  } else {
    q.equalTo("nome", material);
  }

  const m = await q.first(MASTER);

  if (!m) {
    fail("Material não encontrado", {
      material: "Selecione um material",
    });
  }

  return m;
}

async function proximoCodigo() {
  const lista = await todos("Material");

  const maior = lista.reduce((mx, m) => {
    const n = parseInt(String(m.get("cod")).replace(/\D/g, ""), 10);

    return isNaN(n) ? mx : Math.max(mx, n);
  }, 0);

  return `MAT-${String(maior + 1).padStart(3, "0")}`;
}

async function criarMaterialNovo({
  nome,
  categoria,
  tipo = "",
  unidade = UNIDADE,
  minimo = 0,
}) {
  nome = String(nome || "").trim();
  tipo = tipo || "";

  if (!nome) {
    fail("Informe o nome do material", {
      nomeNovo: "Informe o nome do material",
    });
  }

  if (!CATEGORIAS.includes(categoria)) {
    fail("Categoria inválida", {
      categoria: "Selecione uma categoria válida",
    });
  }

  if (tipo && !TIPOS.includes(tipo)) {
    fail("Tipo inválido", {
      tipo: "Tipo inválido",
    });
  }

  if (unidade !== UNIDADE) {
    fail("Unidade inválida", {
      unidade: "A unidade deve ser chapas",
    });
  }

  const minimoNumerico = minimoValido(minimo);

  const dup = await new Parse.Query("Material")
    .equalTo("nome", nome)
    .equalTo("categoria", categoria)
    .equalTo("tipo", tipo)
    .first(MASTER);

  if (dup) {
    fail("Material já cadastrado", {
      nomeNovo: `Já existe um material igual (${dup.get("cod")})`,
    });
  }

  const m = new Parse.Object("Material");

  m.set({
    cod: await proximoCodigo(),
    nome,
    categoria,
    tipo,
    unidade: UNIDADE,
    minimo: minimoNumerico,
  });

  await m.save(null, MASTER);

  return m;
}

async function enriquecerMovs(itens) {
  const materiais = await todos("Material");

  const porCod = Object.fromEntries(materiais.map((m) => [m.get("cod"), m]));

  return itens.map((i) => {
    const j = i.toJSON();
    const m = porCod[j.cod];

    return {
      ...j,
      codigo: j.cod,
      categoria: m ? m.get("categoria") : "",
      tipo_material: m ? m.get("tipo") || "" : "",
    };
  });
}

async function listarMateriais() {
  const [materiais, estoques] = await Promise.all([
    todos("Material", "cod"),
    todos("Estoque"),
  ]);

  return materiais.map((m) => {
    const cod = m.get("cod");

    const itens = estoques
      .filter(
        (e) =>
          e.get("cod") === cod &&
          DEPOSITOS.includes(e.get("deposito")) &&
          Number(e.get("qtd")) > 0,
      )
      .sort((a, b) => Number(b.get("qtd")) - Number(a.get("qtd")));

    const total = itens.reduce((s, e) => s + Number(e.get("qtd")), 0);

    const porDeposito = {};

    for (const e of itens) {
      const deposito = e.get("deposito");

      porDeposito[deposito] =
        (porDeposito[deposito] || 0) + Number(e.get("qtd"));
    }

    return {
      cod,
      nome: m.get("nome"),
      categoria: m.get("categoria"),
      tipo: m.get("tipo") || "",
      unidade: m.get("unidade"),
      estoque: total,
      minimo: m.get("minimo") || 0,
      local: itens[0] ? itens[0].get("deposito") : null,
      estoques: porDeposito,
      status: calcStatus(total, m.get("minimo")),
    };
  });
}

async function salvarMov(campos) {
  const mov = new Parse.Object("Movimentacao");

  mov.set({
    ...campos,
    nota: campos.nota || "—",
    obs: campos.obs || "",
  });

  await mov.save(null, MASTER);

  return mov.toJSON();
}

const pubUser = (u) => ({
  id: u.id,
  nome: u.get("nome"),
  email: u.get("email"),
  telefone: u.get("telefone"),
  cargo: u.get("cargo"),
});

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function formatarDataHora(d) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    dateStyle: "short",
    timeStyle: "short",
  }).format(d || new Date());
}

async function postJson(url, headers, body) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...headers,
  };

  if (typeof fetch === "function") {
    const r = await fetch(url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      throw new Error(`Falha ao enviar e-mail (HTTP ${r.status}): ${await r.text()}`);
    }

    return;
  }

  await Parse.Cloud.httpRequest({
    method: "POST",
    url,
    headers: h,
    body: JSON.stringify(body),
  });
}

async function enviarEmail({ para, assunto, html }) {
  const provider = (process.env.EMAIL_PROVIDER || "brevo").toLowerCase();
  const key = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;
  const fromName = process.env.EMAIL_FROM_NAME || "Marmopedras";

  if (!key || !from) {
    throw new Error("E-mail não configurado (EMAIL_API_KEY / EMAIL_FROM)");
  }

  if (provider === "resend") {
    await postJson(
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${key}` },
      { from: `${fromName} <${from}>`, to: [para], subject: assunto, html },
    );
    return;
  }

  await postJson(
    "https://api.brevo.com/v3/smtp/email",
    { "api-key": key },
    {
      sender: { name: fromName, email: from },
      to: [{ email: para }],
      subject: assunto,
      htmlContent: html,
    },
  );
}

function templateEmail(titulo, corpo) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e6d8c8;border-radius:8px">
  <h2 style="color:#5c1a22;margin:0 0 16px">${esc(titulo)}</h2>
  ${corpo}
  <p style="color:#999;font-size:12px;margin-top:24px">Marmopedras — controle de estoque</p>
</div>`;
}

const hashCodigo = (userId, tipo, codigo) =>
  crypto
    .createHmac("sha256", process.env.TOKEN_SECRET || "marmopedras-token")
    .update(`${userId}:${tipo}:${codigo}`)
    .digest("hex");

const iguais = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function buscarUsuarioPorEmail(email) {
  const mail = String(email || "").toLowerCase().trim();

  if (!mail) {
    return null;
  }

  return new Parse.Query(Parse.User).equalTo("email", mail).first(MASTER);
}

async function enviadoRecentemente(user, tipo) {
  const limite = new Date(Date.now() - INTERVALO_REENVIO_SEG * 1000);

  const t = await new Parse.Query("EmailToken")
    .equalTo("userId", user.id)
    .equalTo("tipo", tipo)
    .greaterThan("createdAt", limite)
    .first(MASTER);

  return !!t;
}

async function gerarCodigo(user, tipo) {
  const anteriores = await new Parse.Query("EmailToken")
    .equalTo("userId", user.id)
    .equalTo("tipo", tipo)
    .equalTo("usado", false)
    .limit(100)
    .find(MASTER);

  if (anteriores.length) {
    anteriores.forEach((t) => t.set("usado", true));
    await Parse.Object.saveAll(anteriores, MASTER);
  }

  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, "0");

  const t = new Parse.Object("EmailToken");

  t.set({
    userId: user.id,
    tipo,
    hash: hashCodigo(user.id, tipo, codigo),
    expiraEm: new Date(Date.now() + MIN_VALIDADE[tipo] * 60 * 1000),
    usado: false,
    tentativas: 0,
  });

  t.setACL(new Parse.ACL());

  await t.save(null, MASTER);

  return codigo;
}

async function enviarCodigo(user, tipo) {
  const codigo = await gerarCodigo(user, tipo);
  const nome = esc(user.get("nome") || "");
  const caixa = `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center;background:#faf6f1;padding:16px;border-radius:6px;margin:16px 0">${codigo}</p>`;

  if (tipo === "verificacao") {
    await enviarEmail({
      para: user.get("email"),
      assunto: "Confirme seu e-mail — Marmopedras",
      html: templateEmail(
        "Confirme seu e-mail",
        `<p>Olá, ${nome}!</p>
         <p>Use o código abaixo para confirmar seu cadastro. Ele vale por ${MIN_VALIDADE.verificacao} minutos.</p>
         ${caixa}
         <p>Se você não criou uma conta, ignore este e-mail.</p>`,
      ),
    });
    return;
  }

  await enviarEmail({
    para: user.get("email"),
    assunto: "Recuperação de senha — Marmopedras",
    html: templateEmail(
      "Recuperação de senha",
      `<p>Olá, ${nome}!</p>
       <p>Use o código abaixo para criar uma nova senha. Ele vale por ${MIN_VALIDADE.reset} minutos.</p>
       ${caixa}
       <p>Se você não pediu a recuperação, ignore este e-mail — sua senha continua a mesma.</p>`,
    ),
  });
}

async function validarCodigo(user, tipo, codigo, consumir = true) {
  const invalido = () =>
    fail("Código inválido ou expirado", {
      codigo: "Código inválido ou expirado",
    });

  if (!user || !/^\d{6}$/.test(String(codigo || "").trim())) {
    invalido();
  }

  const t = await new Parse.Query("EmailToken")
    .equalTo("userId", user.id)
    .equalTo("tipo", tipo)
    .equalTo("usado", false)
    .descending("createdAt")
    .first(MASTER);

  if (
    !t ||
    t.get("expiraEm") < new Date() ||
    (t.get("tentativas") || 0) >= MAX_TENTATIVAS
  ) {
    invalido();
  }

  if (!iguais(t.get("hash"), hashCodigo(user.id, tipo, String(codigo).trim()))) {
    t.increment("tentativas");
    await t.save(null, MASTER);
    invalido();
  }

  if (consumir) {
    t.set("usado", true);
    await t.save(null, MASTER);
  }
}

Parse.Cloud.beforeSave(Parse.User, async (req) => {
  if (req.master) {
    return;
  }

  if (req.object.isNew()) {
    req.object.set("emailVerificado", false);
    return;
  }

  if (req.object.dirty("emailVerificado")) {
    throw new Parse.Error(
      141,
      JSON.stringify({ erro: "Operação não permitida" }),
    );
  }
});

Parse.Cloud.beforeLogin(async (req) => {
  if (req.object.get("emailVerificado") === false) {
    fail(
      "E-mail ainda não verificado. Digite o código enviado ao seu e-mail.",
      { email: "E-mail ainda não verificado" },
      "EMAIL_NAO_VERIFICADO",
    );
  }
});

Parse.Cloud.afterSave(Parse.User, async (req) => {
  if (req.original) {
    return;
  }

  const admin = process.env.ADMIN_EMAIL;

  if (!admin) {
    return;
  }

  const u = req.object;

  try {
    await enviarEmail({
      para: admin,
      assunto: "Novo cadastro — Marmopedras",
      html: templateEmail(
        "Novo usuário cadastrado",
        `<table style="border-collapse:collapse;width:100%">
           <tr><td style="padding:6px 0;color:#666">Nome</td><td><b>${esc(u.get("nome"))}</b></td></tr>
           <tr><td style="padding:6px 0;color:#666">E-mail</td><td>${esc(u.get("email"))}</td></tr>
           <tr><td style="padding:6px 0;color:#666">Telefone</td><td>${esc(u.get("telefone") || "—")}</td></tr>
           <tr><td style="padding:6px 0;color:#666">Cargo</td><td>${esc(u.get("cargo") || "—")}</td></tr>
           <tr><td style="padding:6px 0;color:#666">Data e hora</td><td>${esc(formatarDataHora(u.createdAt))}</td></tr>
         </table>`,
      ),
    });
  } catch (e) {
    console.error("Falha ao avisar o admin sobre novo cadastro:", e.message);
  }
});

Parse.Cloud.define("register", async (req) => {
  const { nome, email, telefone, cargo, senha } = req.params;

  const campos = {};

  if (!nome || !String(nome).trim()) {
    campos.nome = "Informe seu nome completo";
  }

  if (!/\S+@\S+\.\S+/.test(email || "")) {
    campos.email = "E-mail inválido";
  }

  if (!senha || String(senha).length < 6) {
    campos.senha = "Mínimo 6 caracteres";
  }

  if (Object.keys(campos).length) {
    fail("Dados inválidos", campos);
  }

  const mail = String(email).toLowerCase().trim();

  const existente = await buscarUsuarioPorEmail(mail);

  if (existente) {
    if (existente.get("emailVerificado") !== false) {
      fail("E-mail já cadastrado", {
        email: "E-mail já cadastrado",
      });
    }

    existente.set({
      nome: String(nome).trim(),
      telefone: telefone || "",
      cargo: cargo || "Funcionário",
      password: senha,
    });

    await existente.save(null, MASTER);

    let reenvioOk = true;

    if (!(await enviadoRecentemente(existente, "verificacao"))) {
      try {
        await enviarCodigo(existente, "verificacao");
      } catch (e) {
        reenvioOk = false;
        console.error("Falha ao reenviar código de verificação:", e.message);
      }
    }

    return {
      precisaVerificar: true,
      email: mail,
      emailEnviado: reenvioOk,
      reenviado: true,
    };
  }

  const user = new Parse.User();

  user.set({
    username: mail,
    email: mail,
    password: senha,
    nome: String(nome).trim(),
    telefone: telefone || "",
    cargo: cargo || "Funcionário",
    emailVerificado: false,
  });

  try {
    await user.signUp(null, MASTER);
  } catch (e) {
    if (e.code === 202 || e.code === 203) {
      fail("E-mail já cadastrado", {
        email: "E-mail já cadastrado",
      });
    }

    throw e;
  }

  let emailEnviado = true;

  try {
    await enviarCodigo(user, "verificacao");
  } catch (e) {
    emailEnviado = false;
    console.error("Falha ao enviar código de verificação:", e.message);
  }

  return { precisaVerificar: true, email: mail, emailEnviado };
});

const parametros = (req) => {
  const x = req.params || {};

  return {
    email: x.email,
    codigo: x.codigo ?? x.code ?? x.token,
    novaSenha:
      x.novaSenha ?? x.senha ?? x.password ?? x.newPassword ?? x.nova_senha,
  };
};

const verificarEmail = async (req) => {
  const { email, codigo } = parametros(req);

  const user = await buscarUsuarioPorEmail(email);

  if (user && user.get("emailVerificado") === false) {
    await validarCodigo(user, "verificacao", codigo);

    user.set("emailVerificado", true);
    await user.save(null, MASTER);

    return { verificado: true };
  }

  if (user) {
    return { verificado: true };
  }

  fail("Código inválido ou expirado", {
    codigo: "Código inválido ou expirado",
  });
};

const reenviarVerificacao = async (req) => {
  const user = await buscarUsuarioPorEmail(parametros(req).email);

  if (
    user &&
    user.get("emailVerificado") === false &&
    !(await enviadoRecentemente(user, "verificacao"))
  ) {
    try {
      await enviarCodigo(user, "verificacao");
    } catch (e) {
      console.error("Falha ao reenviar verificação:", e.message);
    }
  }

  return { ok: true };
};

const solicitarRecuperacaoSenha = async (req) => {
  const user = await buscarUsuarioPorEmail(parametros(req).email);

  if (user && !(await enviadoRecentemente(user, "reset"))) {
    try {
      await enviarCodigo(user, "reset");
    } catch (e) {
      console.error("Falha ao enviar recuperação de senha:", e.message);
    }
  }

  return { ok: true };
};

const redefinirSenha = async (req) => {
  const { email, codigo, novaSenha } = parametros(req);

  if (!novaSenha || String(novaSenha).length < 6) {
    fail("Dados inválidos", { senha: "Mínimo 6 caracteres" });
  }

  const user = await buscarUsuarioPorEmail(email);

  if (!user) {
    fail("Código inválido ou expirado", {
      codigo: "Código inválido ou expirado",
    });
  }

  await validarCodigo(user, "reset", codigo);

  user.set("password", novaSenha);

  if (user.get("emailVerificado") === false) {
    user.set("emailVerificado", true);
  }

  await user.save(null, MASTER);

  return { ok: true };
};

const verificarCodigoReset = async (req) => {
  const { email, codigo } = parametros(req);

  const user = await buscarUsuarioPorEmail(email);

  if (!user) {
    fail("Código inválido ou expirado", {
      codigo: "Código inválido ou expirado",
    });
  }

  await validarCodigo(user, "reset", codigo, false);

  return { ok: true, valido: true, verificado: true };
};

const registrarFuncao = (nomes, fn) =>
  nomes.forEach((nome) => Parse.Cloud.define(nome, fn));

registrarFuncao(["verificarEmail", "verify-email", "verifyEmail"], verificarEmail);

registrarFuncao(
  [
    "reenviarVerificacao",
    "resend-verification",
    "resend-code",
    "resendVerification",
  ],
  reenviarVerificacao,
);

registrarFuncao(
  [
    "solicitarRecuperacaoSenha",
    "forgot-password",
    "forgotPassword",
    "resend-reset-code",
  ],
  solicitarRecuperacaoSenha,
);

registrarFuncao(
  ["verificarCodigoReset", "verify-reset-code", "verifyResetCode"],
  verificarCodigoReset,
);

registrarFuncao(
  ["redefinirSenha", "reset-password", "resetPassword"],
  redefinirSenha,
);

Parse.Cloud.define("login", async (req) => {
  const { email, senha } = req.params;

  try {
    const user = await Parse.User.logIn(
      String(email || "")
        .toLowerCase()
        .trim(),
      senha || "",
    );

    return {
      token: user.getSessionToken(),
      usuario: pubUser(user),
    };
  } catch (e) {
    if (e.code === 141) {
      throw e;
    }

    fail("E-mail ou senha incorretos");
  }
});

Parse.Cloud.define("me", async (req) => pubUser(auth(req)));

Parse.Cloud.define("painel", async (req) => {
  auth(req);

  const { data } = agora();

  const mq = (tipo) =>
    new Parse.Query("Movimentacao").equalTo("tipo", tipo).equalTo("data", data);

  const [materiais, movs, entradasHoje, saidasHoje] = await Promise.all([
    listarMateriais(),

    new Parse.Query("Movimentacao")
      .descending("createdAt")
      .limit(5)
      .find(MASTER),

    mq("Entrada").count(MASTER),

    mq("Saída").limit(1000).find(MASTER),
  ]);

  const obras = new Set(saidasHoje.map((s) => s.get("obra")).filter(Boolean));

  const ultimas = await enriquecerMovs(movs);

  return {
    cards: {
      totalSkus: materiais.length,
      entradasHoje,
      saidasHoje: saidasHoje.length,
      obrasHoje: obras.size,
      saldoBaixo: materiais.filter((m) => m.status !== "ok").length,
    },

    ultimasMovimentacoes: ultimas.map((m) => ({
      hora: m.hora,
      tipo: m.tipo,
      material: m.material,
      qtd: m.qtd,
      codigo: m.codigo,
      categoria: m.categoria,
      tipo_material: m.tipo_material,
    })),

    criticos: materiais
      .filter((m) => m.status === "crítico")
      .slice(0, 3)
      .map((m) => ({
        cod: m.cod,
        nome: m.nome,
      })),
  };
});

Parse.Cloud.define("listarMateriais", async (req) => {
  auth(req);

  const { q = "", categoria = "Todos", status = "Todos" } = req.params;

  const termo = String(q).toLowerCase();

  return (await listarMateriais()).filter(
    (m) =>
      (m.nome.toLowerCase().includes(termo) ||
        m.cod.toLowerCase().includes(termo)) &&
      (categoria === "Todos" || m.categoria === categoria) &&
      (status === "Todos" || m.status === String(status).toLowerCase()),
  );
});

Parse.Cloud.define("categorias", async (req) => {
  auth(req);

  const existentes = (await todos("Material"))
    .map((m) => m.get("categoria"))
    .filter(Boolean);

  const extras = [...new Set(existentes)]
    .filter((c) => !CATEGORIAS.includes(c))
    .sort();

  return ["Todos", ...CATEGORIAS, ...extras];
});

Parse.Cloud.define("criarMaterial", async (req) => {
  auth(req);

  const { nome, categoria, tipo = "", minimo = 0 } = req.params;

  if (!nome || !categoria) {
    fail("nome e categoria são obrigatórios");
  }

  const m = await criarMaterialNovo({
    nome,
    categoria,
    tipo,
    unidade: UNIDADE,
    minimo,
  });

  return {
    ...m.toJSON(),
    codigo: m.get("cod"),
  };
});

Parse.Cloud.define("registrarEntrada", async (req) => {
  const user = auth(req);

  const {
    material,
    codigo,
    novoMaterial = false,
    categoria,
    tipo = "",
    quantidade,
    local = "Depósito A",
    nota = "",
    data,
    obs = "",
  } = req.params;

  const q = quantidadeValida(quantidade);

  if (!DEPOSITOS.includes(local)) {
    fail("Depósito inválido", {
      local: "Selecione o Depósito A, B ou C",
    });
  }

  const m = novoMaterial
    ? await criarMaterialNovo({
        nome: material,
        categoria,
        tipo,
        unidade: UNIDADE,
      })
    : await buscarMaterial({
        codigo,
        material,
      });

  exigirUnidadeChapas(m);

  let est = await new Parse.Query("Estoque")
    .equalTo("cod", m.get("cod"))
    .equalTo("deposito", local)
    .first(MASTER);

  if (!est) {
    est = new Parse.Object("Estoque");

    est.set({
      cod: m.get("cod"),
      deposito: local,
      qtd: 0,
    });
  }

  est.increment("qtd", q);

  await est.save(null, MASTER);

  const mov = await salvarMov({
    tipo: "Entrada",
    cod: m.get("cod"),
    material: m.get("nome"),
    quantidade: q,
    unidade: UNIDADE,
    qtd: fmtQtd("Entrada", q, UNIDADE),
    local,
    nota,
    obs,
    responsavel: user.get("nome"),
    ...dataHora(data),
  });

  return {
    ...mov,
    codigo: m.get("cod"),
    categoria: m.get("categoria"),
    tipo_material: m.get("tipo") || "",
    materialNovo: !!novoMaterial,
  };
});

Parse.Cloud.define("registrarSaida", async (req) => {
  const user = auth(req);

  const {
    material,
    codigo,
    quantidade,
    obra,
    data,
    responsavel,
    obs = "",
    local,
  } = req.params;

  const m = await buscarMaterial({
    codigo,
    material,
  });

  const q = quantidadeValida(quantidade);

  exigirUnidadeChapas(m);

  const obraDestino = String(obra || "").trim();

  if (!obraDestino) {
    fail("Informe a obra de destino", {
      obra: "Informe a obra de destino",
    });
  }

  if (local && !DEPOSITOS.includes(local)) {
    fail("Depósito inválido", {
      local: "Selecione um depósito válido",
    });
  }

  const eq = new Parse.Query("Estoque")
    .equalTo("cod", m.get("cod"))
    .greaterThan("qtd", 0)
    .limit(1000);

  if (local) {
    eq.equalTo("deposito", local);
  } else {
    eq.containedIn("deposito", DEPOSITOS);
  }

  const deps = (await eq.find(MASTER)).sort(
    (a, b) => Number(b.get("qtd")) - Number(a.get("qtd")),
  );

  const total = deps.reduce((s, d) => s + Number(d.get("qtd")), 0);

  if (q > total) {
    fail("Estoque insuficiente", {
      quantidade: `Estoque insuficiente (disponível: ${total} chapas)`,
    });
  }

  let restante = q;
  const origens = [];
  const alterados = [];

  for (const d of deps) {
    if (restante <= 0) {
      break;
    }

    const tirar = Math.min(Number(d.get("qtd")), restante);

    d.increment("qtd", -tirar);

    restante -= tirar;

    origens.push(d.get("deposito"));
    alterados.push(d);
  }

  await Parse.Object.saveAll(alterados, MASTER);

  return salvarMov({
    tipo: "Saída",
    cod: m.get("cod"),
    material: m.get("nome"),
    quantidade: q,
    unidade: UNIDADE,
    qtd: fmtQtd("Saída", q, UNIDADE),
    local: `${origens.join(" / ")} → ${obraDestino}`,
    obra: obraDestino,
    obs,
    responsavel: responsavel || user.get("nome"),
    ...dataHora(data),
  });
});

Parse.Cloud.define("registrarTransferencia", async (req) => {
  const user = auth(req);

  const { material, codigo, quantidade, origem, destino, obs = "" } = req.params;

  const m = await buscarMaterial({
    codigo,
    material,
  });

  const q = quantidadeValida(quantidade);

  exigirUnidadeChapas(m);

  const campos = {};

  if (!DEPOSITOS.includes(origem)) {
    campos.origem = "Selecione a origem";
  }

  if (!DEPOSITOS.includes(destino)) {
    campos.destino = "Selecione o destino";
  }

  if (origem && origem === destino) {
    campos.destino = "Origem e destino devem ser diferentes";
  }

  if (Object.keys(campos).length) {
    fail("Dados inválidos", campos);
  }

  const cod = m.get("cod");

  const [eOrigem, eDestino] = await Promise.all([
    new Parse.Query("Estoque")
      .equalTo("cod", cod)
      .equalTo("deposito", origem)
      .first(MASTER),

    new Parse.Query("Estoque")
      .equalTo("cod", cod)
      .equalTo("deposito", destino)
      .first(MASTER),
  ]);

  const disponivel = eOrigem ? Number(eOrigem.get("qtd")) : 0;

  if (q > disponivel) {
    fail("Saldo insuficiente na origem", {
      quantidade: `Apenas ${disponivel} chapas disponíveis em ${origem}`,
    });
  }

  eOrigem.increment("qtd", -q);

  let dest = eDestino;

  if (!dest) {
    dest = new Parse.Object("Estoque");

    dest.set({
      cod,
      deposito: destino,
      qtd: 0,
    });
  }

  dest.increment("qtd", q);

  await Parse.Object.saveAll([eOrigem, dest], MASTER);

  const curto = (d) => d.replace("Depósito", "Dep.");

  return salvarMov({
    tipo: "Transferência",
    cod,
    material: m.get("nome"),
    quantidade: q,
    unidade: UNIDADE,
    qtd: fmtQtd("Transferência", q, UNIDADE),
    de: origem,
    para: destino,
    local: `${curto(origem)} → ${curto(destino)}`,
    obs,
    responsavel: user.get("nome"),
    ...dataHora(),
  });
});

Parse.Cloud.define("listarMovimentacoes", async (req) => {
  auth(req);

  const {
    tipo = "Todos",
    inicio,
    fim,
    busca = "",
    page = 1,
    limit = 8,
  } = req.params;

  const p = Math.max(1, parseInt(page, 10) || 1);

  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 8));

  const montar = (t) => {
    let q;

    if (busca) {
      const rx = escRx(busca);

      q = Parse.Query.or(
        new Parse.Query("Movimentacao").matches("material", rx, "i"),

        new Parse.Query("Movimentacao").matches("cod", rx, "i"),

        new Parse.Query("Movimentacao").matches("responsavel", rx, "i"),
      );
    } else {
      q = new Parse.Query("Movimentacao");
    }

    if (t && t !== "Todos") {
      q.equalTo("tipo", t);
    }

    if (inicio) {
      q.greaterThanOrEqualTo("data", inicio);
    }

    if (fim) {
      q.lessThanOrEqualTo("data", fim);
    }

    return q;
  };

  const [itens, total, nEntradas, nSaidas, nTransf] = await Promise.all([
    montar(tipo)
      .descending("data")
      .addDescending("hora")
      .skip((p - 1) * l)
      .limit(l)
      .find(MASTER),

    montar(tipo).count(MASTER),
    montar("Entrada").count(MASTER),
    montar("Saída").count(MASTER),
    montar("Transferência").count(MASTER),
  ]);

  return {
    itens: await enriquecerMovs(itens),
    total,
    page: p,
    totalPages: Math.max(1, Math.ceil(total / l)),
    resumo: {
      Entrada: nEntradas,
      Saída: nSaidas,
      Transferência: nTransf,
    },
  };
});

Parse.Cloud.define("ultimasMovimentacoes", async (req) => {
  auth(req);

  const mapa = {
    entradas: "Entrada",
    saidas: "Saída",
    transferencias: "Transferência",
  };

  const tipo = mapa[req.params.tipo];

  if (!tipo) {
    fail("Tipo inválido");
  }

  const itens = await new Parse.Query("Movimentacao")
    .equalTo("tipo", tipo)
    .descending("createdAt")
    .limit(5)
    .find(MASTER);

  return enriquecerMovs(itens);
});

Parse.Cloud.define("distribuicao", async (req) => {
  auth(req);

  const [deps, materiais, estoques] = await Promise.all([
    todos("Deposito", "id_"),
    todos("Material"),
    todos("Estoque"),
  ]);

  const porCod = Object.fromEntries(materiais.map((m) => [m.get("cod"), m]));

  const totalPorCod = {};

  for (const e of estoques) {
    if (!DEPOSITOS.includes(e.get("deposito"))) {
      continue;
    }

    const cod = e.get("cod");

    totalPorCod[cod] = (totalPorCod[cod] || 0) + (Number(e.get("qtd")) || 0);
  }

  return DEPOSITOS.map((nome, index) => {
    const d = deps.find((item) => item.get("nome") === nome);

    const itens = estoques
      .filter((e) => e.get("deposito") === nome && Number(e.get("qtd")) > 0)
      .map((e) => {
        const m = porCod[e.get("cod")];

        if (!m) {
          return null;
        }

        return {
          cod: m.get("cod"),
          nome: m.get("nome"),
          categoria: m.get("categoria"),
          tipo: m.get("tipo") || "",
          qtd: Number(e.get("qtd")),
          unidade: m.get("unidade"),
          minimo: m.get("minimo") || 0,
          status: calcStatus(totalPorCod[e.get("cod")], m.get("minimo")),
        };
      })
      .filter(Boolean);

    return {
      id: d?.get("id_") || ["A", "B", "C"][index],
      nome,
      capacidade: d?.get("capacidade") ?? 0,
      materiais: itens,
      ocupacao: itens.reduce((s, i) => s + i.qtd, 0),
    };
  });
});

Parse.Cloud.define("salvarLead", async (req) => {
  const d = req.params || {};

  if (!d.nome) {
    fail("nome é obrigatório");
  }

  const lead = new Parse.Object("Lead");

  lead.set({
    nome: d.nome,
    localizacao: d.localizacao || "",
    tipoObra: d.tipoObra || "",
    projetoMedidas: d.projetoMedidas || "",
    material: d.material || "",
    corEstilo: d.corEstilo || "",
    telefone: d.telefone || "",
    status: "novo",
  });

  await lead.save(null, MASTER);

  return lead.toJSON();
});

Parse.Cloud.define("listarLeads", async (req) => {
  auth(req);

  const leads = await new Parse.Query("Lead")
    .descending("createdAt")
    .limit(200)
    .find(MASTER);

  return leads.map((l) => l.toJSON());
});

async function executarSeed() {
  return "Seed de demonstração desativado";
}

Parse.Cloud.job("seed", async () => executarSeed());

Parse.Cloud.define("seed", async () => executarSeed(), {
  requireMaster: true,
});

Parse.Cloud.define(
  "testarEmail",
  async (req) => {
    const para = req.params.para || process.env.ADMIN_EMAIL;

    try {
      await enviarEmail({
        para,
        assunto: "Teste — Marmopedras",
        html: templateEmail(
          "Teste de e-mail",
          "<p>Se você recebeu esta mensagem, o envio de e-mails está funcionando.</p>",
        ),
      });

      return {
        ok: true,
        para,
        provider: process.env.EMAIL_PROVIDER || "brevo",
      };
    } catch (e) {
      return {
        ok: false,
        erro: e.message,
        configurado: {
          EMAIL_API_KEY: !!process.env.EMAIL_API_KEY,
          EMAIL_FROM: !!process.env.EMAIL_FROM,
          ADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
          EMAIL_PROVIDER: process.env.EMAIL_PROVIDER || "brevo (padrão)",
        },
      };
    }
  },
  { requireMaster: true },
);
