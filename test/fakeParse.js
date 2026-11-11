function createFakeParse() {
  const store = {}; 
  const functions = {};
  const validators = {};
  const hooks = {};
  let seq = 0;

  const tabela = (c) => (store[c] ??= new Map());
  const clone = (v) => structuredClone(v);

  class ParseError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function hidratar(className, row) {
    const o = className === "_User" ? new FakeUser() : new FakeObject(className);
    o.id = row.id;
    o.createdAt = row.createdAt;
    o._seq = row.seq;
    o._data = clone(row.data);
    return o;
  }

  class FakeObject {
    constructor(className) {
      this.className = className;
      this._data = {};
      this._dirty = new Set();
    }
    set(k, v) {
      if (k && typeof k === "object") {
        for (const [a, b] of Object.entries(k)) this.set(a, b);
        return this;
      }
      this._data[k] = v;
      this._dirty.add(k);
      return this;
    }
    get(k) {
      return this._data[k];
    }
    increment(k, n = 1) {
      return this.set(k, (Number(this._data[k]) || 0) + n);
    }
    dirty(k) {
      return this._dirty.has(k);
    }
    isNew() {
      return !this.id;
    }
    setACL() {}
    toJSON() {
      return { objectId: this.id, createdAt: this.createdAt, ...clone(this._data) };
    }
    async save() {
      if (!this.id) {
        this.id = `id${++seq}`;
        this.createdAt = new Date();
        this._seq = seq;
      }
      tabela(this.className).set(this.id, {
        id: this.id,
        data: clone(this._data),
        createdAt: this.createdAt,
        seq: this._seq,
      });
      this._dirty.clear();
      return this;
    }
    async destroy() {
      tabela(this.className).delete(this.id);
    }
    static saveAll(lista) {
      return Promise.all(lista.map((o) => o.save()));
    }
    static destroyAll(lista) {
      return Promise.all(lista.map((o) => o.destroy()));
    }
  }

  class FakeUser extends FakeObject {
    constructor() {
      super("_User");
    }
    getSessionToken() {
      return `r:${this.id}`;
    }
    async signUp() {
      const dup = [...tabela("_User").values()].some(
        (r) => r.data.username === this._data.username,
      );
      if (dup) throw new ParseError(202, "Account already exists.");
      return this.save();
    }
    static async logIn(username, password) {
      const row = [...tabela("_User").values()].find(
        (r) => r.data.username === username && r.data.password === password,
      );
      if (!row) throw new ParseError(101, "Invalid username/password.");
      const user = hidratar("_User", row);
    
      if (hooks.beforeLogin) await hooks.beforeLogin({ object: user });
      return user;
    }
  }

  const valor = (row, k) =>
    k === "createdAt" ? row.createdAt : k === "objectId" ? row.id : row.data[k];
  const norm = (v) => (v instanceof Date ? v.getTime() : v);

  class FakeQuery {
    constructor(cls) {
      this.className = cls === FakeUser ? "_User" : cls;
      this.preds = [];
      this.ordens = [];
      this._limit = 100; 
      this._skip = 0;
      this.ors = null;
    }
    static or(...qs) {
      const q = new FakeQuery(qs[0].className);
      q.ors = qs;
      return q;
    }
    _cmp(k, fn) {
      this.preds.push((row) => fn(norm(valor(row, k))));
      return this;
    }
    equalTo(k, v) {
      return this._cmp(k, (x) => x === norm(v));
    }
    greaterThan(k, v) {
      return this._cmp(k, (x) => x > norm(v));
    }
    greaterThanOrEqualTo(k, v) {
      return this._cmp(k, (x) => x >= norm(v));
    }
    lessThanOrEqualTo(k, v) {
      return this._cmp(k, (x) => x <= norm(v));
    }
    containedIn(k, arr) {
      return this._cmp(k, (x) => arr.includes(x));
    }
    matches(k, rx, flags) {
      const r = new RegExp(rx, flags);
      return this._cmp(k, (x) => r.test(String(x ?? "")));
    }
    limit(n) {
      this._limit = n;
      return this;
    }
    skip(n) {
      this._skip = n;
      return this;
    }
    ascending(k) {
      this.ordens = [[k, 1]];
      return this;
    }
    descending(k) {
      this.ordens = [[k, -1]];
      return this;
    }
    addAscending(k) {
      this.ordens.push([k, 1]);
      return this;
    }
    addDescending(k) {
      this.ordens.push([k, -1]);
      return this;
    }
    _casa(row) {
      return (
        (!this.ors || this.ors.some((q) => q._casa(row))) &&
        this.preds.every((p) => p(row))
      );
    }
    _rows() {
      const rows = [...tabela(this.className).values()].filter((r) => this._casa(r));
      rows.sort((a, b) => {
        for (const [k, dir] of this.ordens) {
          const x = k === "createdAt" ? a.seq : norm(valor(a, k));
          const y = k === "createdAt" ? b.seq : norm(valor(b, k));
          if (x < y) return -dir;
          if (x > y) return dir;
        }
        return a.seq - b.seq;
      });
      return rows;
    }
    async find() {
      return this._rows()
        .slice(this._skip, this._skip + this._limit)
        .map((r) => hidratar(this.className, r));
    }
    async first() {
      const [r] = this._rows();
      return r ? hidratar(this.className, r) : undefined;
    }
    async count() {
      return this._rows().length;
    }
  }

  const Cloud = {
    define: (nome, fn, validator) => {
      functions[nome] = fn;
      if (validator) validators[nome] = validator;
    },
    job: (nome, fn) => {
      hooks[`job:${nome}`] = fn;
    },
    beforeSave: (_cls, fn) => {
      hooks.beforeSave = fn;
    },
    afterSave: (_cls, fn) => {
      hooks.afterSave = fn;
    },
    beforeLogin: (fn) => {
      hooks.beforeLogin = fn;
    },
  };

  return {
    Parse: {
      Error: ParseError,
      Object: FakeObject,
      User: FakeUser,
      Query: FakeQuery,
      ACL: class {},
      Cloud,
    },
    functions,
    validators,
    hooks,
    rows: (cls) => [...tabela(cls).values()],
    insertMany(cls, lista) {
      for (const data of lista) {
        const id = `id${++seq}`;
        tabela(cls).set(id, { id, data: clone(data), createdAt: new Date(), seq });
      }
    },
    reset() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

module.exports = { createFakeParse };
