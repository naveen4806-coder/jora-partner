/* Firebase-shaped browser adapter backed by the shared Jora Supabase project. */
(function () {
  const config = window.JORA_SUPABASE_CONFIG || {};
  if (!config.url || !config.publishableKey) throw new Error('Missing JORA_SUPABASE_CONFIG.');
  const client = window.supabase.createClient(config.url, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const now = () => new Date().toISOString();
  const clone = value => JSON.parse(JSON.stringify(value == null ? null : value));
  const fail = error => { const e = new Error(error && error.message || 'Supabase request failed'); e.code = error && error.code; throw e; };
  const marker = (type, value) => ({ __jora: type, value });
  const FieldValue = { increment: n => marker('increment', Number(n) || 0), arrayUnion: v => marker('arrayUnion', v) };
  const unwrap = value => value && value.__jora;
  function mergePatch(before, patch) {
    const next = Object.assign({}, before);
    Object.keys(patch || {}).forEach(key => {
      const value = patch[key];
      if (!unwrap(value)) next[key] = value;
      else if (value.__jora === 'increment') next[key] = Number(before[key] || 0) + value.value;
      else if (value.__jora === 'arrayUnion') {
        const existing = Array.isArray(before[key]) ? before[key] : [];
        next[key] = existing.some(item => JSON.stringify(item) === JSON.stringify(value.value)) ? existing : existing.concat([value.value]);
      }
    });
    return next;
  }
  function wrapUser(user) {
    return user && { uid: user.id, email: user.email, isAnonymous: false,
      updateProfile: async ({ displayName }) => { const r = await client.auth.updateUser({ data: { display_name: displayName || '' } }); if (r.error) fail(r.error); },
      delete: async () => { const r = await client.rpc('delete_my_account'); if (r.error) fail(r.error); },
      getIdToken: async () => (await client.auth.getSession()).data.session?.access_token };
  }
  const auth = { _user: null,
    get currentUser() { return wrapUser(this._user); },
    async createUserWithEmailAndPassword(email, password) { const r = await client.auth.signUp({ email, password, options: { emailRedirectTo: 'https://jorapartner.vercel.app/' } }); if (r.error) fail(r.error); this._user = r.data.user; if (!r.data.session) { const e = new Error('Account created. Confirm your email, then sign in.'); e.code = 'auth/email-confirmation-required'; throw e; } return { user: wrapUser(r.data.user) }; },
    async signInWithEmailAndPassword(email, password) { const r = await client.auth.signInWithPassword({ email, password }); if (r.error) fail(r.error); this._user = r.data.user; return { user: wrapUser(r.data.user) }; },
    async signOut() { const r = await client.auth.signOut(); if (r.error) fail(r.error); this._user = null; },
    onAuthStateChanged(callback) { client.auth.getUser().then(r => { auth._user = r.data.user; callback(wrapUser(r.data.user)); }); const sub = client.auth.onAuthStateChange((_event, session) => { auth._user = session && session.user; callback(wrapUser(auth._user)); }).data.subscription; return () => sub.unsubscribe(); }
  };
  const orderStatus = value => ({ 'confirmed': 'confirmed', 'packed': 'packed', 'ready for pickup': 'handed_to_delivery_partner', 'out for delivery': 'out_for_delivery', 'delivered': 'delivered', 'cancelled': 'cancelled', 'refunded': 'refunded', 'placed': 'placed' }[String(value || '').toLowerCase()] || undefined);
  const legacyStatus = { placed: 'Confirmed', confirmed: 'Confirmed', packed: 'Packed', handed_to_delivery_partner: 'Ready for Pickup', out_for_delivery: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };
  function presence(row) { return row && { id: row.id, uid: row.id, firstName: (row.full_name || 'Delivery Partner').split(' ')[0], lastName: (row.full_name || '').split(' ').slice(1).join(' '), phone: row.phone, vehicle: row.vehicle, photo: row.photo_url, lat: row.latitude, lng: row.longitude, locationAccuracy: row.location_accuracy, locationUpdatedAt: row.location_updated_at, isOnline: row.is_online, activeOrderId: row.active_order_id, updatedAt: row.updated_at }; }
  function order(row) { if (!row) return row; const first = Array.isArray(row.items) ? row.items[0] || {} : {}; return Object.assign({}, row.data || {}, { id: row.id, customerUid: row.customer_id, vendorUid: row.vendor_id, shopId: row.shop_id, shopName: row.shop_name, shopLat: row.shop_lat, shopLng: row.shop_lng, deliveryAddress: row.delivery_address, deliveryLat: row.delivery_lat, deliveryLng: row.delivery_lng, deliveryFee: row.delivery_fee, paymentMethod: row.payment_method, paymentStatus: row.payment_status, deliveryPartnerId: row.rider_id, deliveryPartnerUid: row.rider_id, riderLat: row.rider_lat, riderLng: row.rider_lng, riderLocationAccuracy: row.rider_location_accuracy, riderLocationUpdatedAt: row.rider_location_updated_at, productName: first.name || 'Customer order', category: first.category || '', image: first.image || '', price: Number(first.price || 0), qty: Number(first.qty || 1), orderedAt: row.created_at, createdAt: row.created_at, updatedAt: row.updated_at, deliveredAt: row.delivered_at, cancelledAt: row.cancelled_at, status: legacyStatus[row.status] || row.status }); }
  async function readDocument(collection, id) { const r = await client.from('jora_documents').select('data').eq('collection', collection).eq('id', id).maybeSingle(); if (r.error) fail(r.error); return r.data && r.data.data; }
  async function writeDocument(collection, id, data) { if (!auth.currentUser) throw new Error('Sign in required'); const r = await client.from('jora_documents').upsert({ collection, id, data, updated_at: now() }, { onConflict: 'collection,id' }); if (r.error) fail(r.error); }
  function Snap(id, data) { this.id = id; this.exists = Boolean(data); this.data = () => clone(data); }
  class Ref { constructor(collection, id) { this.collection = collection; this.id = id; }
    async get() { if (this.collection === 'orders') { const r = await client.from('orders').select('*').eq('id', this.id).maybeSingle(); if (r.error) fail(r.error); return new Snap(this.id, order(r.data)); } return new Snap(this.id, await readDocument(this.collection, this.id)); }
    async set(data, options) { const current = options && options.merge ? (await this.get()).data() || {} : {}; if (this.collection === 'orders') return this.update(Object.assign({}, current, data)); if (this.collection === 'delivery_partners') return writeDocument('delivery_partners', this.id, Object.assign({}, current, data)); return writeDocument(this.collection, this.id, Object.assign({}, current, data)); }
    async update(patch) { const snap = await this.get(); if (!snap.exists) throw new Error('Document not found'); const next = mergePatch(snap.data(), patch); if (this.collection === 'orders') { const data = Object.assign({}, next); const core = { status: orderStatus(data.status), rider_id: data.deliveryPartnerId || data.deliveryPartnerUid, rider_lat: data.riderLat, rider_lng: data.riderLng, rider_location_accuracy: data.riderLocationAccuracy, rider_location_updated_at: data.riderLocationUpdatedAt, delivered_at: data.deliveredAt, cancelled_at: data.cancelledAt, updated_at: now(), data }; Object.keys(core).forEach(k => core[k] === undefined && delete core[k]); const r = await client.from('orders').update(core).eq('id', this.id); if (r.error) fail(r.error); return; } return writeDocument(this.collection, this.id, next); }
    onSnapshot(ok, bad) { let live = true; const run = () => this.get().then(s => live && ok(s)).catch(e => bad && bad(e)); run(); const table = this.collection === 'orders' ? 'orders' : 'jora_documents'; const filter = 'id=eq.' + this.id; const channel = client.channel('jora-ref-' + Math.random()).on('postgres_changes', { event: '*', schema: 'public', table, filter }, run).subscribe(); return () => { live = false; client.removeChannel(channel); }; }
  }
  class Query { constructor(collection, filters) { this.collection = collection; this.filters = filters || []; } doc(id) { return new Ref(this.collection, id); } where(key, op, value) { if (op !== '==') throw new Error('Only equality queries are supported'); return new Query(this.collection, this.filters.concat([[key, value]])); }
    async get() { let rows; if (this.collection === 'orders') { const r = await client.from('orders').select('*'); if (r.error) fail(r.error); rows = (r.data || []).map(order); } else { const r = await client.from('jora_documents').select('id,data').eq('collection', this.collection); if (r.error) fail(r.error); rows = (r.data || []).map(x => Object.assign({ id: x.id }, x.data)); } rows = rows.filter(row => this.filters.every(([key, value]) => row && row[key] === value)); return { docs: rows.map(row => new Snap(row.id, row)), forEach: fn => rows.forEach(row => fn(new Snap(row.id, row))) }; }
    onSnapshot(ok, bad) { let live = true; const run = () => this.get().then(s => live && ok(s)).catch(e => bad && bad(e)); run(); const table = this.collection === 'orders' ? 'orders' : 'jora_documents'; const channel = client.channel('jora-query-' + Math.random()).on('postgres_changes', { event: '*', schema: 'public', table }, run).subscribe(); return () => { live = false; client.removeChannel(channel); }; }
  }
  const db = { collection: name => new Query(name), runTransaction: async work => work({ get: ref => ref.get(), update: (ref, patch) => ref.update(patch), set: (ref, data) => ref.set(data) }) };
  window.firebase = { firestore: { FieldValue } };
  window.JoraSupabase = { client, db, auth, supabaseCompat: { FieldValue } };
}());
