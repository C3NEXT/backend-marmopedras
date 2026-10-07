const MASTER = { useMasterKey: true };
const DEPOSITOS = ["Depósito A", "Depósito B", "Depósito C", "Depósito D"];
const TZ = "America/Recife";

const CATEGORIAS = ["Granitos", "Mármores", "Quartzitos", "Sintéticos", "Dolomíticos"];
const TIPOS = ["Escovado", "Acetinado", "Polido"];

function fail(erro, campos) {
  throw new Parse.Error(141, JSON.stringify({ erro, campos }));
}

function auth(req) {
  if (!req.user) throw new Parse.Error(209, JSON.stringify({ erro: "Não autenticado" }));
  return req.user;
}

function agora() {
  const d = new Date();
  const data = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return { data, hora };
}

function dataHora(data) {
  const a = agora();
  return {
    data: /^\d{4}-\d{2}-\d{2}$/.test(data || "") ? data : a.data,
    hora: a.hora
  };
}

function calcStatus(estoque, minimo) {
  if (estoque >= minimo) return "ok";
  if (estoque < minimo * 0.6) return "crítico";
  return "baixo";
}

const num = (v) => Number(String(v).replace(",", "."));

function quantidadeValida(v) {
  const q = num(v);
  if (v === undefined || v === null || v === "" || isNaN(q) || q <= 0)
    fail("Quantidade inválida", {
      quantidade: "Informe uma quantidade válida"
    });
  return q;
}

const fmtQtd = (tipo, q, un) =>
  tipo === "Entrada"
    ? `+${q} ${un}`
    : tipo === "Saída"
      ? `-${q} ${un}`
      : `${q} ${un}`;

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function todos(className, ordenar) {
  const q = new Parse.Query(className);
  q.limit(1000);
  if (ordenar) q.ascending(ordenar);
  return q.find(MASTER);
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
      material: "Selecione um material"
    });
  }

  return m;
}

async function proximoCodigo() {
  const lista = await todos("Material");

  const maior = lista.reduce((mx, m) => {
    const n = parseInt(
      String(m.get("cod")).replace(/\D/g, ""),
      10
    );

    return isNaN(n) ? mx : Math.max(mx, n);
  }, 0);

  return `MAT-${String(maior + 1).padStart(3, "0")}`;
}

async function criarMaterialNovo({
  nome,
  categoria,
  tipo = "",
  unidade,
  minimo = 0
}) {
  nome = String(nome || "").trim();
  tipo = tipo || "";

  if (!nome) {
    fail("Informe o nome do material", {
      nomeNovo: "Informe o nome do material"
    });
  }

  if (!CATEGORIAS.includes(categoria)) {
    fail("Categoria inválida", {
      categoria: "Selecione uma categoria válida"
    });
  }

  if (tipo && !TIPOS.includes(tipo)) {
    fail("Tipo inválido", {
      tipo: "Tipo inválido"
    });
  }

  if (!unidade) {
    fail("Informe a unidade", {
      quantidade: "Informe a unidade"
    });
  }

  const dup = await new Parse.Query("Material")
    .equalTo("nome", nome)
    .equalTo("categoria", categoria)
    .equalTo("tipo", tipo)
    .first(MASTER);

  if (dup) {
    fail("Material já cadastrado", {
      nomeNovo: `Já existe um material igual (${dup.get("cod")}) com esse nome, categoria e tipo`
    });
  }

  const m = new Parse.Object("Material");

  m.set({
    cod: await proximoCodigo(),
    nome,
    categoria,
    tipo,
    unidade,
    minimo: Number(minimo) || 0
  });

  await m.save(null, MASTER);

  return m;
}

async function enriquecerMovs(itens) {
  const porCod = Object.fromEntries(
    (await todos("Material")).map((m) => [
      m.get("cod"),
      m
    ])
  );

  return itens.map((i) => {
    const j = i.toJSON();
    const m = porCod[j.cod];

    return {
      ...j,
      codigo: j.cod,
      categoria: m ? m.get("categoria") : "",
      tipo_material: m ? m.get("tipo") || "" : ""
    };
  });
}

async function listarMateriais() {
  const [materiais, estoques] = await Promise.all([
    todos("Material", "cod"),
    todos("Estoque")
  ]);

  return materiais.map((m) => {
    const cod = m.get("cod");

    const itens = estoques
      .filter(
        (e) =>
          e.get("cod") === cod &&
          e.get("qtd") > 0
      )
      .sort(
        (a, b) => b.get("qtd") - a.get("qtd")
      );

    const total = itens.reduce(
      (s, e) => s + e.get("qtd"),
      0
    );

    return {
      cod,
      nome: m.get("nome"),
      categoria: m.get("categoria"),
      tipo: m.get("tipo") || "",
      unidade: m.get("unidade"),
      estoque: total,
      minimo: m.get("minimo"),
      local: itens[0]
        ? itens[0].get("deposito")
        : null,
      estoques: Object.fromEntries(
        itens.map((e) => [
          e.get("deposito"),
          e.get("qtd")
        ])
      ),
      status: calcStatus(
        total,
        m.get("minimo")
      )
    };
  });
}

async function salvarMov(campos) {
  const mov = new Parse.Object("Movimentacao");

  mov.set({
    ...campos,
    nota: campos.nota || "—",
    obs: campos.obs || ""
  });

  await mov.save(null, MASTER);

  return mov.toJSON();
}

const pubUser = (u) => ({
  id: u.id,
  nome: u.get("nome"),
  email: u.get("email"),
  telefone: u.get("telefone"),
  empresa: u.get("empresa"),
  cargo: u.get("cargo")
});

Parse.Cloud.define("register", async (req) => {
  const {
    nome,
    email,
    telefone,
    empresa,
    cargo,
    senha
  } = req.params;

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

  const mail = String(email)
    .toLowerCase()
    .trim();

  const user = new Parse.User();

  user.set({
    username: mail,
    email: mail,
    password: senha,
    nome: String(nome).trim(),
    telefone: telefone || "",
    empresa: empresa || "",
    cargo: cargo || "Funcionário"
  });

  try {
    await user.signUp(null, MASTER);
  } catch (e) {
    if (e.code === 202 || e.code === 203) {
      fail("E-mail já cadastrado", {
        email: "E-mail já cadastrado"
      });
    }

    throw e;
  }

  return {
    token: user.getSessionToken(),
    usuario: pubUser(user)
  };
});

Parse.Cloud.define("login", async (req) => {
  const {
    email,
    senha
  } = req.params;

  try {
    const user = await Parse.User.logIn(
      String(email || "")
        .toLowerCase()
        .trim(),
      senha || ""
    );

    return {
      token: user.getSessionToken(),
      usuario: pubUser(user)
    };
  } catch (e) {
    fail("E-mail ou senha incorretos");
  }
});

Parse.Cloud.define("me", async (req) => {
  return pubUser(auth(req));
});

Parse.Cloud.define("painel", async (req) => {
  auth(req);

  const { data } = agora();

  const mq = (tipo) =>
    new Parse.Query("Movimentacao")
      .equalTo("tipo", tipo)
      .equalTo("data", data);

  const [
    materiais,
    movs,
    entradasHoje,
    saidasHoje
  ] = await Promise.all([
    listarMateriais(),
    new Parse.Query("Movimentacao")
      .descending("createdAt")
      .limit(5)
      .find(MASTER),
    mq("Entrada").count(MASTER),
    mq("Saída").limit(1000).find(MASTER)
  ]);

  const obras = new Set(
    saidasHoje
      .map((s) => s.get("obra"))
      .filter(Boolean)
  );

  const ultimas = await enriquecerMovs(movs);

  return {
    cards: {
      totalSkus: materiais.length,
      entradasHoje,
      saidasHoje: saidasHoje.length,
      obrasHoje: obras.size,
      saldoBaixo: materiais.filter(
        (m) => m.status !== "ok"
      ).length
    },

    ultimasMovimentacoes: ultimas.map((m) => ({
      hora: m.hora,
      tipo: m.tipo,
      material: m.material,
      qtd: m.qtd,
      codigo: m.codigo,
      categoria: m.categoria,
      tipo_material: m.tipo_material
    })),

    criticos: materiais
      .filter((m) => m.status === "crítico")
      .slice(0, 3)
      .map((m) => ({
        cod: m.cod,
        nome: m.nome
      }))
  };
});

Parse.Cloud.define("listarMateriais", async (req) => {
  auth(req);

  const {
    q = "",
    categoria = "Todos",
    status = "Todos"
  } = req.params;

  const termo = String(q).toLowerCase();

  return (await listarMateriais()).filter(
    (m) =>
      (
        m.nome.toLowerCase().includes(termo) ||
        m.cod.toLowerCase().includes(termo)
      ) &&
      (categoria === "Todos" ||
        m.categoria === categoria) &&
      (status === "Todos" ||
        m.status === String(status).toLowerCase())
  );
});

Parse.Cloud.define("categorias", async (req) => {
  auth(req);

  const existentes = (await todos("Material"))
    .map((m) => m.get("categoria"))
    .filter(Boolean);

  const extras = [
    ...new Set(existentes)
  ]
    .filter((c) => !CATEGORIAS.includes(c))
    .sort();

  return [
    "Todos",
    ...CATEGORIAS,
    ...extras
  ];
});

Parse.Cloud.define("criarMaterial", async (req) => {
  auth(req);

  const {
    nome,
    categoria,
    tipo = "",
    unidade,
    minimo = 0
  } = req.params;

  if (!nome || !categoria || !unidade) {
    fail(
      "nome, categoria e unidade são obrigatórios"
    );
  }

  const m = await criarMaterialNovo({
    nome,
    categoria,
    tipo,
    unidade,
    minimo
  });

  return {
    ...m.toJSON(),
    codigo: m.get("cod")
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
    unidade,
    quantidade,
    local = "Depósito A",
    nota = "",
    data,
    obs = ""
  } = req.params;

  const q = quantidadeValida(quantidade);

  if (!DEPOSITOS.includes(local)) {
    fail("Depósito inválido", {
      local: "Depósito inválido"
    });
  }

  const m = novoMaterial
    ? await criarMaterialNovo({
        nome: material,
        categoria,
        tipo,
        unidade: unidade || "m²"
      })
    : await buscarMaterial({
        codigo,
        material
      });

  let est = await new Parse.Query("Estoque")
    .equalTo("cod", m.get("cod"))
    .equalTo("deposito", local)
    .first(MASTER);

  if (!est) {
    est = new Parse.Object("Estoque");

    est.set({
      cod: m.get("cod"),
      deposito: local,
      qtd: 0
    });
  }

  est.increment("qtd", q);

  await est.save(null, MASTER);

  const mov = await salvarMov({
    tipo: "Entrada",
    cod: m.get("cod"),
    material: m.get("nome"),
    quantidade: q,
    unidade: m.get("unidade"),
    qtd: fmtQtd(
      "Entrada",
      q,
      m.get("unidade")
    ),
    local,
    nota,
    obs,
    responsavel: user.get("nome"),
    ...dataHora(data)
  });

  return {
    ...mov,
    codigo: m.get("cod"),
    categoria: m.get("categoria"),
    tipo_material: m.get("tipo") || "",
    materialNovo: !!novoMaterial
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
    local
  } = req.params;

  const m = await buscarMaterial({
    codigo,
    material
  });

  const q = quantidadeValida(quantidade);

  if (!obra) {
    fail(
      "Informe a obra de destino",
      {
        obra: "Informe a obra de destino"
      }
    );
  }

  const eq = new Parse.Query("Estoque")
    .equalTo("cod", m.get("cod"))
    .greaterThan("qtd", 0)
    .limit(100);

  if (local) {
    eq.equalTo("deposito", local);
  }

  const deps = (
    await eq.find(MASTER)
  ).sort(
    (a, b) => b.get("qtd") - a.get("qtd")
  );

  const total = deps.reduce(
    (s, d) => s + d.get("qtd"),
    0
  );

  if (q > total) {
    fail(
      "Estoque insuficiente",
      {
        quantidade: `Estoque insuficiente (disponível: ${total} ${m.get("unidade")})`
      }
    );
  }

  let restante = q;
  const origens = [];

  for (const d of deps) {
    if (restante <= 0) break;

    const tirar = Math.min(
      d.get("qtd"),
      restante
    );

    d.increment("qtd", -tirar);
    restante -= tirar;

    origens.push(
      d.get("deposito")
    );
  }

  await Parse.Object.saveAll(
    deps,
    MASTER
  );

  return salvarMov({
    tipo: "Saída",
    cod: m.get("cod"),
    material: m.get("nome"),
    quantidade: q,
    unidade: m.get("unidade"),
    qtd: fmtQtd(
      "Saída",
      q,
      m.get("unidade")
    ),
    local: `${origens.join(" / ")} → ${obra}`,
    obra,
    obs,
    responsavel:
      responsavel || user.get("nome"),
    ...dataHora(data)
  });
});

Parse.Cloud.define(
  "registrarTransferencia",
  async (req) => {
    const user = auth(req);

    const {
      material,
      codigo,
      quantidade,
      origem,
      destino,
      obs = ""
    } = req.params;

    const m = await buscarMaterial({
      codigo,
      material
    });

    const q = quantidadeValida(
      quantidade
    );

    const campos = {};

    if (!DEPOSITOS.includes(origem)) {
      campos.origem = "Selecione a origem";
    }

    if (!DEPOSITOS.includes(destino)) {
      campos.destino = "Selecione o destino";
    }

    if (origem && origem === destino) {
      campos.destino =
        "Origem e destino devem ser diferentes";
    }

    if (Object.keys(campos).length) {
      fail(
        "Dados inválidos",
        campos
      );
    }

    const cod = m.get("cod");

    const [
      eOrigem,
      eDestino
    ] = await Promise.all([
      new Parse.Query("Estoque")
        .equalTo("cod", cod)
        .equalTo("deposito", origem)
        .first(MASTER),

      new Parse.Query("Estoque")
        .equalTo("cod", cod)
        .equalTo("deposito", destino)
        .first(MASTER)
    ]);

    const disponivel = eOrigem
      ? eOrigem.get("qtd")
      : 0;

    if (q > disponivel) {
      fail(
        "Saldo insuficiente na origem",
        {
          quantidade: `Apenas ${disponivel} ${m.get("unidade")} disponíveis em ${origem}`
        }
      );
    }

    eOrigem.increment(
      "qtd",
      -q
    );

    let dest = eDestino;

    if (!dest) {
      dest = new Parse.Object(
        "Estoque"
      );

      dest.set({
        cod,
        deposito: destino,
        qtd: 0
      });
    }

    dest.increment(
      "qtd",
      q
    );

    await Parse.Object.saveAll(
      [eOrigem, dest],
      MASTER
    );

    const curto = (d) =>
      d.replace(
        "Depósito",
        "Dep."
      );

    return salvarMov({
      tipo: "Transferência",
      cod,
      material: m.get("nome"),
      quantidade: q,
      unidade: m.get("unidade"),
      qtd: fmtQtd(
        "Transferência",
        q,
        m.get("unidade")
      ),
      de: origem,
      para: destino,
      local: `${curto(origem)} → ${curto(destino)}`,
      obs,
      responsavel: user.get("nome"),
      ...dataHora()
    });
  }
);

Parse.Cloud.define(
  "listarMovimentacoes",
  async (req) => {
    auth(req);

    const {
      tipo = "Todos",
      inicio,
      fim,
      busca = "",
      page = 1,
      limit = 8
    } = req.params;

    const p = Math.max(
      1,
      parseInt(page, 10) || 1
    );

    const l = Math.min(
      100,
      Math.max(
        1,
        parseInt(limit, 10) || 8
      )
    );

    const montar = (t) => {
      let q;

      if (busca) {
        const rx = escRx(busca);

        q = Parse.Query.or(
          new Parse.Query(
            "Movimentacao"
          ).matches(
            "material",
            rx,
            "i"
          ),

          new Parse.Query(
            "Movimentacao"
          ).matches(
            "cod",
            rx,
            "i"
          ),

          new Parse.Query(
            "Movimentacao"
          ).matches(
            "responsavel",
            rx,
            "i"
          )
        );
      } else {
        q = new Parse.Query(
          "Movimentacao"
        );
      }

      if (t && t !== "Todos") {
        q.equalTo("tipo", t);
      }

      if (inicio) {
        q.greaterThanOrEqualTo(
          "data",
          inicio
        );
      }

      if (fim) {
        q.lessThanOrEqualTo(
          "data",
          fim
        );
      }

      return q;
    };

    const [
      itens,
      total,
      nEntradas,
      nSaidas,
      nTransf
    ] = await Promise.all([
      montar(tipo)
        .descending("data")
        .addDescending("hora")
        .skip((p - 1) * l)
        .limit(l)
        .find(MASTER),

      montar(tipo).count(MASTER),

      montar("Entrada").count(
        MASTER
      ),

      montar("Saída").count(
        MASTER
      ),

      montar("Transferência").count(
        MASTER
      )
    ]);

    return {
      itens: await enriquecerMovs(
        itens
      ),
      total,
      page: p,
      totalPages: Math.max(
        1,
        Math.ceil(total / l)
      ),
      resumo: {
        "Entrada": nEntradas,
        "Saída": nSaidas,
        "Transferência": nTransf
      }
    };
  }
);

Parse.Cloud.define(
  "ultimasMovimentacoes",
  async (req) => {
    auth(req);

    const mapa = {
      entradas: "Entrada",
      saidas: "Saída",
      transferencias:
        "Transferência"
    };

    const tipo =
      mapa[req.params.tipo];

    if (!tipo) {
      fail("Tipo inválido");
    }

    const itens =
      await new Parse.Query(
        "Movimentacao"
      )
        .equalTo("tipo", tipo)
        .descending("createdAt")
        .limit(5)
        .find(MASTER);

    return enriquecerMovs(itens);
  }
);

Parse.Cloud.define(
  "distribuicao",
  async (req) => {
    auth(req);

    const [
      deps,
      materiais,
      estoques
    ] = await Promise.all([
      todos(
        "Deposito",
        "id_"
      ),
      todos("Material"),
      todos("Estoque")
    ]);

    const porCod =
      Object.fromEntries(
        materiais.map((m) => [
          m.get("cod"),
          m
        ])
      );

    const totalPorCod = {};

    estoques.forEach((e) => {
      totalPorCod[e.get("cod")] =
        (totalPorCod[e.get("cod")] || 0) +
        e.get("qtd");
    });

    return deps.map((d) => {
      const itens = estoques
        .filter(
          (e) =>
            e.get("deposito") ===
              d.get("nome") &&
            e.get("qtd") > 0
        )
        .map((e) => {
          const m =
            porCod[e.get("cod")];

          return {
            cod: m.get("cod"),
            nome: m.get("nome"),
            categoria:
              m.get("categoria"),
            tipo:
              m.get("tipo") || "",
            qtd: e.get("qtd"),
            unidade:
              m.get("unidade"),
            minimo:
              m.get("minimo"),
            status: calcStatus(
              totalPorCod[
                e.get("cod")
              ],
              m.get("minimo")
            )
          };
        });

      return {
        id: d.get("id_"),
        nome: d.get("nome"),
        capacidade:
          d.get("capacidade"),
        materiais: itens,
        ocupacao: itens.reduce(
          (s, i) => s + i.qtd,
          0
        )
      };
    });
  }
);

Parse.Cloud.define(
  "salvarLead",
  async (req) => {
    const d = req.params || {};

    if (!d.nome) {
      fail("nome é obrigatório");
    }

    const lead =
      new Parse.Object("Lead");

    lead.set({
      nome: d.nome,
      localizacao:
        d.localizacao || "",
      tipoObra:
        d.tipoObra || "",
      projetoMedidas:
        d.projetoMedidas || "",
      material:
        d.material || "",
      corEstilo:
        d.corEstilo || "",
      telefone:
        d.telefone || "",
      status: "novo"
    });

    await lead.save(
      null,
      MASTER
    );

    return lead.toJSON();
  }
);

Parse.Cloud.define(
  "listarLeads",
  async (req) => {
    auth(req);

    const leads =
      await new Parse.Query("Lead")
        .descending("createdAt")
        .limit(200)
        .find(MASTER);

    return leads.map((l) =>
      l.toJSON()
    );
  }
);

async function executarSeed() {
  if (
    (await new Parse.Query(
      "Material"
    ).count(MASTER)) > 0
  ) {
    return "Já existe dados — nada alterado";
  }

  const deps = [
    ["A", "Depósito A", 500],
    ["B", "Depósito B", 400],
    ["C", "Depósito C", 300],
    ["D", "Depósito D", 600]
  ].map(
    ([id_, nome, capacidade]) =>
      new Parse.Object("Deposito").set({
        id_,
        nome,
        capacidade
      })
  );

  const mats = [
    [
      "MAT-001",
      "Porcelanato Polido 60×60",
      "Revestimento",
      "m²",
      50
    ],
    [
      "MAT-002",
      "Argamassa AC-II",
      "Argamassa",
      "sacos",
      30
    ],
    [
      "MAT-003",
      "Rejunte Cimentício Cinza",
      "Rejunte",
      "kg",
      60
    ],
    [
      "MAT-004",
      "Piso Cimentício 50×50",
      "Revestimento",
      "m²",
      40
    ],
    [
      "MAT-005",
      "Impermeabilizante Flex",
      "Impermeabilizante",
      "latas",
      15
    ],
    [
      "MAT-006",
      "Adesivo Epóxi",
      "Adesivo",
      "kg",
      10
    ],
    [
      "MAT-007",
      "Mármore Carrara 60×120",
      "Pedra Natural",
      "m²",
      20
    ],
    [
      "MAT-008",
      "Granito Preto São Gabriel",
      "Pedra Natural",
      "m²",
      30
    ],
    [
      "MAT-009",
      "Argamassa ACIII Weber",
      "Argamassa",
      "sacos",
      40
    ],
    [
      "MAT-010",
      "Selador Acrílico",
      "Impermeabilizante",
      "latas",
      20
    ],
    [
      "MAT-011",
      "Pastilha de Vidro 5×5",
      "Revestimento",
      "m²",
      15
    ],
    [
      "MAT-012",
      "Silicone Neutro Branco",
      "Adesivo",
      "tubos",
      20
    ]
  ].map(
    ([
      cod,
      nome,
      categoria,
      unidade,
      minimo
    ]) =>
      new Parse.Object(
        "Material"
      ).set({
        cod,
        nome,
        categoria,
        tipo: "",
        unidade,
        minimo
      })
  );

  const ests = [
    [
      "MAT-001",
      "Depósito A",
      200
    ],
    [
      "MAT-001",
      "Depósito B",
      80
    ],
    [
      "MAT-001",
      "Depósito C",
      40
    ],
    [
      "MAT-002",
      "Depósito B",
      18
    ],
    [
      "MAT-003",
      "Depósito A",
      42
    ],
    [
      "MAT-004",
      "Depósito C",
      180
    ],
    [
      "MAT-005",
      "Depósito B",
      8
    ],
    [
      "MAT-006",
      "Depósito A",
      5
    ],
    [
      "MAT-007",
      "Depósito D",
      95
    ],
    [
      "MAT-008",
      "Depósito D",
      210
    ],
    [
      "MAT-009",
      "Depósito B",
      75
    ],
    [
      "MAT-010",
      "Depósito C",
      22
    ],
    [
      "MAT-011",
      "Depósito A",
      60
    ],
    [
      "MAT-012",
      "Depósito B",
      12
    ]
  ].map(
    ([cod, deposito, qtd]) =>
      new Parse.Object(
        "Estoque"
      ).set({
        cod,
        deposito,
        qtd
      })
  );

  await Parse.Object.saveAll(
    [
      ...deps,
      ...mats,
      ...ests
    ],
    MASTER
  );

  return "Seed concluído";
}

Parse.Cloud.job(
  "seed",
  async () => executarSeed()
);

Parse.Cloud.define(
  "seed",
  async () => executarSeed(),
  {
    requireMaster: true
  }
);
