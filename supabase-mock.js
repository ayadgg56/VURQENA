/* Local-only Supabase mock. This file is served only by local_test_server.py. */
(function (global) {
  'use strict';
  const rows = new Map();
  rows.set('admins/local-user-0001', true);
  const calls = [];
  const listeners = new Set();
  let user = null;

  function emit(event, session) {
    for (const cb of listeners) queueMicrotask(() => cb(event, session));
  }
  function flatten(path, value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) flatten(path ? path + '/' + key : key, child);
    } else rows.set(path, value);
  }
  function readPath(path) {
    const prefix = path ? path + '/' : '';
    const found = [];
    for (const [rowPath, value] of rows) {
      if (rowPath === path || rowPath.startsWith(prefix)) found.push({ path: rowPath, value });
    }
    return found;
  }
  function removePath(path) {
    const prefix = path ? path + '/' : '';
    for (const key of Array.from(rows.keys())) if (key === path || key.startsWith(prefix)) rows.delete(key);
  }

  const client = {
    auth: {
      onAuthStateChange(callback) {
        listeners.add(callback);
        queueMicrotask(() => callback('INITIAL_SESSION', user ? { user } : null));
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },
      async getSession() { return { data: { session: user ? { user, access_token: 'local-test-token' } : null }, error: null }; },
      async getUser() { return { data: { user }, error: null }; },
      async signUp({ email, password, options }) {
        calls.push({ method: 'auth.signUp', email, passwordLength: String(password || '').length });
        user = { id: 'local-user-0001', email, email_confirmed_at: null, user_metadata: options?.data || {} };
        return { data: { user, session: null }, error: null };
      },
      async signInWithPassword({ email, password }) {
        calls.push({ method: 'auth.signInWithPassword', email });
        if (!email || !password) return { data: { user: null, session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
        user = { id: 'local-user-0001', email, email_confirmed_at: new Date().toISOString(), user_metadata: { fullName: 'مستخدم تجريبي', username: 'local_test' } };
        const session = { user, access_token: 'local-test-token' };
        emit('SIGNED_IN', session);
        return { data: { user, session }, error: null };
      },
      async signOut() { calls.push({ method: 'auth.signOut' }); user = null; emit('SIGNED_OUT', null); return { data: {}, error: null }; },
      async resend(payload) { calls.push({ method: 'auth.resend', type: payload.type, email: payload.email }); return { data: {}, error: null }; },
      async resetPasswordForEmail(email) { calls.push({ method: 'auth.resetPasswordForEmail', email }); return { data: {}, error: null }; }
    },
    async rpc(name, args) {
      calls.push({ method: 'rpc', name });
      if (name === 'firebase_read') return { data: readPath(String(args?.p_path || '')), error: null };
      if (name === 'firebase_write') {
        const path = String(args?.p_path || '');
        if (args?.p_op === 'delete') removePath(path);
        else if (args?.p_op === 'set') { removePath(path); flatten(path, args?.p_value); }
        else if (args?.p_op === 'update' && args?.p_value && typeof args.p_value === 'object') {
          for (const [key, value] of Object.entries(args.p_value)) flatten([path, key].filter(Boolean).join('/'), value);
        }
        return { data: { ok: true }, error: null };
      }
      if (name === 'firebase_increment') {
        const path = String(args?.p_path || '');
        const next = Number(rows.get(path) || 0) + Number(args?.p_delta || 0);
        rows.set(path, next);
        return { data: { value: next }, error: null };
      }
      // Unknown feature RPCs return harmless empty outcomes in this isolated UI mock.
      return { data: { ok: true, claimed: false, coins: 0, streak: 0, reward: 0 }, error: null };
    },
    channel(name) {
      return { on() { return this; }, subscribe(callback) { queueMicrotask(() => callback('SUBSCRIBED')); return this; }, name };
    },
    async removeChannel() { return 'ok'; },
    storage: { from(bucket) {
      return {
        async upload(path, blob) { calls.push({ method: 'storage.upload', bucket, path, size: blob?.size || 0 }); return { data: { path }, error: null }; },
        getPublicUrl(path) { return { data: { publicUrl: 'https://local.invalid/' + bucket + '/' + path } }; },
        async createSignedUrl(path) { return { data: { signedUrl: 'https://local.invalid/private/' + path }, error: null }; }
      };
    } }
  };

  global.__PHOENIX_LOCAL_TEST__ = { calls, rows };
  global.supabase = { createClient(url, key) {
    if (!String(url).startsWith('http://supabase-mock.local')) throw new Error('Local test refused a non-local Supabase URL');
    if (key !== 'local-only-test-key') throw new Error('Unexpected Supabase test key');
    calls.push({ method: 'createClient', url });
    return client;
  } };
})(window);
