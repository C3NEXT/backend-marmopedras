const ctx = require("./ctx").setup();
const { fake, call, makeUser } = ctx;

const DEPS = ["Depósito A", "Depósito B", "Depósito C"];
const CATS = ["Granitos", "Mármores", "Quartzitos", "Sintéticos", "Dolomíticos"];

const stats = { queries: 0, rows: 0, gets: 0, porClasse: {} };
const zerar = () => {
  stats.queries = 0;
  stats.rows = 0;
  stats.gets = 0;
  stats.porClasse = {};
};

const Q = fake.Parse.Query.prototype;
for (const metodo of ["find", "first", "count"]) {
  const original = Q[metodo];
  Q[metodo] = async function (...args) {
    const r = await original.apply(this, args);
    const n = metodo === "find" ? r.length : metodo === "first" ? (r ? 1 : 0) : 0;
    stats.queries++;
    stats.rows += n;
    stats.porClasse[this.className] = (stats.porClasse[this.className] || 0) + n;
    return r;
  };
}

const O = fake.Parse.Object.prototype;
const getOriginal = O.get;
O.get = function (k) {
  stats.gets++;
  return getOriginal.call(this, k);
};

const relatorio = [];
const medir = async (nome, fn) => {
  zerar();
  const t0 = process.hrtime.bigint();
  const resultado = await fn();
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const m = {
    queries: stats.queries,
    linhas: stats.rows,
    gets: stats.gets,
    porClasse: { ...stats.porClasse },
  };
  relatorio.push({ chamada: nome, queries: m.queries, linhas: m.linhas, gets: m.gets, ms });
  return { resultado, ...m };
};

afterAll(() => console.table(relatorio));

const cod = (i) => `MAT-${String(i + 1).padStart(3, "0")}`;

function semear(materiais, movs = 0) {
  fake.insertMany(
    "Material",
    Array.from({ length: materiais }, (_, i) => ({
      cod: cod(i),
      num: i + 1, 
      nome: `Material ${i + 1}`,
      categoria: CATS[i % 5],
      tipo: "",
      unidade: "chapas",
      minimo: 10,
    })),
  );

  fake.insertMany(
    "Estoque",
    Array.from({ length: materiais * 3 }, (_, i) => ({
      cod: cod(Math.floor(i / 3)),
      deposito: DEPS[i % 3],
      qtd: (Math.floor(i / 3) % 15) + 1,
    })),
  );

  fake.insertMany(
    "Movimentacao",
    Array.from({ length: movs }, (_, i) => ({
      tipo: i % 2 ? "Saída" : "Entrada",
      cod: cod(i % materiais),
      material: `Material ${(i % materiais) + 1}`,
      quantidade: 1,
      unidade: "chapas",
      qtd: i % 2 ? "-1 chapas" : "+1 chapas",
      local: "Depósito A",
      nota: "—",
      obs: "",
      responsavel: "Seed",
      data: `2020-01-${String(1 + (i % 28)).padStart(2, "0")}`,
      hora: "10:00",
    })),
  );
}

const M = 1500;
const E = M * 3;

describe(`orçamento de consultas (${M} materiais, ${E} saldos, 1000 movimentações)`, () => {
  let user;

  beforeAll(async () => {
    ctx.reset();
    user = await makeUser();
    semear(M, 1000);
  });

  test("listarMateriais: lê cada registro uma vez, em lotes de 1000", async () => {
    const r = await medir("listarMateriais", () => call("listarMateriais", {}, user));

    expect(r.resultado).toHaveLength(M);
    expect(r.queries).toBeLessThanOrEqual(Math.ceil(M / 1000) + Math.ceil(E / 1000));
    expect(r.linhas).toBeLessThanOrEqual(M + E);
  });

  test("distribuicao: lê depósitos, materiais e saldos uma vez cada", async () => {
    const r = await medir("distribuicao", () => call("distribuicao", {}, user));

    expect(r.resultado).toHaveLength(3);
    expect(r.queries).toBeLessThanOrEqual(1 + Math.ceil(M / 1000) + Math.ceil(E / 1000));
    expect(r.linhas).toBeLessThanOrEqual(M + E);
  });

  test("registrarEntrada: no máximo 2 consultas (material + saldo)", async () => {
    const r = await medir("registrarEntrada", () =>
      call("registrarEntrada", { codigo: "MAT-010", quantidade: 1 }, user),
    );
    expect(r.queries).toBeLessThanOrEqual(2);
    expect(r.linhas).toBeLessThanOrEqual(2);
  });

  test("registrarSaida: no máximo 2 consultas, sem varrer o catálogo", async () => {
    const r = await medir("registrarSaida", () =>
      call("registrarSaida", { codigo: "MAT-010", quantidade: 1, obra: "Obra" }, user),
    );
    expect(r.queries).toBeLessThanOrEqual(2);
    expect(r.linhas).toBeLessThanOrEqual(1 + DEPS.length);
  });

  test("registrarTransferencia: no máximo 3 consultas", async () => {
    const r = await medir("registrarTransferencia", () =>
      call(
        "registrarTransferencia",
        { codigo: "MAT-010", quantidade: 1, origem: "Depósito A", destino: "Depósito B" },
        user,
      ),
    );
    expect(r.queries).toBeLessThanOrEqual(3);
    expect(r.linhas).toBeLessThanOrEqual(3);
  });

  test("listarMovimentacoes: enriquece só os materiais da página", async () => {
    const r = await medir("listarMovimentacoes", () =>
      call("listarMovimentacoes", { limit: 8 }, user),
    );

    expect(r.resultado.itens).toHaveLength(8);
    expect(r.linhas).toBeLessThanOrEqual(50);
    expect(r.queries).toBeLessThanOrEqual(6); 
  });

  test("painel: carrega o catálogo de materiais uma única vez", async () => {
    const r = await medir("painel", () => call("painel", {}, user));

    expect(r.resultado.cards.totalSkus).toBe(M);

    expect(r.porClasse.Material).toBeLessThanOrEqual(M + 10);
  });

 
  test("criarMaterial: gera o próximo código sem varrer todos os materiais", async () => {
    const r = await medir("criarMaterial", () =>
      call("criarMaterial", { nome: "Novo Material", categoria: "Granitos", tipo: "Polido", minimo: 5 }, user),
    );

    expect(r.resultado.codigo).toBe(`MAT-${M + 1}`);
    expect(r.linhas).toBeLessThanOrEqual(50);
  });
});

describe("crescimento do custo", () => {
  const trabalho = async (n) => {
    ctx.reset();
    const user = await makeUser();
    semear(n);
    const r = await medir(`listarMateriais (n=${n})`, () => call("listarMateriais", {}, user));
    return r.gets;
  };

  test("listarMateriais: dobrar os dados não pode quadruplicar o trabalho", async () => {
    const pequeno = await trabalho(100);
    const grande = await trabalho(200);

    expect(grande / pequeno).toBeLessThan(2.6);
  });
});
