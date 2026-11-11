const { createFakeParse } = require("./fakeParse");

function setup() {
  const fake = createFakeParse();
  global.Parse = fake.Parse;

  const ENV_PADRAO = {
    EMAIL_API_KEY: "chave",
    EMAIL_FROM: "no-reply@teste.com",
    TOKEN_SECRET: "segredo-de-teste",
  };
  Object.assign(process.env, ENV_PADRAO);

  require("../main");

  const call = (nome, params = {}, user) =>
    fake.functions[nome]({ params, user, master: false });

  const falha = async (promessa) => {
    try {
      await promessa;
    } catch (e) {
      let corpo;
      try {
        corpo = JSON.parse(e.message);
      } catch {
        corpo = { erro: e.message };
      }
      return { code: e.code, ...corpo };
    }
    throw new Error("Esperava uma falha, mas a chamada teve sucesso");
  };

  const emails = () =>
    global.fetch.mock.calls.map(([url, init]) => ({
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    }));

  const ultimoCodigo = () => {
    const todos = emails();
    return todos[todos.length - 1].body.htmlContent.match(/>(\d{6})</)[1];
  };

  const makeUser = async ({
    email = "user@teste.com",
    senha = "123456",
    nome = "Teste",
    cargo = "Gerente",
    telefone = "81999990000",
    verificado = true,
  } = {}) => {
    const u = new fake.Parse.User();
    u.set({
      username: email,
      email,
      password: senha,
      nome,
      cargo,
      telefone,
      emailVerificado: verificado,
    });
    await u.save(null, { useMasterKey: true });
    return u;
  };

  const reset = () => {
    fake.reset();
    Object.assign(process.env, ENV_PADRAO);
    delete process.env.ADMIN_EMAIL;
    delete process.env.EMAIL_PROVIDER;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    }));
  };

  return { fake, call, falha, emails, ultimoCodigo, makeUser, reset };
}

module.exports = { setup };
