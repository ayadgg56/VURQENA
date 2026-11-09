/* PHOENIX Pro Supabase adapter: keeps the legacy page API while moving Auth, data and media to Supabase. */
(function (global) {
  'use strict';

  const CONFIG = global.PHOENIX_SUPABASE_CONFIG || {};
  if (!global.supabase || typeof global.supabase.createClient !== 'function') {
    throw new Error('تعذر تحميل مكتبة Supabase. تحقق من اتصال الإنترنت ثم أعد المحاولة.');
  }
  if (!CONFIG.url || !CONFIG.anonKey) {
    throw new Error('إعدادات Supabase غير مكتملة.');
  }

  const client = global.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  const activeListeners = new Set();
  const privatePrefix = 'phoenix-private://';
  const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
  const allowedMime = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|webm|wav))$/i;

  function cleanPath(path) {
    return String(path || '').split('/').filter(Boolean).join('/');
  }
  function isInside(path, base) {
    return !base || path === base || path.startsWith(base + '/');
  }
  function plainCopy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function stable(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  function keyFor(path) {
    const parts = cleanPath(path).split('/');
    return parts.length ? parts[parts.length - 1] : null;
  }
  function setNested(root, parts, value) {
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
      node = node[key];
    }
    if (parts.length) node[parts[parts.length - 1]] = value;
  }
  function rowsToTree(rows, basePath) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const base = cleanPath(basePath);
    let tree = {};
    let rootIsScalar = false;
    for (const row of rows) {
      if (!row || typeof row.path !== 'string') continue;
      const fullPath = cleanPath(row.path);
      if (!isInside(fullPath, base)) continue;
      const tail = base ? fullPath.slice(base.length).replace(/^\//, '') : fullPath;
      if (!tail) {
        if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
          tree = row.value;
          rootIsScalar = false;
        } else {
          tree = row.value;
          rootIsScalar = true;
        }
        continue;
      }
      if (rootIsScalar) continue;
      if (!tree || typeof tree !== 'object' || Array.isArray(tree)) tree = {};
      setNested(tree, tail.split('/'), row.value);
    }
    return tree;
  }
  function directChildren(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function mediaExtension(mime) {
    const clean = (mime || '').toLowerCase().split(';')[0];
    const map = {
      'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp',
      'video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/mp4':'m4a',
      'audio/ogg':'ogg','audio/webm':'weba','audio/wav':'wav'
    };
    return map[clean] || 'bin';
  }
  async function storeDataUrl(dataUrl, dbPath) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl);
    if (!match) return dataUrl;
    const mime = match[1];
    if (!allowedMime.test(mime)) throw new Error('نوع الملف غير مدعوم للتخزين.');
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.size > MAX_MEDIA_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح (50MB).');
    const user = (await client.auth.getUser()).data.user;
    if (!user) throw new Error('يجب تسجيل الدخول قبل رفع الوسائط.');
    const chatMatch = /^private_chats\/([^/]+)/.exec(cleanPath(dbPath));
    const bucket = chatMatch ? 'phoenix-private' : 'phoenix-public';
    const id = global.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const suffix = mediaExtension(mime);
    const objectPath = chatMatch
      ? chatMatch[1] + '/' + user.id + '/' + id + '.' + suffix
      : user.id + '/' + new Date().toISOString().slice(0, 10) + '/' + id + '.' + suffix;
    const { error } = await client.storage.from(bucket).upload(objectPath, blob, {
      contentType: mime,
      cacheControl: '31536000',
      upsert: false
    });
    if (error) throw error;
    if (bucket === 'phoenix-private') return privatePrefix + objectPath;
    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    return data.publicUrl;
  }
  async function normalizeForWrite(value, path) {
    if (typeof value === 'string' && value.startsWith('data:')) return storeDataUrl(value, path);
    if (Array.isArray(value)) return Promise.all(value.map((v, i) => normalizeForWrite(v, path + '/' + i)));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value)) out[key] = await normalizeForWrite(val, path + '/' + key);
      return out;
    }
    return value;
  }
  async function hydrateMedia(value) {
    if (typeof value === 'string' && value.startsWith(privatePrefix)) {
      const objectPath = value.slice(privatePrefix.length);
      const { data, error } = await client.storage.from('phoenix-private').createSignedUrl(objectPath, 3600);
      return error ? '' : data.signedUrl;
    }
    if (Array.isArray(value)) return Promise.all(value.map(hydrateMedia));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value)) out[key] = await hydrateMedia(val);
      return out;
    }
    return value;
  }

  class Snapshot {
    constructor(key, value) { this.key = key; this._value = value === undefined ? null : value; }
    val() { return this._value === undefined ? null : this._value; }
    exists() { return this._value !== null && this._value !== undefined; }
    numChildren() { return Object.keys(directChildren(this._value)).length; }
    child(path) {
      let value = this._value;
      for (const part of String(path || '').split('/').filter(Boolean)) value = value == null ? undefined : value[part];
      return new Snapshot(keyFor(path), value);
    }
    forEach(callback) {
      for (const [key, value] of Object.entries(directChildren(this._value))) {
        if (callback(new Snapshot(key, value)) === true) return true;
      }
      return false;
    }
  }

  class Ref {
    constructor(path, query) {
      this.path = cleanPath(path);
      this._query = query || { orderBy: null, equal: undefined, start: undefined, end: undefined, limitLast: null, limitFirst: null };
      this.key = keyFor(this.path);
    }
    child(path) { return new Ref([this.path, path].filter(Boolean).join('/'), { ...this._query }); }
    _clone(patch) { return new Ref(this.path, { ...this._query, ...patch }); }
    orderByChild(child) { return this._clone({ orderBy: String(child) }); }
    orderByKey() { return this._clone({ orderBy: '$key' }); }
    equalTo(value) { return this._clone({ equal: value }); }
    startAt(value) { return this._clone({ start: value }); }
    endAt(value) { return this._clone({ end: value }); }
    limitToLast(value) { return this._clone({ limitLast: Math.max(0, Number(value) || 0), limitFirst: null }); }
    limitToFirst(value) { return this._clone({ limitFirst: Math.max(0, Number(value) || 0), limitLast: null }); }
    async _read() {
      const { data, error } = await client.rpc('firebase_read', { p_path: this.path });
      if (error) throw error;
      let value = rowsToTree(data, this.path);
      value = await hydrateMedia(value);
      if (value && typeof value === 'object' && !Array.isArray(value) && (this._query.orderBy || this._query.equal !== undefined || this._query.start !== undefined || this._query.end !== undefined || this._query.limitLast !== null || this._query.limitFirst !== null)) {
        let entries = Object.entries(value);
        const getOrder = ([key, item]) => this._query.orderBy === '$key' ? key : (item && typeof item === 'object' ? item[this._query.orderBy] : undefined);
        if (this._query.equal !== undefined) entries = entries.filter(e => getOrder(e) === this._query.equal);
        if (this._query.start !== undefined) entries = entries.filter(e => getOrder(e) !== undefined && getOrder(e) >= this._query.start);
        if (this._query.end !== undefined) entries = entries.filter(e => getOrder(e) !== undefined && getOrder(e) <= this._query.end);
        entries.sort((a, b) => {
          const av = getOrder(a), bv = getOrder(b);
          if (av === bv) return a[0].localeCompare(b[0]);
          if (av === undefined) return -1;
          if (bv === undefined) return 1;
          return av < bv ? -1 : 1;
        });
        if (this._query.limitLast !== null) entries = this._query.limitLast === 0 ? [] : entries.slice(-this._query.limitLast);
        if (this._query.limitFirst !== null) entries = entries.slice(0, this._query.limitFirst);
        value = Object.fromEntries(entries);
      }
      return new Snapshot(this.key, value);
    }
    once(event, success, failure) {
      const promise = this._read();
      if (typeof success === 'function') promise.then(success).catch(err => { if (typeof failure === 'function') failure(err); else console.error('Supabase read failed', err); });
      return promise;
    }
    get() { return this._read(); }
    async _write(value, op) {
      if (op !== 'delete') value = await normalizeForWrite(value, this.path);
      const { data, error } = await client.rpc('firebase_write', { p_path: this.path, p_value: value === undefined ? null : value, p_op: op });
      if (error) throw error;
      return data;
    }
    set(value) { return value === null ? this._write(null, 'delete') : this._write(value, 'set'); }
    update(value) { return this._write(value, 'update'); }
    remove() { return this._write(null, 'delete'); }
    push(value) {
      const key = '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 13);
      const ref = this.child(key);
      if (arguments.length) {
        const promise = ref.set(value);
        ref.then = promise.then.bind(promise);
        ref.catch = promise.catch.bind(promise);
        ref.finally = promise.finally.bind(promise);
      }
      return ref;
    }
    async transaction(updateFn) {
      if (typeof updateFn !== 'function') throw new TypeError('transaction expects a function');
      const snap = await this._read();
      const current = snap.val();
      const next = updateFn(current);
      if (next === undefined) return { committed: false, snapshot: snap };
      if (next === null) { await this.remove(); return { committed: true, snapshot: new Snapshot(this.key, null) }; }
      if (typeof next === 'number' && (typeof current === 'number' || current == null)) {
        const delta = next - (Number(current) || 0);
        const { data, error } = await client.rpc('firebase_increment', { p_path: this.path, p_delta: delta });
        if (error) throw error;
        return { committed: true, snapshot: new Snapshot(this.key, data && data.value !== undefined ? Number(data.value) : next) };
      }
      await this.set(next);
      return { committed: true, snapshot: new Snapshot(this.key, next) };
    }
    onDisconnect() {
      let active = true;
      const cleanup = () => { if (active) this.remove().catch(() => {}); };
      global.addEventListener('pagehide', cleanup, { once: true });
      global.addEventListener('beforeunload', cleanup, { once: true });
      return { remove: async () => { cleanup(); }, cancel: async () => { active = false; } };
    }
    on(event, callback, cancelCallback) {
      const listener = { ref: this, event, callback, cancelCallback, channel: null, previous: null, stopped: false };
      activeListeners.add(listener);
      const emitInitial = async () => {
        try {
          const snap = await this._read();
          const current = snap.val();
          listener.previous = plainCopy(current);
          if (event === 'value') callback(snap);
          else if (event === 'child_added') {
            for (const [key, value] of Object.entries(directChildren(current))) callback(new Snapshot(key, value));
          }
        } catch (err) { if (typeof cancelCallback === 'function') cancelCallback(err); else console.error('Supabase listener read failed', err); }
      };
      const channel = client.channel('phx-' + Math.random().toString(36).slice(2));
      listener.channel = channel;
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'firebase_nodes' }, async payload => {
        if (listener.stopped) return;
        const changedPath = (payload.new && payload.new.path) || (payload.old && payload.old.path) || '';
        if (this.path && changedPath && !isInside(changedPath, this.path) && !isInside(this.path, changedPath)) return;
        try {
          const snap = await this._read();
          const current = snap.val();
          if (event === 'value') callback(snap);
          else {
            const before = directChildren(listener.previous);
            const after = directChildren(current);
            for (const [key, value] of Object.entries(after)) {
              if (!(key in before)) { if (event === 'child_added') callback(new Snapshot(key, value)); }
              else if (stable(before[key]) !== stable(value) && event === 'child_changed') callback(new Snapshot(key, value));
            }
            if (event === 'child_removed') for (const [key, value] of Object.entries(before)) if (!(key in after)) callback(new Snapshot(key, value));
          }
          listener.previous = plainCopy(current);
        } catch (err) { if (typeof cancelCallback === 'function') cancelCallback(err); }
      }).subscribe(status => {
        if (status === 'SUBSCRIBED') emitInitial();
        if (status === 'CHANNEL_ERROR' && typeof cancelCallback === 'function') cancelCallback(new Error('تعذر الاتصال بالتحديثات الفورية'));
      });
      return callback;
    }
    off(event, callback) {
      for (const listener of Array.from(activeListeners)) {
        if (listener.ref.path === this.path && (!event || listener.event === event) && (!callback || listener.callback === callback)) {
          listener.stopped = true;
          activeListeners.delete(listener);
          if (listener.channel) client.removeChannel(listener.channel).catch(() => {});
        }
      }
    }
  }

  function normalizeAuthError(error) {
    const e = error || new Error('حدث خطأ في تسجيل الدخول');
    const text = String(e.message || '').toLowerCase();
    const rawCode = String(e.code || '').toLowerCase();
    if (rawCode === 'email_not_confirmed' || text.includes('email not confirmed')) e.code = 'auth/email-not-confirmed';
    else if (text.includes('already confirmed') || rawCode === 'user_already_confirmed') e.code = 'auth/email-already-confirmed';
    else if (rawCode === '23505' || text.includes('duplicate key') || text.includes('unique constraint') || text.includes('phoenix_unique_username_idx')) e.code = 'auth/username-already-in-use';
    else if (text.includes('database error saving new user')) e.code = 'auth/profile-save-failed';
    else if (text.includes('invalid login') || text.includes('invalid credential') || text.includes('invalid_credentials')) e.code = 'auth/invalid-credential';
    else if (text.includes('already registered') || text.includes('already been registered')) e.code = 'auth/email-already-in-use';
    else if (text.includes('password should be at least') || text.includes('weak password')) e.code = 'auth/weak-password';
    else if (text.includes('invalid email')) e.code = 'auth/invalid-email';
    else if (text.includes('rate limit') || text.includes('too many')) e.code = 'auth/too-many-requests';
    else if (text.includes('network')) e.code = 'auth/network-request-failed';
    else e.code = e.code || 'auth/unknown';
    return e;
  }
  function mapUser(user) {
    if (!user) return null;
    const metadata = user.user_metadata || {};
    const mapped = {
      uid: user.id,
      id: user.id,
      email: user.email || '',
      emailVerified: !!user.email_confirmed_at,
      email_confirmed_at: user.email_confirmed_at || null,
      displayName: metadata.fullName || metadata.name || metadata.full_name || '',
      photoURL: metadata.photoURL || metadata.avatar_url || '',
      user_metadata: metadata,
      rawUser: user,
      sendEmailVerification: async () => {
        const { error } = await client.auth.resend({ type: 'signup', email: user.email });
        if (error) throw normalizeAuthError(error);
      }
    };
    return mapped;
  }
  const auth = {
    _currentUser: null,
    get currentUser() { return this._currentUser; },
    onAuthStateChanged(callback) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        this._currentUser = mapUser(session && session.user);
        Promise.resolve().then(() => callback(this._currentUser));
      });
      return () => { try { data.subscription.unsubscribe(); } catch (_) {} };
    },
    async signInWithEmailAndPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw normalizeAuthError(error);
      this._currentUser = mapUser(data.user);
      return { user: this._currentUser, session: data.session };
    },
    async createUserWithEmailAndPassword(email, password, metadata) {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: metadata || {}, emailRedirectTo: global.location.origin + global.location.pathname }
      });
      if (error) throw normalizeAuthError(error);
      this._currentUser = mapUser(data.user);
      return { user: this._currentUser, session: data.session };
    },
    async resendSignupConfirmation(email) {
      const { error } = await client.auth.resend({ type: 'signup', email });
      if (error) throw normalizeAuthError(error);
    },
    async sendPasswordResetEmail(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: global.location.origin + global.location.pathname });
      if (error) throw normalizeAuthError(error);
    },
    async signOut() {
      global.PhoenixSupabase?.closeAllListeners();
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData.session) { this._currentUser = null; return; }
      const { error } = await client.auth.signOut();
      if (error) throw normalizeAuthError(error);
      this._currentUser = null;
    }
  };

  global.PhoenixSupabase = {
    client,
    db: { ref: path => new Ref(path) },
    auth,
    closeAllListeners() {
      for (const listener of Array.from(activeListeners)) {
        listener.stopped = true;
        if (listener.channel) client.removeChannel(listener.channel).catch(() => {});
      }
      activeListeners.clear();
    }
  };
})(window);
