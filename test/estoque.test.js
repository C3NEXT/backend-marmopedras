const ctx = require("./ctx").setup();
const { fake, call, falha, makeUser } = ctx;

let user;
beforeEach(async () => {
  ctx.reset();
  user = await makeUser({ nome: "Ana" });
});

const criar = (p = {}) =>
  call("criarMaterial", { nome: "Branco Prime", categoria: "Granitos", tipo: "Polido", minimo: 10, ...p }, user);
const entrada = (p = {}) =>
  call("registrarEntrada", { codigo: "MAT-001", quantidade: 10, local: "Depósito A", ...p }, user);
const saida = (p = {}) =>
  call("registrarSaida", { codigo: "MAT-001", quantidade: 1, obra: "Obra X", ...p }, user);
const transf = (p = {}) =>
  call("registrarTransferencia", { codigo: "MAT-001", quantidade: 1, origem: "Depósito A", destino: "Depósito B", ...p }, user);
const listar = (p = {}) => call("listarMateriais", p, user);
const material = async (cod = "MAT-001") => (await listar()).find((m) => m.cod === cod);

const materialLegado = () =>
  fake.insertMany("Material", [
    { cod: "MAT-050", nome: "Antigo", categoria: "Granitos", tipo: "", unidade: "m²", minimo: 0 },
  ]);

describe("autenticação obrigatória", () => {
  test.each([
    "me", "listarMateriais", "categorias", "criarMaterial", "registrarEntrada", "registrarSaida",
    "registrarTransferencia", "listarMovimentacoes", "ultimasMovimentacoes", "distribuicao",
    "painel", "listarLeads", "carregarPlanta", "salvarPlanta", "criarDepositoPlanta",
    "excluirDepositoPlanta",
  ])("%s rejeita chamada sem login", async (nome) => {
    const e = await falha(call(nome, {}));
    expect(e.code).toBe(209);
  });

  test("usuário com e-mail não verificado também é barrado", async () => {
    const u = await makeUser({ email: "p@t.com", verificado: false });
    const e = await falha(call("listarMateriais", {}, u));
    expect(e.codigo).toBe("EMAIL_NAO_VERIFICADO");
  });
});

describe("criarMaterial", () => {
  test("gera códigos sequenciais", async () => {
    expect((await criar()).codigo).toBe("MAT-001");
    expect((await criar({ nome: "Outro" })).codigo).toBe("MAT-002");
  });

  test("remove espaços do nome", async () => {
    const r = await criar({ nome: "  Preto São Gabriel  " });
    expect(r.nome).toBe("Preto São Gabriel");
  });

  test("exige nome e categoria", async () => {
    const e = await falha(criar({ nome: "" }));
    expect(e.erro).toBe("nome e categoria são obrigatórios");
  });

  test("categoria inválida", async () => {
    const e = await falha(criar({ categoria: "Madeira" }));
    expect(e.campos.categoria).toBe("Selecione uma categoria válida");
  });

  test("tipo inválido, mas tipo vazio é aceito", async () => {
    const e = await falha(criar({ tipo: "Fosco" }));
    expect(e.campos.tipo).toBe("Tipo inválido");
    await expect(criar({ tipo: "" })).resolves.toMatchObject({ tipo: "" });
  });

  test.each([-1, 1.5, "abc", ""])("mínimo inválido (%p)", async (minimo) => {
    const e = await falha(criar({ minimo }));
    expect(e.erro).toBe("Estoque mínimo inválido");
  });

  test("bloqueia duplicado (nome+categoria+tipo), mas aceita outro tipo", async () => {
    await criar();
    const e = await falha(criar());
    expect(e.campos.nomeNovo).toContain("MAT-001");
    await expect(criar({ tipo: "Escovado" })).resolves.toMatchObject({ codigo: "MAT-002" });
  });

  test("pagina corretamente com mais de 1000 materiais", async () => {
    fake.insertMany(
      "Material",
      Array.from({ length: 1200 }, (_, i) => ({
        cod: `MAT-${String(i + 1).padStart(3, "0")}`,
        nome: `M${i}`,
        categoria: "Granitos",
        tipo: "",
        unidade: "chapas",
        minimo: 0,
      })),
    );
    expect(await listar()).toHaveLength(1200);
    expect((await criar({ nome: "Novo" })).codigo).toBe("MAT-1201");
  });
});

describe("categorias", () => {
  test("fixas + extras existentes em ordem alfabética", async () => {
    fake.insertMany("Material", [
      { cod: "MAT-001", nome: "a", categoria: "Travertinos" },
      { cod: "MAT-002", nome: "b", categoria: "Arenitos" },
      { cod: "MAT-003", nome: "c", categoria: "Granitos" },
    ]);
    expect(await call("categorias", {}, user)).toEqual([
      "Todos", "Granitos", "Mármores", "Quartzitos", "Sintéticos", "Dolomíticos",
      "Arenitos", "Travertinos",
    ]);
  });
});

describe("registrarEntrada", () => {
  beforeEach(() => criar());

  test("soma no depósito e acumula entradas", async () => {
    await entrada({ quantidade: 10, local: "Depósito B" });
    await entrada({ quantidade: 5, local: "Depósito B" });

    const m = await material();
    expect(m.estoque).toBe(15);
    expect(m.estoques).toEqual({ "Depósito B": 15 });
    expect(m.local).toBe("Depósito B");
  });

  test("depósito padrão é o A", async () => {
    await call("registrarEntrada", { codigo: "MAT-001", quantidade: 3 }, user);
    expect((await material()).estoques).toEqual({ "Depósito A": 3 });
  });

  test("registra a movimentação completa", async () => {
    const r = await entrada({ quantidade: 10, data: "2020-01-15" });
    expect(r).toMatchObject({
      tipo: "Entrada",
      cod: "MAT-001",
      codigo: "MAT-001",
      material: "Branco Prime",
      quantidade: 10,
      unidade: "chapas",
      qtd: "+10 chapas",
      local: "Depósito A",
      nota: "—",
      obs: "",
      responsavel: "Ana",
      data: "2020-01-15",
      categoria: "Granitos",
      tipo_material: "Polido",
      materialNovo: false,
    });
  });

  test("data inválida cai para hoje, com hora no formato HH:MM", async () => {
    const r = await entrada({ data: "15/01/2020" });
    expect(r.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.data).not.toBe("15/01/2020");
    expect(r.hora).toMatch(/^\d{2}:\d{2}$/);
  });

  test("aceita quantidade numérica em texto", async () => {
    expect((await entrada({ quantidade: "7" })).qtd).toBe("+7 chapas");
    expect((await entrada({ quantidade: "3,0" })).quantidade).toBe(3);
  });

  test.each([0, -3, 1.5, "1,5", "", undefined, null, "abc"])(
    "quantidade inválida (%p)",
    async (quantidade) => {
      const e = await falha(entrada({ quantidade }));
      expect(e.erro).toBe("Quantidade inválida");
    },
  );

  test("depósito inválido", async () => {
    const e = await falha(entrada({ local: "Depósito Z" }));
    expect(e.campos.local).toBe("Selecione o Depósito A, B ou C");
  });

  test("material inexistente", async () => {
    const e = await falha(entrada({ codigo: "MAT-999" }));
    expect(e.erro).toBe("Material não encontrado");
  });

  test("busca por nome quando não há código", async () => {
    const r = await entrada({ codigo: undefined, material: "Branco Prime" });
    expect(r.codigo).toBe("MAT-001");
  });

  test("novoMaterial cria o cadastro e já dá entrada", async () => {
    const r = await entrada({
      codigo: undefined,
      material: "Preto Absoluto",
      novoMaterial: true,
      categoria: "Granitos",
      tipo: "Escovado",
      quantidade: 4,
    });

    expect(r).toMatchObject({ materialNovo: true, codigo: "MAT-002", material: "Preto Absoluto" });
    expect((await material("MAT-002")).estoque).toBe(4);
  });

  test("novoMaterial duplicado é rejeitado", async () => {
    const e = await falha(
      entrada({ codigo: undefined, material: "Branco Prime", novoMaterial: true, categoria: "Granitos", tipo: "Polido" }),
    );
    expect(e.erro).toBe("Material já cadastrado");
  });

  test("quantidade inválida não cria material novo", async () => {
    await falha(
      entrada({ codigo: undefined, material: "Fantasma", novoMaterial: true, categoria: "Granitos", quantidade: 0 }),
    );
    expect(fake.rows("Material")).toHaveLength(1);
  });
});

describe("unidade diferente de chapas", () => {
  beforeEach(materialLegado);

  test.each([
    ["registrarEntrada", { quantidade: 1 }],
    ["registrarSaida", { quantidade: 1, obra: "Obra" }],
    ["registrarTransferencia", { quantidade: 1, origem: "Depósito A", destino: "Depósito B" }],
  ])("%s bloqueia material legado", async (nome, params) => {
    const e = await falha(call(nome, { codigo: "MAT-050", ...params }, user));
    expect(e.erro).toMatch(/unidade do material/);
  });
});

describe("registrarSaida", () => {
  beforeEach(async () => {
    await criar();
    await entrada({ quantidade: 5, local: "Depósito A" });
    await entrada({ quantidade: 10, local: "Depósito B" });
    await entrada({ quantidade: 3, local: "Depósito C" });
  });

  test("tira do depósito com mais saldo e completa nos seguintes", async () => {
    const r = await saida({ quantidade: 12, obra: "Obra Z" });

    expect(r).toMatchObject({
      tipo: "Saída",
      qtd: "-12 chapas",
      obra: "Obra Z",
      local: "Depósito B / Depósito A → Obra Z",
      responsavel: "Ana",
    });

    const m = await material();
    expect(m.estoque).toBe(6);
    expect(m.estoques).toEqual({ "Depósito A": 3, "Depósito C": 3 });
  });

  test("respeita o depósito informado", async () => {
    await saida({ quantidade: 2, local: "Depósito C" });
    expect((await material()).estoques["Depósito C"]).toBe(1);

    const e = await falha(saida({ quantidade: 4, local: "Depósito C" }));
    expect(e.campos.quantidade).toContain("disponível: 1 chapas");
  });

  test("estoque insuficiente não altera nada", async () => {
    const e = await falha(saida({ quantidade: 19 }));
    expect(e.campos.quantidade).toBe("Estoque insuficiente (disponível: 18 chapas)");
    expect((await material()).estoque).toBe(18);
  });

  test("pode zerar o estoque", async () => {
    await saida({ quantidade: 18 });
    const m = await material();
    expect(m.estoque).toBe(0);
    expect(m.local).toBeNull();
  });

  test("exige obra", async () => {
    const e = await falha(saida({ obra: "   " }));
    expect(e.campos.obra).toBe("Informe a obra de destino");
  });

  test("depósito inválido", async () => {
    const e = await falha(saida({ local: "Depósito Z" }));
    expect(e.campos.local).toBe("Selecione um depósito válido");
  });

  test("responsável pode ser informado", async () => {
    expect((await saida({ responsavel: "João" })).responsavel).toBe("João");
  });

  test.each([0, -1, 1.2, ""])("quantidade inválida (%p)", async (quantidade) => {
    const e = await falha(saida({ quantidade }));
    expect(e.erro).toBe("Quantidade inválida");
  });
});

describe("registrarTransferencia", () => {
  beforeEach(async () => {
    await criar();
    await entrada({ quantidade: 10, local: "Depósito A" });
  });

  test("move o saldo sem alterar o total", async () => {
    const r = await transf({ quantidade: 4 });

    expect(r).toMatchObject({
      tipo: "Transferência",
      qtd: "4 chapas",
      de: "Depósito A",
      para: "Depósito B",
      local: "Dep. A → Dep. B",
    });

    const m = await material();
    expect(m.estoques).toEqual({ "Depósito A": 6, "Depósito B": 4 });
    expect(m.estoque).toBe(10);
  });

  test("soma em destino que já tem saldo", async () => {
    await transf({ quantidade: 2 });
    await transf({ quantidade: 3 });
    expect((await material()).estoques).toEqual({ "Depósito A": 5, "Depósito B": 5 });
  });

  test("transferir tudo remove a origem da distribuição", async () => {
    await transf({ quantidade: 10 });
    expect((await material()).estoques).toEqual({ "Depósito B": 10 });
  });

  test("saldo insuficiente na origem", async () => {
    const e = await falha(transf({ quantidade: 11 }));
    expect(e.campos.quantidade).toBe("Apenas 10 chapas disponíveis em Depósito A");
  });

  test("origem sem nenhum registro de estoque", async () => {
    const e = await falha(transf({ origem: "Depósito C", destino: "Depósito B" }));
    expect(e.campos.quantidade).toBe("Apenas 0 chapas disponíveis em Depósito C");
  });

  test("origem e destino inválidos ou iguais", async () => {
    expect((await falha(transf({ origem: "X" }))).campos.origem).toBe("Selecione a origem");
    expect((await falha(transf({ destino: "X" }))).campos.destino).toBe("Selecione o destino");
    expect((await falha(transf({ destino: "Depósito A" }))).campos.destino).toBe(
      "Origem e destino devem ser diferentes",
    );
  });
});

describe("listarMateriais", () => {
  test.each([
    [0, "crítico"],
    [5, "crítico"],
    [6, "baixo"],
    [9, "baixo"],
    [10, "ok"],
    [11, "ok"],
  ])("estoque %i com mínimo 10 => %s", async (qtd, status) => {
    await criar();
    fake.insertMany("Estoque", [{ cod: "MAT-001", deposito: "Depósito A", qtd }]);
    expect((await material()).status).toBe(status);
  });

  test("mínimo 0 nunca fica em alerta", async () => {
    await criar({ minimo: 0 });
    expect((await material()).status).toBe("ok");
  });

  describe("filtros", () => {
    beforeEach(async () => {
      await criar(); // MAT-001
      await criar({ nome: "Carrara", categoria: "Mármores", tipo: "" }); // MAT-002
      await criar({ nome: "Preto", categoria: "Granitos", tipo: "Escovado" }); // MAT-003
      await entrada({ codigo: "MAT-001", quantidade: 10 }); // ok
      await entrada({ codigo: "MAT-002", quantidade: 8 }); // baixo
      await entrada({ codigo: "MAT-003", quantidade: 3 }); // crítico
    });

    const cods = async (p) => (await listar(p)).map((m) => m.cod);

    test("sem filtro, ordenado por código", async () => {
      expect(await cods({})).toEqual(["MAT-001", "MAT-002", "MAT-003"]);
    });

    test("busca por nome (sem diferenciar maiúsculas) ou código", async () => {
      expect(await cods({ q: "CARR" })).toEqual(["MAT-002"]);
      expect(await cods({ q: "mat-003" })).toEqual(["MAT-003"]);
    });

    test("filtro por categoria", async () => {
      expect(await cods({ categoria: "Granitos" })).toEqual(["MAT-001", "MAT-003"]);
      expect(await cods({ categoria: "Todos" })).toHaveLength(3);
    });

    test("filtro por status", async () => {
      expect(await cods({ status: "Crítico" })).toEqual(["MAT-003"]);
      expect(await cods({ status: "baixo" })).toEqual(["MAT-002"]);
      expect(await cods({ status: "ok" })).toEqual(["MAT-001"]);
    });

    test("local é o depósito com mais saldo e estoques traz o detalhe", async () => {
      await entrada({ codigo: "MAT-001", quantidade: 25, local: "Depósito C" });
      const m = await material();
      expect(m.local).toBe("Depósito C");
      expect(m.estoques).toEqual({ "Depósito A": 10, "Depósito C": 25 });
      expect(m.estoque).toBe(35);
    });
  });
});

describe("listarMovimentacoes", () => {
  beforeEach(async () => {
    await criar(); // MAT-001 Granitos
    await criar({ nome: "Carrara", categoria: "Mármores", tipo: "", minimo: 0 }); // MAT-002
    await entrada({ codigo: "MAT-001", quantidade: 10, data: "2020-01-10" });
    await entrada({ codigo: "MAT-002", quantidade: 5, data: "2020-01-11" });
    await saida({ quantidade: 2, obra: "Casa", data: "2020-01-12", responsavel: "Carlos" });
    await transf({ quantidade: 1 }); // hoje
  });

  const listarMov = (p = {}) => call("listarMovimentacoes", p, user);

  test("ordena da data mais recente para a mais antiga e traz o resumo", async () => {
    const r = await listarMov();
    expect(r.total).toBe(4);
    expect(r.itens.map((i) => i.tipo)).toEqual(["Transferência", "Saída", "Entrada", "Entrada"]);
    expect(r.resumo).toEqual({ Entrada: 2, Saída: 1, Transferência: 1 });
  });

  test("filtra por tipo sem mexer no resumo", async () => {
    const r = await listarMov({ tipo: "Saída" });
    expect(r.total).toBe(1);
    expect(r.itens[0]).toMatchObject({ responsavel: "Carlos", codigo: "MAT-001", categoria: "Granitos" });
    expect(r.resumo.Entrada).toBe(2);
  });

  test("filtra por intervalo de datas", async () => {
    const r = await listarMov({ inicio: "2020-01-11", fim: "2020-01-12" });
    expect(r.total).toBe(2);
    expect(r.itens.map((i) => i.data)).toEqual(["2020-01-12", "2020-01-11"]);
  });

  test("busca em material, código e responsável", async () => {
    expect((await listarMov({ busca: "carrara" })).total).toBe(1);
    expect((await listarMov({ busca: "MAT-001" })).total).toBe(3);
    expect((await listarMov({ busca: "carlos" })).total).toBe(1);
  });

  test("caracteres especiais de regex na busca não quebram", async () => {
    const r = await listarMov({ busca: "(.*[" });
    expect(r.total).toBe(0);
  });

  test("busca combina com filtro de tipo e datas", async () => {
    const r = await listarMov({ busca: "MAT-001", tipo: "Entrada", inicio: "2020-01-01", fim: "2020-01-31" });
    expect(r.total).toBe(1);
  });

  test("paginação", async () => {
    const p1 = await listarMov({ limit: 2, page: 1 });
    const p2 = await listarMov({ limit: 2, page: 2 });

    expect(p1).toMatchObject({ page: 1, totalPages: 2 });
    expect(p1.itens).toHaveLength(2);
    expect(p2.itens).toHaveLength(2);
    expect(p2.itens[1].data).toBe("2020-01-10");
  });

  test("valores inválidos de page/limit usam os padrões", async () => {
    expect((await listarMov({ page: "x" })).page).toBe(1);
    expect((await listarMov({ page: -4 })).page).toBe(1);
    expect((await listarMov({ limit: 0 })).itens).toHaveLength(4);
    expect((await listarMov({ limit: 1000 })).totalPages).toBe(1);
  });
});

describe("ultimasMovimentacoes", () => {
  beforeEach(async () => {
    await criar();
  });

  test("tipo inválido", async () => {
    const e = await falha(call("ultimasMovimentacoes", { tipo: "outros" }, user));
    expect(e.erro).toBe("Tipo inválido");
  });

  test("devolve as 5 mais recentes, da mais nova para a mais antiga", async () => {
    for (let i = 1; i <= 7; i++) await entrada({ quantidade: i });
    const r = await call("ultimasMovimentacoes", { tipo: "entradas" }, user);

    expect(r).toHaveLength(5);
    expect(r.map((m) => m.qtd)).toEqual(["+7 chapas", "+6 chapas", "+5 chapas", "+4 chapas", "+3 chapas"]);
    expect(r[0]).toMatchObject({ codigo: "MAT-001", categoria: "Granitos" });
  });

  test("mapeia saidas e transferencias", async () => {
    await entrada({ quantidade: 10 });
    await saida();
    await transf();

    const s = await call("ultimasMovimentacoes", { tipo: "saidas" }, user);
    const t = await call("ultimasMovimentacoes", { tipo: "transferencias" }, user);
    expect(s.map((m) => m.tipo)).toEqual(["Saída"]);
    expect(t.map((m) => m.tipo)).toEqual(["Transferência"]);
  });
});

describe("painel", () => {
  test("cards, últimas movimentações e críticos", async () => {
    // estoques: 3 (crítico), 8 (baixo), 20 (ok), 1, 2, 4 (críticos)
    const estoques = [3, 8, 20, 1, 2, 4];
    for (let i = 0; i < estoques.length; i++) {
      await criar({ nome: `Material ${i + 1}` });
      await entrada({ codigo: `MAT-00${i + 1}`, quantidade: estoques[i] });
    }

    await saida({ codigo: "MAT-003", obra: "A" });
    await saida({ codigo: "MAT-003", obra: "B" });
    await saida({ codigo: "MAT-003", obra: "A" });
    await saida({ codigo: "MAT-003", obra: "Antiga", data: "2020-01-01" }); // não conta como hoje

    const r = await call("painel", {}, user);

    expect(r.cards).toEqual({
      totalSkus: 6,
      entradasHoje: 6,
      saidasHoje: 3,
      obrasHoje: 2,
      saldoBaixo: 5,
    });
    expect(r.ultimasMovimentacoes).toHaveLength(5);
    expect(r.ultimasMovimentacoes[0]).toMatchObject({ tipo: "Saída", codigo: "MAT-003" });
    expect(r.criticos).toHaveLength(3);
    expect(r.criticos[0]).toEqual({ cod: "MAT-001", nome: "Material 1" });
  });

  test("banco vazio", async () => {
    const r = await call("painel", {}, user);
    expect(r.cards).toEqual({ totalSkus: 0, entradasHoje: 0, saidasHoje: 0, obrasHoje: 0, saldoBaixo: 0 });
    expect(r.criticos).toEqual([]);
  });
});

describe("distribuicao", () => {
  test("sem cadastro de depósitos usa ids padrão e capacidade 0", async () => {
    const r = await call("distribuicao", {}, user);
    expect(r.map((d) => [d.id, d.nome, d.capacidade, d.ocupacao])).toEqual([
      ["A", "Depósito A", 0, 0],
      ["B", "Depósito B", 0, 0],
      ["C", "Depósito C", 0, 0],
    ]);
  });

  test("ocupação por depósito e status calculado sobre o total", async () => {
    fake.insertMany("Deposito", [
      { id_: "A", nome: "Depósito A", capacidade: 100 },
      { id_: "B", nome: "Depósito B", capacidade: 50 },
    ]);
    await criar({ minimo: 20 });
    await entrada({ quantidade: 5, local: "Depósito A" });
    await entrada({ quantidade: 5, local: "Depósito B" });
    fake.insertMany("Estoque", [{ cod: "MAT-FANTASMA", deposito: "Depósito A", qtd: 99 }]);

    const r = await call("distribuicao", {}, user);
    const a = r[0];

    expect(a).toMatchObject({ id: "A", capacidade: 100, ocupacao: 5 });
    expect(a.materiais).toHaveLength(1); // ignora estoque sem material
    expect(a.materiais[0]).toMatchObject({
      cod: "MAT-001",
      tipo: "Polido",
      unidade: "chapas",
      qtd: 5,
      status: "crítico", // total 10 < 60% de 20
    });
    expect(r[1]).toMatchObject({ capacidade: 50, ocupacao: 5 });
    expect(r[2]).toMatchObject({ id: "C", capacidade: 0, ocupacao: 0 });
  });
});

describe("leads", () => {
  test("salvarLead é público e preenche padrões", async () => {
    const r = await call("salvarLead", { nome: "Cliente", telefone: "8199" });
    expect(r).toMatchObject({
      nome: "Cliente",
      telefone: "8199",
      status: "novo",
      localizacao: "",
      material: "",
    });
  });

  test("nome é obrigatório", async () => {
    const e = await falha(call("salvarLead", {}));
    expect(e.erro).toBe("nome é obrigatório");
  });

  test("listarLeads devolve os mais recentes primeiro", async () => {
    await call("salvarLead", { nome: "Primeiro" });
    await call("salvarLead", { nome: "Segundo" });
    const r = await call("listarLeads", {}, user);
    expect(r.map((l) => l.nome)).toEqual(["Segundo", "Primeiro"]);
  });
});
