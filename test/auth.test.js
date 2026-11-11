const ctx = require("./ctx").setup();
const { fake, call, falha, emails, ultimoCodigo, makeUser } = ctx;

beforeEach(() => {
  ctx.reset();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const dados = {
  nome: "Maria Silva",
  email: "Maria@Teste.com ",
  telefone: "8199",
  cargo: "Vendedor",
  senha: "segredo1",
};
const EMAIL = "maria@teste.com";

const cadastrar = async () => {
  await call("register", dados);
  return ultimoCodigo();
};
const diferente = (codigo) => (codigo === "000000" ? "111111" : "000000");
const envelhecerTokens = () =>
  fake.rows("EmailToken").forEach((r) => {
    r.createdAt = new Date(Date.now() - 120000);
  });

describe("me / auth", () => {
  test("rejeita sem usuário (209)", async () => {
    const e = await falha(call("me"));
    expect(e.code).toBe(209);
    expect(e.erro).toBe("Não autenticado");
  });

  test("bloqueia usuário com e-mail não verificado", async () => {
    const u = await makeUser({ verificado: false });
    const e = await falha(call("me", {}, u));
    expect(e.code).toBe(141);
    expect(e.codigo).toBe("EMAIL_NAO_VERIFICADO");
  });

  test("devolve só os dados públicos", async () => {
    const u = await makeUser({ nome: "Ana" });
    const r = await call("me", {}, u);
    expect(r).toEqual({
      id: u.id,
      nome: "Ana",
      email: "user@teste.com",
      telefone: "81999990000",
      cargo: "Gerente",
    });
  });
});

describe("register", () => {
  test("valida os campos", async () => {
    const e = await falha(call("register", {}));
    expect(e.erro).toBe("Dados inválidos");
    expect(Object.keys(e.campos).sort()).toEqual(["email", "nome", "senha"]);
  });

  test("senha curta é rejeitada", async () => {
    const e = await falha(call("register", { ...dados, senha: "123" }));
    expect(e.campos.senha).toBe("Mínimo 6 caracteres");
  });

  test("cria usuário não verificado e envia o código por e-mail", async () => {
    const r = await call("register", dados);

    expect(r).toEqual({ precisaVerificar: true, email: EMAIL, emailEnviado: true });

    const [u] = fake.rows("_User");
    expect(u.data).toMatchObject({
      username: EMAIL,
      email: EMAIL,
      nome: "Maria Silva",
      cargo: "Vendedor",
      emailVerificado: false,
    });

    const [mail] = emails();
    expect(mail.body.to).toEqual([{ email: EMAIL }]);
    expect(mail.body.subject).toMatch(/Confirme seu e-mail/);
    expect(ultimoCodigo()).toMatch(/^\d{6}$/);
  });

  test("cargo padrão é Funcionário", async () => {
    await call("register", { ...dados, cargo: undefined });
    expect(fake.rows("_User")[0].data.cargo).toBe("Funcionário");
  });

  test("não guarda o código em texto puro", async () => {
    const codigo = await cadastrar();
    const [t] = fake.rows("EmailToken");
    expect(t.data.codigo).toBeUndefined();
    expect(t.data).toMatchObject({ tipo: "verificacao", usado: false, tentativas: 0 });
    expect(t.data.expiraEm.getTime()).toBeGreaterThan(Date.now());
    expect(codigo).toMatch(/^\d{6}$/);
  });

  test("e-mail já verificado é rejeitado", async () => {
    await makeUser({ email: EMAIL });
    const e = await falha(call("register", dados));
    expect(e.campos.email).toBe("E-mail já cadastrado");
  });

  test("cadastro pendente é atualizado e respeita o intervalo de reenvio", async () => {
    await call("register", dados);
    const r = await call("register", { ...dados, nome: "Maria Souza" });

    expect(r).toMatchObject({ precisaVerificar: true, reenviado: true, emailEnviado: true });
    expect(fake.rows("_User")).toHaveLength(1);
    expect(fake.rows("_User")[0].data.nome).toBe("Maria Souza");
    expect(emails()).toHaveLength(1); // dentro de 60s não manda outro
  });

  test("falha no provedor de e-mail não impede o cadastro", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => "x" }));
    const r = await call("register", dados);
    expect(r.emailEnviado).toBe(false);
    expect(fake.rows("_User")).toHaveLength(1);
  });

  test("sem EMAIL_API_KEY o e-mail não é enviado, mas o cadastro existe", async () => {
    delete process.env.EMAIL_API_KEY;
    const r = await call("register", dados);
    expect(r.emailEnviado).toBe(false);
    expect(fake.rows("_User")).toHaveLength(1);
  });
});

describe("verificarEmail", () => {
  test("código correto verifica o usuário e permite login", async () => {
    const codigo = await cadastrar();
    const r = await call("verificarEmail", { email: EMAIL, codigo });

    expect(r).toEqual({ verificado: true });
    expect(fake.rows("_User")[0].data.emailVerificado).toBe(true);
    expect(fake.rows("EmailToken")[0].data.usado).toBe(true);

    const login = await call("login", { email: EMAIL, senha: "segredo1" });
    expect(login.usuario.email).toBe(EMAIL);
  });

  test("código errado falha, conta a tentativa e não verifica", async () => {
    const codigo = await cadastrar();
    const e = await falha(call("verificarEmail", { email: EMAIL, codigo: diferente(codigo) }));

    expect(e.campos.codigo).toBe("Código inválido ou expirado");
    expect(fake.rows("EmailToken")[0].data.tentativas).toBe(1);
    expect(fake.rows("_User")[0].data.emailVerificado).toBe(false);
  });

  test("após 5 tentativas erradas nem o código certo funciona", async () => {
    const codigo = await cadastrar();
    for (let i = 0; i < 5; i++) {
      await falha(call("verificarEmail", { email: EMAIL, codigo: diferente(codigo) }));
    }
    await falha(call("verificarEmail", { email: EMAIL, codigo }));
    expect(fake.rows("_User")[0].data.emailVerificado).toBe(false);
  });

  test("código expirado é rejeitado", async () => {
    const codigo = await cadastrar();
    fake.rows("EmailToken")[0].data.expiraEm = new Date(Date.now() - 1000);
    await falha(call("verificarEmail", { email: EMAIL, codigo }));
  });

  test.each(["12ab", "12345", "1234567", "", undefined])(
    "formato inválido (%p) é rejeitado",
    async (codigo) => {
      await cadastrar();
      await falha(call("verificarEmail", { email: EMAIL, codigo }));
    },
  );

  test("e-mail inexistente dá a mesma mensagem genérica", async () => {
    const e = await falha(call("verificarEmail", { email: "x@x.com", codigo: "123456" }));
    expect(e.campos.codigo).toBe("Código inválido ou expirado");
  });

  test("aceita os nomes alternativos de função e de parâmetro", async () => {
    expect(fake.functions["verify-email"]).toBe(fake.functions.verificarEmail);
    const codigo = await cadastrar();
    const r = await call("verifyEmail", { email: EMAIL, code: codigo });
    expect(r.verificado).toBe(true);
  });

  test("usuário já verificado recebe verificado:true sem checar o código (comportamento atual)", async () => {
    await makeUser({ email: EMAIL });
    const r = await call("verificarEmail", { email: EMAIL, codigo: "000000" });
    expect(r).toEqual({ verificado: true });
  });
});

describe("reenviarVerificacao", () => {
  test("responde ok sem enviar nada para e-mail inexistente", async () => {
    expect(await call("reenviarVerificacao", { email: "x@x.com" })).toEqual({ ok: true });
    expect(emails()).toHaveLength(0);
  });

  test("não reenvia dentro de 60s", async () => {
    await cadastrar();
    await call("reenviarVerificacao", { email: EMAIL });
    expect(emails()).toHaveLength(1);
  });

  test("depois do intervalo envia novo código e invalida o anterior", async () => {
    await cadastrar();
    envelhecerTokens();
    await call("resend-code", { email: EMAIL });

    expect(emails()).toHaveLength(2);
    const [antigo, novo] = fake.rows("EmailToken");
    expect(antigo.data.usado).toBe(true);
    expect(novo.data.usado).toBe(false);

    const r = await call("verificarEmail", { email: EMAIL, codigo: ultimoCodigo() });
    expect(r.verificado).toBe(true);
  });

  test("não envia para usuário já verificado", async () => {
    await makeUser({ email: EMAIL });
    await call("reenviarVerificacao", { email: EMAIL });
    expect(emails()).toHaveLength(0);
  });
});

describe("recuperação de senha", () => {
  const EM = "u@t.com";
  let user;
  beforeEach(async () => {
    user = await makeUser({ email: EM, senha: "antiga1" });
  });

  test("envia o código de recuperação", async () => {
    expect(await call("solicitarRecuperacaoSenha", { email: EM })).toEqual({ ok: true });
    expect(emails()[0].body.subject).toMatch(/Recuperação de senha/);
    expect(emails()[0].body.to).toEqual([{ email: EM }]);
  });

  test("e-mail inexistente responde ok sem enviar (não vaza cadastro)", async () => {
    expect(await call("forgot-password", { email: "nao@existe.com" })).toEqual({ ok: true });
    expect(emails()).toHaveLength(0);
  });

  test("respeita o intervalo de 60s", async () => {
    await call("solicitarRecuperacaoSenha", { email: EM });
    await call("solicitarRecuperacaoSenha", { email: EM });
    expect(emails()).toHaveLength(1);
  });

  test("verificarCodigoReset valida sem consumir o código", async () => {
    await call("solicitarRecuperacaoSenha", { email: EM });
    const codigo = ultimoCodigo();

    const r = await call("verificarCodigoReset", { email: EM, codigo });
    expect(r).toEqual({ ok: true, valido: true, verificado: true });
    expect(fake.rows("EmailToken")[0].data.usado).toBe(false);

    await falha(call("verificarCodigoReset", { email: EM, codigo: diferente(codigo) }));
  });

  test("redefinirSenha rejeita senha curta", async () => {
    await call("solicitarRecuperacaoSenha", { email: EM });
    const e = await falha(
      call("redefinirSenha", { email: EM, codigo: ultimoCodigo(), novaSenha: "123" }),
    );
    expect(e.campos.senha).toBe("Mínimo 6 caracteres");
  });

  test("redefinirSenha rejeita código inválido e usuário inexistente", async () => {
    await call("solicitarRecuperacaoSenha", { email: EM });
    await falha(call("redefinirSenha", { email: EM, codigo: diferente(ultimoCodigo()), novaSenha: "nova123" }));
    await falha(call("redefinirSenha", { email: "x@x.com", codigo: "123456", novaSenha: "nova123" }));
  });

  test("troca a senha, consome o código e o antigo password deixa de valer", async () => {
    await call("solicitarRecuperacaoSenha", { email: EM });
    const codigo = ultimoCodigo();

    expect(await call("redefinirSenha", { email: EM, codigo, novaSenha: "nova123" })).toEqual({ ok: true });

    await call("login", { email: EM, senha: "nova123" });
    const e = await falha(call("login", { email: EM, senha: "antiga1" }));
    expect(e.erro).toBe("E-mail ou senha incorretos");

    // código só vale uma vez
    await falha(call("redefinirSenha", { email: EM, codigo, novaSenha: "outra123" }));
  });

  test("aceita nomes alternativos de parâmetro (code / password)", async () => {
    await call("solicitarRecuperacaoSenha", { email: EM });
    const r = await call("reset-password", { email: EM, code: ultimoCodigo(), password: "nova123" });
    expect(r.ok).toBe(true);
  });

  test("redefinir senha de conta não verificada marca o e-mail como verificado", async () => {
    await makeUser({ email: "p@t.com", verificado: false });
    await call("solicitarRecuperacaoSenha", { email: "p@t.com" });
    await call("redefinirSenha", { email: "p@t.com", codigo: ultimoCodigo(), novaSenha: "nova123" });

    const row = fake.rows("_User").find((r) => r.data.email === "p@t.com");
    expect(row.data.emailVerificado).toBe(true);
  });

  test("código de verificação não serve para recuperação de senha", async () => {
    await makeUser({ email: "q@t.com", verificado: false });
    await call("reenviarVerificacao", { email: "q@t.com" });
    const codigo = ultimoCodigo();
    await falha(call("redefinirSenha", { email: "q@t.com", codigo, novaSenha: "nova123" }));
  });
});

describe("login", () => {
  test("normaliza o e-mail e devolve token e usuário", async () => {
    await makeUser({ email: "ana@t.com", senha: "abc123", nome: "Ana" });
    const r = await call("login", { email: "  ANA@t.com ", senha: "abc123" });

    expect(typeof r.token).toBe("string");
    expect(r.usuario).toMatchObject({ nome: "Ana", email: "ana@t.com" });
    expect(r.usuario.password).toBeUndefined();
  });

  test("senha errada", async () => {
    await makeUser({ email: "ana@t.com", senha: "abc123" });
    const e = await falha(call("login", { email: "ana@t.com", senha: "errada" }));
    expect(e.erro).toBe("E-mail ou senha incorretos");
  });

  test("parâmetros vazios", async () => {
    const e = await falha(call("login", {}));
    expect(e.erro).toBe("E-mail ou senha incorretos");
  });

  test("e-mail não verificado bloqueia o login", async () => {
    await makeUser({ email: "ana@t.com", senha: "abc123", verificado: false });
    const e = await falha(call("login", { email: "ana@t.com", senha: "abc123" }));
    expect(e.codigo).toBe("EMAIL_NAO_VERIFICADO");
  });
});

describe("hooks do usuário", () => {
  test("beforeSave: master pode alterar emailVerificado", async () => {
    const u = await makeUser();
    u.set("emailVerificado", true);
    await expect(fake.hooks.beforeSave({ master: true, object: u })).resolves.toBeUndefined();
  });

  test("beforeSave: novo usuário sempre nasce não verificado", async () => {
    const u = new fake.Parse.User();
    u.set("emailVerificado", true);
    await fake.hooks.beforeSave({ master: false, object: u });
    expect(u.get("emailVerificado")).toBe(false);
  });

  test("beforeSave: usuário comum não consegue se auto-verificar", async () => {
    await makeUser({ verificado: false });
    const [u] = await new fake.Parse.Query(fake.Parse.User).find();
    u.set("emailVerificado", true);

    const e = await falha(fake.hooks.beforeSave({ master: false, object: u }));
    expect(e.code).toBe(141);
    expect(e.erro).toBe("Operação não permitida");
  });

  test("beforeSave: alterar outros campos é permitido", async () => {
    await makeUser();
    const [u] = await new fake.Parse.Query(fake.Parse.User).find();
    u.set("nome", "Novo Nome");
    await expect(fake.hooks.beforeSave({ master: false, object: u })).resolves.toBeUndefined();
  });

  describe("afterSave (aviso ao admin)", () => {
    test("ignora atualizações", async () => {
      process.env.ADMIN_EMAIL = "admin@t.com";
      const u = await makeUser();
      await fake.hooks.afterSave({ object: u, original: {} });
      expect(emails()).toHaveLength(0);
    });

    test("sem ADMIN_EMAIL não envia", async () => {
      const u = await makeUser();
      await fake.hooks.afterSave({ object: u });
      expect(emails()).toHaveLength(0);
    });

    test("avisa o admin e escapa HTML dos dados do usuário", async () => {
      process.env.ADMIN_EMAIL = "admin@t.com";
      const u = await makeUser({ nome: "<script>alert(1)</script>" });
      await fake.hooks.afterSave({ object: u });

      const [mail] = emails();
      expect(mail.body.to).toEqual([{ email: "admin@t.com" }]);
      expect(mail.body.subject).toMatch(/Novo cadastro/);
      expect(mail.body.htmlContent).toContain("&lt;script&gt;");
      expect(mail.body.htmlContent).not.toContain("<script>");
    });

    test("falha no e-mail não propaga erro", async () => {
      process.env.ADMIN_EMAIL = "admin@t.com";
      global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => "x" }));
      const u = await makeUser();
      await expect(fake.hooks.afterSave({ object: u })).resolves.toBeUndefined();
    });
  });
});

describe("envio de e-mail / funções master", () => {
  test("Brevo é o provedor padrão", async () => {
    const r = await call("testarEmail", { para: "x@t.com" });
    const [mail] = emails();

    expect(r).toEqual({ ok: true, para: "x@t.com", provider: "brevo" });
    expect(mail.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(mail.headers["api-key"]).toBe("chave");
    expect(mail.body.sender).toEqual({ name: "Marmopedras", email: "no-reply@teste.com" });
  });

  test("Resend quando configurado", async () => {
    process.env.EMAIL_PROVIDER = "Resend";
    const r = await call("testarEmail", { para: "x@t.com" });
    const [mail] = emails();

    expect(r.provider).toBe("Resend");
    expect(mail.url).toBe("https://api.resend.com/emails");
    expect(mail.headers.Authorization).toBe("Bearer chave");
    expect(mail.body).toMatchObject({
      from: "Marmopedras <no-reply@teste.com>",
      to: ["x@t.com"],
    });
  });

  test("erro HTTP devolve diagnóstico da configuração", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    const r = await call("testarEmail", { para: "x@t.com" });

    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/HTTP 500/);
    expect(r.configurado).toMatchObject({ EMAIL_API_KEY: true, EMAIL_FROM: true, ADMIN_EMAIL: false });
  });

  test("testarEmail e seed exigem master key", async () => {
    expect(fake.validators.testarEmail.requireMaster).toBe(true);
    expect(fake.validators.seed.requireMaster).toBe(true);
    expect(await call("seed")).toBe("Seed de demonstração desativado");
  });
});
