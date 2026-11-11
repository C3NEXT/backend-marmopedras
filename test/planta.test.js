const ctx = require("./ctx").setup();
const { fake, call, falha, makeUser } = ctx;

let user;
beforeEach(async () => {
  ctx.reset();
  user = await makeUser();
});

const carregar = () => call("carregarPlanta", {}, user);
const salvar = (p) => call("salvarPlanta", p, user);
const criarDep = (nome) => call("criarDepositoPlanta", { nome }, user);
const excluirDep = (nome) => call("excluirDepositoPlanta", { nome }, user);

describe("carregarPlanta", () => {
  test("semeia A, B e C na primeira chamada", async () => {
    const r = await carregar();

    expect(r.depositos).toEqual(["A", "B", "C"]);
    expect(r.plantas.A).toEqual([]);
    expect(r.tamanhos.A).toEqual({ largura: 650, altura: 490 });
  });

  test("não semeia de novo se já existem depósitos", async () => {
    await carregar();
    await carregar();
    expect(fake.rows("PlantaDeposito")).toHaveLength(3);
  });
});

describe("salvarPlanta", () => {
  test.each([[[]], [undefined], ["A"]])("rejeita lista de depósitos inválida (%p)", async (depositos) => {
    const e = await falha(salvar({ depositos }));
    expect(e.campos.depositos).toBe("Você precisa ter pelo menos um depósito");
  });

  test("limite de 50 depósitos", async () => {
    const depositos = Array.from({ length: 51 }, (_, i) => `D${i}`);
    const e = await falha(salvar({ depositos }));
    expect(e.campos.depositos).toBe("Máximo de 50 depósitos");
  });

  test.each([[["  "]], [[null]]])("nome vazio (%p)", async (depositos) => {
    const e = await falha(salvar({ depositos }));
    expect(e.campos.depositos).toBe("Digite um nome para o depósito");
  });

  test("nome com mais de 40 caracteres", async () => {
    const e = await falha(salvar({ depositos: ["x".repeat(41)] }));
    expect(e.campos.depositos).toMatch(/passa de 40 caracteres/);
  });

  test("nomes duplicados, ignorando maiúsculas", async () => {
    const e = await falha(salvar({ depositos: ["Norte", "norte"] }));
    expect(e.campos.depositos).toMatch(/Já existe um depósito/);
  });

  test("falha de validação não persiste nada", async () => {
    await falha(salvar({ depositos: ["A", "A"] }));
    expect(fake.rows("PlantaDeposito")).toHaveLength(0);
  });

  test("persiste ordem, tamanhos e cavaletes", async () => {
    const r = await salvar({
      depositos: ["Sul", "Norte"],
      plantas: { Sul: [{ id: 1, x: 10, y: 20, orientacao: "vertical" }] },
      tamanhos: { Norte: { largura: 1000, altura: 800 } },
    });

    expect(r).toMatchObject({ ok: true, depositos: 2, cavaletes: 1 });
    expect(new Date(r.salvoEm).toISOString()).toBe(r.salvoEm);

    const c = await carregar();
    expect(c.depositos).toEqual(["Sul", "Norte"]);
    expect(c.plantas.Sul[0]).toEqual({
      id: 1,
      nomeCustomizado: "",
      x: 10,
      y: 20,
      orientacao: "vertical",
      anotacoes: "",
    });
    expect(c.plantas.Norte).toEqual([]);
    expect(c.tamanhos.Norte).toEqual({ largura: 1000, altura: 800 });
    expect(c.tamanhos.Sul).toEqual({ largura: 650, altura: 490 });
  });

  test("remove depósitos que saíram da lista e reordena", async () => {
    await carregar();
    await salvar({ depositos: ["C", "A"] });

    expect((await carregar()).depositos).toEqual(["C", "A"]);
    expect(fake.rows("PlantaDeposito")).toHaveLength(2);
  });

  test("atualiza depósito existente em vez de duplicar", async () => {
    await salvar({ depositos: ["A"], plantas: { A: [{ id: 1 }] } });
    await salvar({ depositos: ["A"], plantas: { A: [{ id: 1 }, { id: 2 }] } });

    expect(fake.rows("PlantaDeposito")).toHaveLength(1);
    expect((await carregar()).plantas.A).toHaveLength(2);
  });

  test("limita os tamanhos aos valores mínimo e máximo", async () => {
    await salvar({
      depositos: ["T1", "T2", "T3", "T4"],
      tamanhos: {
        T1: { largura: 100, altura: 99999 },
        T2: { largura: "abc", altura: null },
        T3: { largura: 99999, altura: 1 },
        T4: { largura: 1000.6, altura: 500.4 },
      },
    });

    const { tamanhos } = await carregar();
    expect(tamanhos.T1).toEqual({ largura: 650, altura: 1800 });
    expect(tamanhos.T2).toEqual({ largura: 650, altura: 490 });
    expect(tamanhos.T3).toEqual({ largura: 4000, altura: 490 });
    expect(tamanhos.T4).toEqual({ largura: 1001, altura: 500 });
  });

  test("sanitiza os cavaletes", async () => {
    const r = await salvar({
      depositos: ["A"],
      plantas: {
        A: [
          {
            id: 1,
            nomeCustomizado: `  ${"x".repeat(30)}  `,
            x: 10.456,
            y: -5,
            orientacao: "diagonal",
            anotacoes: "a".repeat(2500),
          },
          { id: 1, x: 99 }, // id repetido
          { id: 0 },
          { id: -2 },
          { id: "abc" },
          { id: 1.5 },
          null,
          { id: 2, x: "abc", y: 3, orientacao: "vertical" },
        ],
      },
    });

    expect(r.cavaletes).toBe(2);

    const [c1, c2] = (await carregar()).plantas.A;
    expect(c1).toMatchObject({
      id: 1,
      nomeCustomizado: "x".repeat(20),
      x: 10.46,
      y: 0,
      orientacao: "horizontal",
    });
    expect(c1.anotacoes).toHaveLength(2000);
    expect(c2).toEqual({
      id: 2,
      nomeCustomizado: "",
      x: 0,
      y: 3,
      orientacao: "vertical",
      anotacoes: "",
    });
  });

  test("plantas que não são lista viram lista vazia", async () => {
    await salvar({ depositos: ["A"], plantas: { A: "lixo" } });
    expect((await carregar()).plantas.A).toEqual([]);
  });

  test("máximo de 500 cavaletes por depósito", async () => {
    const cavaletes = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
    const e = await falha(salvar({ depositos: ["A"], plantas: { A: cavaletes } }));

    expect(e.campos.cavaletes).toBe("Máximo de 500 cavaletes por depósito");
    expect(fake.rows("PlantaDeposito")).toHaveLength(0);
  });
});

describe("criarDepositoPlanta", () => {
  test("nome vazio", async () => {
    const e = await falha(criarDep("   "));
    expect(e.campos.nome).toBe("Digite um nome para o depósito.");
  });

  test("nome com mais de 40 caracteres", async () => {
    const e = await falha(criarDep("x".repeat(41)));
    expect(e.campos.nome).toBe("Máximo de 40 caracteres");
  });

  test("nome duplicado, ignorando maiúsculas", async () => {
    await carregar();
    const e = await falha(criarDep("a"));
    expect(e.campos.nome).toBe("Já existe um depósito com esse nome.");
  });

  test("cria com ordem seguinte e tamanho mínimo, sem espaços nas pontas", async () => {
    await carregar();
    const r = await criarDep("  Fundos ");

    expect(r).toEqual({
      nome: "Fundos",
      ordem: 3,
      tamanho: { largura: 650, altura: 490 },
      cavaletes: [],
    });
    expect((await carregar()).depositos).toEqual(["A", "B", "C", "Fundos"]);
  });

  test("limite de 50 depósitos", async () => {
    fake.insertMany(
      "PlantaDeposito",
      Array.from({ length: 50 }, (_, i) => ({ nome: `D${i}`, ordem: i, largura: 650, altura: 490, cavaletes: [] })),
    );
    const e = await falha(criarDep("Extra"));
    expect(e.erro).toBe("Limite de depósitos atingido");
  });
});

describe("excluirDepositoPlanta", () => {
  test("não permite excluir o último depósito", async () => {
    await salvar({ depositos: ["Único"] });
    const e = await falha(excluirDep("Único"));
    expect(e.campos.nome).toBe("Você precisa ter pelo menos um depósito.");
    expect(fake.rows("PlantaDeposito")).toHaveLength(1);
  });

  test("depósito inexistente", async () => {
    await carregar();
    const e = await falha(excluirDep("Z"));
    expect(e.erro).toBe("Depósito não encontrado");
  });

  test("exclui e devolve os restantes", async () => {
    await carregar();
    const r = await excluirDep("B");

    expect(r).toEqual({ ok: true, depositos: ["A", "C"] });
    expect((await carregar()).depositos).toEqual(["A", "C"]);
  });
});
