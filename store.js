/* ======================================================================
   Just Grace — camada de dados (localStorage)
   Usada pela loja (index.html) e pelo painel de gestão (gestao.html).
   ====================================================================== */
(function(){

  const KEYS = {
    products: 'jg_products',
    orders: 'jg_orders',
    customers: 'jg_customers',
    users: 'jg_users',
    delivery: 'jg_delivery_fees',
    waitlist: 'jg_waitlist',
    expenses: 'jg_expenses',
    session: 'jg_session',
    audit: 'jg_audit',
    seeded: 'jg_seeded_v1',
  };

  /* ----------------------------------------------------------------
     Sincronização remota dos pedidos (Google Apps Script)
     Preencha apiUrl e token depois de implantar o Code.gs como Web App.
     Enquanto apiUrl estiver vazio, o sistema funciona só com localStorage,
     como antes.
     ---------------------------------------------------------------- */
  const SYNC_CONFIG = {
    apiUrl: 'https://script.google.com/macros/s/AKfycbyGcxOsLFyuf6r05ZHuJEv97nLUPfH-m04_kRtCkDtmsGrygS7psmzfJ4-ObmHRdqUJWA/exec',
    token: 'jgSec9rX4mNqT2wZ',
  };

  function isSyncConfigured(){
    return !!(SYNC_CONFIG.apiUrl && SYNC_CONFIG.token);
  }

  /* ----------------------------------------------------------------
     O Google Apps Script nem sempre devolve os cabeçalhos de CORS que
     fetch()/XMLHttpRequest exigem para leitura entre sites diferentes
     — isso quebra em qualquer navegador, não é específico de nenhum.
     Para contornar de vez, usamos duas técnicas mais antigas que nunca
     dependeram de CORS:
     - LEITURA: JSONP (uma tag <script> carregando a URL — scripts nunca
       são bloqueados por CORS).
     - ESCRITA: um <form> de verdade enviado para um <iframe> escondido
       (formulários HTML também nunca foram bloqueados por CORS).
     ---------------------------------------------------------------- */
  let jsonpCounter = 0;
  function jsonpRequest(url, timeoutMs){
    return new Promise((resolve, reject) => {
      const cbName = 'jgCallback_' + (Date.now()) + '_' + (jsonpCounter++);
      const script = document.createElement('script');
      let settled = false;
      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        cleanup();
        reject(new Error('tempo esgotado'));
      }, timeoutMs || 20000);
      function cleanup(){
        clearTimeout(timer);
        delete window[cbName];
        if(script.parentNode) script.parentNode.removeChild(script);
      }
      window[cbName] = (data) => {
        if(settled) return;
        settled = true;
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        if(settled) return;
        settled = true;
        cleanup();
        reject(new Error('falha ao carregar'));
      };
      script.src = url + (url.indexOf('?') > -1 ? '&' : '?') + 'callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  function formPostRequest(url, fields){
    return new Promise((resolve) => {
      const frameName = 'jg_frame_' + Date.now() + '_' + (jsonpCounter++);
      const iframe = document.createElement('iframe');
      iframe.name = frameName;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      const form = document.createElement('form');
      form.action = url;
      form.method = 'POST';
      form.target = frameName;
      form.style.display = 'none';
      Object.keys(fields).forEach(key => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = fields[key];
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();

      // fire-and-forget: não dá pra ler a resposta de um iframe de outra
      // origem, mas o envio em si não é bloqueado por CORS.
      setTimeout(() => {
        form.remove();
        iframe.remove();
        resolve(true);
      }, 4000);
    });
  }

  async function pushListToServer(type, list){
    if(!isSyncConfigured()) return;
    try{
      await formPostRequest(SYNC_CONFIG.apiUrl, {
        token: SYNC_CONFIG.token,
        type: type,
        [type]: JSON.stringify(list),
      });
    }catch(err){
      console.warn('Just Grace: não foi possível sincronizar "' + type + '" com o servidor.', err);
    }
  }
  async function pullListFromServer(type, key){
    if(!isSyncConfigured()) return null;
    try{
      const data = await jsonpRequest(SYNC_CONFIG.apiUrl + '?token=' + encodeURIComponent(SYNC_CONFIG.token) + '&type=' + type);
      if(data && Array.isArray(data[type])){
        const existing = read(key, []);
        if(data[type].length === 0 && existing.length > 0){
          // proteção: nunca apaga dados locais válidos com uma resposta vazia
          // do servidor (evita perder tudo antes do primeiro envio, por ex.).
          // Reenvia o que já temos localmente, pra corrigir o servidor também.
          if(type === 'orders' || type === 'customers' || type === 'waitlist') pushMerge(type, existing, []);
          else pushListToServer(type, existing);
          return existing;
        }
        if(type === 'orders' || type === 'customers' || type === 'waitlist'){
          // nunca perde dados: o que existe só neste aparelho é devolvido ao servidor (cura pedidos que
          // ficaram de fora) e mantido na lista local junto com o que veio do servidor.
          const serverIds = {};
          data[type].forEach(x => { if(x && x.id) serverIds[x.id] = 1; });
          const localOnly = existing.filter(x => x && x.id && !serverIds[x.id]);
          window.__jgServerCount = window.__jgServerCount || {};
          window.__jgServerCount[type] = data[type].length;
          const merged = data[type].concat(localOnly);
          if(type !== 'customers') merged.sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
          write(key, merged);
          if(localOnly.length) pushMerge(type, localOnly, []);
          return merged;
        }
        write(key, data[type]);
        return data[type];
      }
    }catch(err){
      console.warn('Just Grace: não foi possível buscar "' + type + '" do servidor.', err);
    }
    return null;
  }

  // Envia só o que mudou (novos/alterados/removidos) — o servidor mescla com o que já existe.
  // Assim, vários clientes e o painel de gestão nunca apagam os pedidos uns dos outros.
  function diffList(prev, next){
    const prevMap = {};
    (prev || []).forEach(x => { if(x && x.id) prevMap[x.id] = JSON.stringify(x); });
    const nextIds = {};
    const changed = [];
    (next || []).forEach(x => {
      if(!x || !x.id) return;
      nextIds[x.id] = 1;
      if(prevMap[x.id] !== JSON.stringify(x)) changed.push(x);
    });
    const removed = Object.keys(prevMap).filter(id => !nextIds[id]);
    return { changed, removed };
  }
  // Envio "sobrevivente": usa fetch com keepalive (continua mesmo se o cliente fechar a página ou for
  // para o WhatsApp/Mercado Pago logo em seguida). Se não houver suporte, cai no envio por formulário.
  async function sendMergeRequest(fields){
    try{
      if(typeof fetch === 'function'){
        await fetch(SYNC_CONFIG.apiUrl, {
          method: 'POST',
          mode: 'no-cors',
          keepalive: true,
          body: new URLSearchParams(fields),
        });
        return true;
      }
    }catch(err){ /* tenta o formulário */ }
    return formPostRequest(SYNC_CONFIG.apiUrl, fields);
  }

  // Fila de pedidos ainda não confirmados no servidor (reenvio automático, sem risco de duplicar:
  // o servidor atualiza pelo número do pedido).
  const PENDING_KEY = 'jg_pending_orders';
  function readPending(){ return read(PENDING_KEY, []); }
  function writePending(list){ try{ localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }catch(e){} }
  function queuePending(order, stock){
    const list = readPending().filter(p => p.order.id !== order.id);
    list.push({ order, stock: stock || [], at: Date.now() });
    writePending(list);
  }
  let flushing = false;
  async function flushPending(){
    if(!isSyncConfigured() || flushing) return;
    flushing = true;
    try{ await flushPendingInner(); } finally { flushing = false; }
  }
  async function flushPendingInner(){
    const pending = readPending();
    if(!pending.length) return;
    let serverOrders = null;
    try{
      const data = await jsonpRequest(SYNC_CONFIG.apiUrl + '?token=' + encodeURIComponent(SYNC_CONFIG.token) + '&type=orders', 20000);
      if(data && Array.isArray(data.orders)) serverOrders = data.orders;
    }catch(err){ return; }
    if(!serverOrders) return;
    const have = {};
    serverOrders.forEach(o => { have[o.id] = 1; });
    const still = [];
    for(const p of pending){
      if(have[p.order.id]) continue; // já está salvo no servidor
      still.push(p);
      // ainda não chegou: reenvia (sem baixar o estoque de novo — isso foi feito no 1º envio bem-sucedido)
      await sendMergeRequest({
        token: SYNC_CONFIG.token, type: 'merge', action: 'merge', target: 'orders',
        items: JSON.stringify([p.order]), removed: '[]', stock: JSON.stringify(p.stock || []),
      });
    }
    writePending(still);
    if(still.length) setTimeout(flushPending, 15000);
  }
  async function pushMerge(target, items, removed, stock){
    if(!isSyncConfigured()) return;
    if(!(items && items.length) && !(removed && removed.length) && !(stock && stock.length)) return;
    if(target === 'orders' && items && items.length === 1 && stock && stock.length) queuePending(items[0], stock);
    try{
      await sendMergeRequest({
        token: SYNC_CONFIG.token,
        type: 'merge',
        action: 'merge',
        target: target,
        items: JSON.stringify(items || []),
        removed: JSON.stringify(removed || []),
        stock: JSON.stringify(stock || []),
      });
    }catch(err){
      console.warn('Just Grace: não foi possível sincronizar "' + target + '" com o servidor.', err);
    }
    if(target === 'orders' && stock && stock.length) setTimeout(flushPending, 8000);
  }
  function saveMerged(key, target, list){
    const prev = read(key, []);
    write(key, list);
    const d = diffList(prev, list);
    return pushMerge(target, d.changed, d.removed);
  }

  const pushOrdersToServer    = (list) => pushListToServer('orders', list);
  const pullOrdersFromServer  = ()     => pullListFromServer('orders', KEYS.orders);
  const pushCustomersToServer = (list) => pushListToServer('customers', list);
  const pullCustomersFromServer = ()   => pullListFromServer('customers', KEYS.customers);
  const pushWaitlistToServer  = (list) => pushListToServer('waitlist', list);
  const pullWaitlistFromServer = ()    => pullListFromServer('waitlist', KEYS.waitlist);
  const pushProductsToServer  = (list) => pushListToServer('products', list);
  const pullProductsFromServer = ()    => pullListFromServer('products', KEYS.products);
  const pushDeliveryToServer  = (list) => pushListToServer('delivery', list);
  const pullDeliveryFromServer = ()    => pullListFromServer('delivery', KEYS.delivery);
  const pushExpensesToServer  = (list) => pushListToServer('expenses', list);
  const pullExpensesFromServer = ()    => pullListFromServer('expenses', KEYS.expenses);
  const pushUsersToServer     = (list) => pushListToServer('users', list);
  const pullUsersFromServer   = ()     => pullListFromServer('users', KEYS.users);

  // pede ao Apps Script para abrir um pagamento online (PIX ou cartão via Mercado Pago).
  // method: 'pix' ou 'card' — restringe a forma de pagamento na página do Mercado Pago.
  // Só funciona depois que o token do Mercado Pago for configurado no Code.gs.
  async function requestOnlinePayment(order, method){
    if(!isSyncConfigured()){
      return { error: 'Sincronização remota não configurada.' };
    }
    const successUrl = window.location.origin + window.location.pathname;
    const url = SYNC_CONFIG.apiUrl
      + '?action=createPayment'
      + '&token=' + encodeURIComponent(SYNC_CONFIG.token)
      + '&method=' + encodeURIComponent(method || 'both')
      + '&successUrl=' + encodeURIComponent(successUrl)
      + '&payload=' + encodeURIComponent(JSON.stringify(order));
    try{
      return await jsonpRequest(url, 25000);
    }catch(err){
      return { error: 'Falha de conexão com o servidor de pagamento: ' + (err && err.message ? err.message : 'erro de rede') };
    }
  }

  function read(key, fallback){
    try{
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(e){
      return fallback;
    }
  }
  function write(key, value){
    try{
      localStorage.setItem(key, JSON.stringify(value));
    }catch(err){
      console.warn('Just Grace: armazenamento do navegador cheio.', err);
      if(typeof window !== 'undefined' && window.alert && key.indexOf('product') !== -1){
        window.alert('O armazenamento do navegador está cheio. Remova fotos pesadas de alguns produtos ou use fotos menores.');
      }
    }
  }

  function uid(prefix){
    return (prefix ? prefix + '_' : '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // gera um número de pedido sequencial e legível (PED-0001, PED-0002...),
  // olhando o maior número já usado entre os pedidos existentes.
  // normaliza o campo "sizes" para sempre virar uma lista de {label, stock},
  // aceitando também o formato antigo (lista de textos, com estoque único
  // no produto inteiro), pra não quebrar produtos já cadastrados.
  function normalizeSizes(product){
    if(!product || !product.sizes || !product.sizes.length){
      return [{ label: 'Único', stock: product && product.stockQuantity != null ? product.stockQuantity : 0 }];
    }
    if(typeof product.sizes[0] === 'object'){
      return product.sizes;
    }
    // formato antigo: lista de textos + um estoque único pra tudo
    const total = product.stockQuantity || 0;
    return product.sizes.map(label => ({ label, stock: total }));
  }
  function productTotalStock(product){
    return normalizeSizes(product).reduce((s, sz) => s + (sz.stock || 0), 0);
  }
  // ajusta o estoque de um tamanho específico (delta pode ser negativo).
  // se o tamanho não for informado/encontrado, ajusta o primeiro da lista.
  function adjustStock(product, delta, sizeLabel){
    const sizes = normalizeSizes(product);
    let target = sizeLabel ? sizes.find(s => s.label === sizeLabel) : null;
    if(!target) target = sizes[0];
    if(target) target.stock = Math.max(0, (target.stock || 0) + delta);
    product.sizes = sizes;
    return product;
  }

  function nextOrderId(orders){
    let max = 0;
    (orders || []).forEach(o => {
      const match = /^PED-(\d+)$/.exec(o.id || '');
      if(match){
        const n = parseInt(match[1], 10);
        if(n > max) max = n;
      }
    });
    return 'PED-' + String(max + 1).padStart(4, '0');
  }
  // id único para pedidos da loja: dois clientes em aparelhos diferentes nunca geram o mesmo número
  function storeOrderId(){
    return 'PED-' + String(Math.floor(Date.now()/1000) % 1000000).padStart(6, '0');
  }
  function nowISO(){ return new Date().toISOString(); }
  function money(cents){
    return 'R$ ' + ((cents||0) / 100).toFixed(2).replace('.', ',');
  }

  const orderStatusLabels = {
    payment_pending: 'Aguardando pagamento',
    paid: 'Pagamento Confirmado',
    preparing: 'Produto em Separação',
    shipped: 'A Caminho',
    fulfilled: 'Entregue',
    cancelled: 'Cancelado',
    payment_error: 'Erro no pagamento',
    payment_expired: 'Pagamento expirado',
    payment_cancelled: 'Pagamento cancelado',
  };
  function orderStatusLabel(status){
    return orderStatusLabels[status] || status;
  }

  /* ---------------- seed inicial (roda uma única vez) ---------------- */
  function seedIfNeeded(){
    if(read(KEYS.seeded, false)) return;

    const defaultUsers = [
      {
        id: uid('u'),
        name: 'Administrador',
        email: 'admin@justgrace.com.br',
        password: 'justgrace123',
        role: 'admin',
        status: 'active',
        permissions: ['orders_manage','products_manage','stock_manage','delivery_manage','users_manage','finance_manage'],
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
      {
        id: uid('u'),
        name: 'Pedro Pires Neves',
        email: 'pedropiresneves@hotmail.com',
        password: 'Peu19012003',
        role: 'admin',
        status: 'active',
        permissions: ['orders_manage','products_manage','stock_manage','delivery_manage','users_manage','finance_manage'],
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
    ];

    const svgPlaceholder = '<circle cx="50" cy="50" r="28" stroke="#f3ede1" stroke-width="2" fill="none"/><path d="M38 42 L50 30 L62 42" stroke="#f3ede1" stroke-width="2" fill="none" stroke-linecap="round"/>';

    const defaultProducts = [
      { id:uid('p'), cat:'basicas', tag:'Camiseta', name:'Camiseta Graça Essencial', desc:'Algodão penteado, corte reto, estampa minimalista.', priceCents:8900, status:'active', sku:'JG-BAS-001', svg:svgPlaceholder, images:['https://placehold.co/500x500/070706/f3ede1?text=Camiseta+Preta&font=montserrat'], sizes:[{label:'P',stock:3},{label:'M',stock:5},{label:'G',stock:3},{label:'GG',stock:1}] },
      { id:uid('p'), cat:'basicas', tag:'Camiseta', name:'Camiseta Fé em Movimento', desc:'Malha macia, silk artesanal no peito.', priceCents:9400, status:'active', sku:'JG-BAS-002', svg:svgPlaceholder, images:['https://placehold.co/500x500/f3ede1/070706?text=Camiseta+Off-White&font=montserrat'], sizes:[{label:'P',stock:2},{label:'M',stock:4},{label:'G',stock:2},{label:'GG',stock:0}] },
      { id:uid('p'), cat:'duopima', tag:'Duo Pima', name:'Camiseta Duo Pima Propósito', desc:'Algodão Pima premium, toque macio e caimento superior.', priceCents:12900, status:'active', sku:'JG-DUO-001', svg:svgPlaceholder, images:[], sizes:[{label:'P',stock:1},{label:'M',stock:2},{label:'G',stock:2},{label:'GG',stock:0}] },
      { id:uid('p'), cat:'duopima', tag:'Duo Pima', name:'Camiseta Duo Pima A Graça Basta', desc:'Edição limitada, bordado discreto.', priceCents:13900, status:'active', sku:'JG-DUO-002', svg:svgPlaceholder, images:[], sizes:[{label:'P',stock:0},{label:'M',stock:0},{label:'G',stock:0},{label:'GG',stock:0}] },
    ];

    const defaultDelivery = [
      { id:1, zone:'Zona Sul', neighborhood:'Cabedelo Centro', feeCents:800 },
      { id:2, zone:'Zona Sul', neighborhood:'Intermares', feeCents:1000 },
      { id:3, zone:'João Pessoa', neighborhood:'Bessa', feeCents:1200 },
      { id:4, zone:'João Pessoa', neighborhood:'Tambaú', feeCents:1500 },
      { id:5, zone:'Outras cidades', neighborhood:'Combinar via WhatsApp', feeCents:0 },
    ];

    write(KEYS.users, defaultUsers);
    write(KEYS.products, defaultProducts);
    write(KEYS.orders, []);
    write(KEYS.customers, []);
    write(KEYS.delivery, defaultDelivery);
    write(KEYS.audit, []);
    write(KEYS.seeded, true);
  }
  seedIfNeeded();

  /* garante que o login pessoal exista mesmo se o localStorage já tinha
     sido semeado antes (ex.: versão anterior sem esse usuário) */
  function ensurePersonalUser(){
    const users = read(KEYS.users, []);
    const exists = users.some(u => u.email.toLowerCase() === 'pedropiresneves@hotmail.com');
    if(!exists){
      users.unshift({
        id: uid('u'),
        name: 'Pedro Pires Neves',
        email: 'pedropiresneves@hotmail.com',
        password: 'Peu19012003',
        role: 'admin',
        status: 'active',
        permissions: ['orders_manage','products_manage','stock_manage','delivery_manage','users_manage','finance_manage'],
        createdAt: nowISO(),
        updatedAt: nowISO(),
      });
      write(KEYS.users, users);
    }
  }
  ensurePersonalUser();

  /* ---------------- API pública ---------------- */
  const JGStore = {
    KEYS,
    read,
    write,
    uid,
    nowISO,
    money,
    orderStatusLabel,
    nextOrderId,
    normalizeSizes,
    productTotalStock,
    adjustStock,

    // produtos
    getProducts(){ return read(KEYS.products, []); },
    saveProducts(list){ write(KEYS.products, list); pushProductsToServer(list); },

    // pedidos
    getOrders(){ return read(KEYS.orders, []); },
    saveOrders(list){ return saveMerged(KEYS.orders, 'orders', list); },

    // clientes
    getCustomers(){ return read(KEYS.customers, []); },
    saveCustomers(list){ return saveMerged(KEYS.customers, 'customers', list); },

    // lista de espera ("avise-me")
    getWaitlist(){ return read(KEYS.waitlist, []); },
    saveWaitlist(list){ return saveMerged(KEYS.waitlist, 'waitlist', list); },
    addWaitlistEntry({ productName, customerName, customerPhone }){
      const list = this.getWaitlist();
      list.unshift({
        id: uid('esp'),
        productName, customerName, customerPhone,
        status: 'pending',
        createdAt: nowISO(),
      });
      this.saveWaitlist(list);
      this.addAudit('waitlist_add', `${customerName} quer ser avisado(a) sobre "${productName}".`, 'Loja');
      return list[0];
    },

    // sincronização remota (Google Apps Script)
    isSyncConfigured,
    syncOrders: pullOrdersFromServer,
    syncCustomers: pullCustomersFromServer,
    syncWaitlist: pullWaitlistFromServer,
    SYNC_CONFIG: SYNC_CONFIG,
    // força o envio de TODOS os pedidos deste aparelho para a planilha (seguro: só adiciona/atualiza)
    saveAllOrdersToCloud(){ const all = read(KEYS.orders, []); return pushMerge('orders', all, []).then(()=>all.length); },
    syncProducts: pullProductsFromServer,
    syncDelivery: pullDeliveryFromServer,
    syncExpenses: pullExpensesFromServer,
    syncUsers: pullUsersFromServer,
    requestOnlinePayment,

    // usuários
    getUsers(){ return read(KEYS.users, []); },
    saveUsers(list){ write(KEYS.users, list); pushUsersToServer(list); },

    // fretes
    getDeliveryFees(){ return read(KEYS.delivery, []); },
    saveDeliveryFees(list){ write(KEYS.delivery, list); pushDeliveryToServer(list); },

    // financeiro (custos e despesas)
    getExpenses(){ return read(KEYS.expenses, []); },
    saveExpenses(list){ write(KEYS.expenses, list); pushExpensesToServer(list); },
    addExpense({ description, category, amountCents, date, notes }){
      const list = this.getExpenses();
      const entry = {
        id: uid('desp'),
        description, category: category || 'Outros',
        amountCents: amountCents || 0,
        date: date || nowISO().slice(0,10),
        notes: notes || '',
        createdAt: nowISO(),
      };
      list.unshift(entry);
      this.saveExpenses(list);
      this.addAudit('expense_add', `Despesa registrada: ${description} (${money(amountCents)}).`, 'Painel');
      return entry;
    },

    // calcula o frete a partir do texto do bairro digitado pelo cliente
    quoteDelivery(neighborhoodText){
      const fees = this.getDeliveryFees();
      const term = (neighborhoodText || '').trim().toLowerCase();
      if(!term) return null;
      const hit = fees.find(f => f.neighborhood && f.neighborhood.toLowerCase().includes(term))
        || fees.find(f => term.includes((f.neighborhood||'').toLowerCase()) && f.neighborhood);
      if(hit) return { zone: hit.zone, neighborhood: hit.neighborhood, feeCents: hit.feeCents, matched: true };
      // não encontrou bairro atendido — cai no combinar via WhatsApp, se existir
      const fallback = fees.find(f => /combinar/i.test(f.neighborhood || '') || /outra/i.test(f.zone || ''));
      if(fallback) return { zone: fallback.zone, neighborhood: fallback.neighborhood, feeCents: 0, matched: false };
      return { zone: '', neighborhood: neighborhoodText, feeCents: 0, matched: false };
    },

    // sessão
    getSession(){ return read(KEYS.session, null); },
    setSession(session){ write(KEYS.session, session); },
    clearSession(){ localStorage.removeItem(KEYS.session); },

    // auditoria
    addAudit(action, detail, actor){
      const audit = read(KEYS.audit, []);
      audit.unshift({ id: uid('a'), action, detail, actor, createdAt: nowISO() });
      write(KEYS.audit, audit.slice(0, 500));
    },

    // usado pela loja ao finalizar um pedido
    createStoreOrder({ customerName, customerPhone, customerEmail, items, address, deliveryFeeCents, paymentMethod }){
      const orders = this.getOrders();
      const products = this.getProducts();

      const orderItems = items.map(i => ({ name:i.name, size:i.size||'', price:i.price, qty:i.qty, subtotalCents: Math.round(i.price*100)*i.qty }));
      const productsCents = orderItems.reduce((s,i)=> s + i.subtotalCents, 0);
      const feeCents = deliveryFeeCents || 0;
      const totalCents = productsCents + feeCents;

      const order = {
        id: storeOrderId(),
        customerName,
        customerPhone,
        customerEmail: customerEmail || '',
        address: address || null,
        items: orderItems,
        productsCents,
        deliveryFeeCents: feeCents,
        totalCents,
        status: 'payment_pending',
        paymentMethod: paymentMethod || '',
        events: [{ id:uid('ev'), label:'Pedido recebido pela loja online', actor:'Loja', createdAt: nowISO() }],
        createdAt: nowISO(),
      };
      orders.unshift(order);
      write(KEYS.orders, orders);

      // baixa estoque, do tamanho específico comprado (localmente aqui; no servidor junto com o pedido)
      orderItems.forEach(oi=>{
        const p = products.find(pp => pp.name === oi.name);
        if(!p) return;
        p.sizes = normalizeSizes(p);
        const sz = p.sizes.find(s => s.label === (oi.size || 'Único'));
        if(sz) sz.stock = Math.max(0, (sz.stock || 0) - oi.qty);
      });
      write(KEYS.products, products);
      pushMerge('orders', [order], [], orderItems.map(oi => ({ name: oi.name, size: oi.size || '', qty: oi.qty })));

      // registra/atualiza cliente, guardando o último endereço usado
      const customers = this.getCustomers();
      let c = customers.find(cc => cc.phone === customerPhone);
      if(!c){
        c = { id: uid('cli'), name: customerName, phone: customerPhone, email:'', createdAt: nowISO(), internalNotes:'', nextContactAt:'', orders: [] };
        customers.unshift(c);
      }
      c.name = customerName || c.name;
      c.email = customerEmail || c.email;
      if(address) c.address = address;
      c.orders = c.orders || [];
      c.orders.unshift({ id: order.id, totalCents: order.totalCents, status: order.status, createdAt: order.createdAt });
      this.saveCustomers(customers);

      this.addAudit('order_create', `Novo pedido ${order.id} de ${customerName}.`, 'Loja');
      return order;
    },

    // busca um cliente já cadastrado pelo WhatsApp (usado no "já sou cliente")
    findCustomerByPhone(phone){
      const digits = (phone || '').replace(/\D/g, '');
      if(digits.length < 8) return null;
      return this.getCustomers().find(c => (c.phone || '').replace(/\D/g,'').endsWith(digits.slice(-8))) || null;
    },
  };

  window.JGStore = JGStore;
  setTimeout(flushPending, 3000); // confirma/reenvia pedidos que ainda não chegaram ao servidor
})();
