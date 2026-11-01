import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import QRCode from 'https://esm.sh/qrcode@1.5.4';
import { SUPABASE_CONFIG } from './config.js';

// 初始化 Supabase Client
const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

// 全域狀態管理
const state = {
  currentView: 'explore', // 'explore' | 'event-detail' | 'my-tickets' | 'admin' | 'checkin'
  adminTab: 'events',     // 'events' | 'registrations'
  user: null,
  profile: null,
  events: [],
  selectedEvent: null,
  selectedTicketId: null,
  myRegistrations: [],
  adminRegistrations: [],
  searchQuery: '',
  selectedCategory: '全部',
  adminEventFilter: 'all',
  adminStatusFilter: 'all',
  editingEvent: null,
  qrScanner: null,
  scannerRunning: false
};

// 工具函式：格式化日期時間
function formatDateTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatDateShort(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString('zh-TW', {
    month: 'short',
    day: 'numeric',
    weekday: 'short'
  });
}

function formatCurrency(num) {
  if (!num || num === 0) return '免費入場';
  return `NT$ ${Number(num).toLocaleString('zh-TW')}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  const bgMap = {
    success: 'bg-indigo-600 text-white border-indigo-500',
    error: 'bg-rose-600 text-white border-rose-500',
    info: 'bg-slate-800 text-white border-slate-700'
  };
  el.className = `px-4 py-3 rounded-xl shadow-lg border text-sm font-medium flex items-center gap-2 transition-all duration-300 transform translate-y-0 ${bgMap[type] || bgMap.info}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ============================================================================
// 1. 認證與會員資料載入
// ============================================================================
async function loadSessionAndProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  state.user = session?.user || null;
  if (state.user) {
    await ensureProfile();
  } else {
    state.profile = null;
  }
  renderNavbar();
}

async function ensureProfile() {
  if (!state.user) return;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', state.user.id)
    .maybeSingle();

  if (data) {
    state.profile = data;
  } else if (!error) {
    const fallbackName = state.user.user_metadata?.full_name || state.user.email?.split('@')[0] || '學員';
    const { data: inserted } = await supabase
      .from('profiles')
      .insert({
        id: state.user.id,
        email: state.user.email || '',
        full_name: fallbackName,
        phone: state.user.user_metadata?.phone || '',
        organization: state.user.user_metadata?.organization || '',
        role: 'admin'
      })
      .select('*')
      .single();
    state.profile = inserted;
  }
}

// ============================================================================
// 2. 資料讀取 (活動、票種、我的報名、後台報名名單)
// ============================================================================
export async function fetchEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('*, ticket_types(*)')
    .order('start_time', { ascending: true });

  if (error) {
    showToast('載入活動失敗：' + error.message, 'error');
    return;
  }

  state.events = (data || []).map(ev => ({
    ...ev,
    ticket_types: (ev.ticket_types || []).sort((a, b) => a.sort_order - b.sort_order)
  }));

  if (state.selectedEvent) {
    const updated = state.events.find(e => e.id === state.selectedEvent.id);
    if (updated) state.selectedEvent = updated;
  }
  renderMainView();
}

export async function fetchMyRegistrations() {
  if (!state.user) {
    state.myRegistrations = [];
    return;
  }
  const { data, error } = await supabase
    .from('registrations')
    .select('*, events(*), ticket_types(*)')
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false });

  if (!error && data) {
    state.myRegistrations = data;
  }
}

export async function fetchAdminRegistrations() {
  if (!state.user) return;
  const { data, error } = await supabase
    .from('registrations')
    .select('*, events(id, title, slug, custom_fields), ticket_types(id, name, price)')
    .order('created_at', { ascending: false });

  if (!error && data) {
    state.adminRegistrations = data;
  }
}

// ============================================================================
// 3. 畫面切換與導覽列渲染
// ============================================================================
export async function navigateTo(view, slug = null) {
  if (state.scannerRunning && view !== 'checkin') {
    await stopQrScanner();
  }

  state.currentView = view;
  if (view === 'event-detail' && slug) {
    const ev = state.events.find(e => e.slug === slug || e.id === slug);
    if (ev) {
      state.selectedEvent = ev;
      state.selectedTicketId = ev.ticket_types?.[0]?.id || null;
    }
  } else if (view === 'my-tickets') {
    await fetchMyRegistrations();
  } else if (view === 'admin' || view === 'checkin') {
    await Promise.all([fetchEvents(), fetchAdminRegistrations()]);
  }

  renderNavbar();
  renderMainView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderNavbar() {
  const navActions = document.getElementById('nav-user-actions');
  const navLinks = document.querySelectorAll('[data-nav-view]');

  navLinks.forEach(btn => {
    const v = btn.getAttribute('data-nav-view');
    if (v === state.currentView || (v === 'explore' && state.currentView === 'event-detail')) {
      btn.className = 'px-3.5 py-2 rounded-lg text-sm font-semibold bg-indigo-50 text-indigo-700 transition';
    } else {
      btn.className = 'px-3.5 py-2 rounded-lg text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-slate-50 transition';
    }
  });

  if (!navActions) return;
  if (state.user) {
    const displayName = state.profile?.full_name || state.user.email.split('@')[0];
    navActions.innerHTML = `
      <div class="flex items-center gap-2">
        <button onclick="window.app.openProfileModal()" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition">
          <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
          <span>${escapeHtml(displayName)}</span>
          <span class="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px]">管理員/會員</span>
        </button>
        <button onclick="window.app.signOut()" class="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition">
          登出
        </button>
      </div>
    `;
  } else {
    navActions.innerHTML = `
      <div class="flex items-center gap-2">
        <button onclick="window.app.openAuthModal('login')" class="px-4 py-2 rounded-xl text-sm font-semibold text-indigo-600 hover:bg-indigo-50 transition">
          會員登入
        </button>
        <button onclick="window.app.openAuthModal('signup')" class="px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm shadow-indigo-200 transition">
          免費註冊
        </button>
      </div>
    `;
  }
}

function renderMainView() {
  const container = document.getElementById('app-root');
  if (!container) return;

  switch (state.currentView) {
    case 'explore':
      container.innerHTML = renderExploreView();
      break;
    case 'event-detail':
      container.innerHTML = renderEventDetailView();
      break;
    case 'my-tickets':
      container.innerHTML = renderMyTicketsView();
      break;
    case 'admin':
      container.innerHTML = renderAdminView();
      break;
    case 'checkin':
      container.innerHTML = renderCheckinView();
      break;
    default:
      container.innerHTML = renderExploreView();
  }
}

// ============================================================================
// 4. 公開前台：探索活動列表 (Explore View)
// ============================================================================
function renderExploreView() {
  const categories = ['全部', '講座', '工作坊', '課程', '論壇', '社群聚會'];
  const visibleEvents = state.events.filter(ev => {
    if (ev.status === 'draft') return false;
    const matchCat = state.selectedCategory === '全部' || ev.category === state.selectedCategory;
    const q = state.searchQuery.trim().toLowerCase();
    const matchQuery = !q ||
      ev.title.toLowerCase().includes(q) ||
      ev.subtitle.toLowerCase().includes(q) ||
      ev.location.toLowerCase().includes(q) ||
      ev.speaker_name.toLowerCase().includes(q);
    return matchCat && matchQuery;
  });

  return `
    <!-- Hero 視覺區 -->
    <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-950 via-indigo-900 to-blue-900 text-white p-8 md:p-12 mb-10 shadow-xl">
      <div class="relative z-10 max-w-3xl">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/20 border border-indigo-400/30 text-indigo-200 text-xs font-semibold mb-4">
          <span>GitHub + Vercel + Supabase 雲端即時報名系統</span>
        </div>
        <h1 class="text-3xl md:text-5xl font-extrabold tracking-tight leading-tight mb-4">
          探索精彩講座與實戰工作坊
        </h1>
        <p class="text-indigo-100/90 text-base md:text-lg mb-8 leading-relaxed">
          一站式完成活動線上報名、會員票夾管理、匯款回報審核與現場 QR Code 快速電子簽到。
        </p>

        <!-- 搜尋列 -->
        <div class="flex flex-col sm:flex-row gap-3 bg-white/10 backdrop-blur-md p-2 rounded-2xl border border-white/15">
          <input
            type="text"
            placeholder="搜尋活動名稱、講師或地點關鍵字..."
            value="${escapeHtml(state.searchQuery)}"
            oninput="window.app.setSearchQuery(this.value)"
            class="flex-1 bg-transparent px-4 py-2.5 text-white placeholder-indigo-200/70 focus:outline-none text-sm"
          />
          <button onclick="window.app.setSearchQuery('')" class="px-5 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white font-semibold text-sm transition">
            搜尋活動
          </button>
        </div>
      </div>
    </section>

    <!-- 分類篩選列 -->
    <div class="flex flex-wrap items-center justify-between gap-4 mb-8">
      <div class="flex flex-wrap items-center gap-2">
        ${categories.map(cat => `
          <button
            onclick="window.app.setCategory('${cat}')"
            class="px-4 py-2 rounded-xl text-sm font-semibold transition ${
              state.selectedCategory === cat
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-300 hover:text-indigo-600'
            }"
          >
            ${cat}
          </button>
        `).join('')}
      </div>
      <div class="text-sm text-slate-500">
        共找到 <span class="font-bold text-indigo-600">${visibleEvents.length}</span> 場開放活動
      </div>
    </div>

    <!-- 活動卡片網格 -->
    ${visibleEvents.length === 0 ? `
      <div class="bg-white rounded-3xl border border-slate-200 p-12 text-center">
        <p class="text-slate-500 text-base mb-4">找不到符合條件的活動</p>
        <button onclick="window.app.resetFilter()" class="px-4 py-2 rounded-xl bg-indigo-50 text-indigo-600 font-semibold text-sm">
          重設篩選條件
        </button>
      </div>
    ` : `
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${visibleEvents.map(ev => renderEventCard(ev)).join('')}
      </div>
    `}
  `;
}

function renderEventCard(ev) {
  const tickets = ev.ticket_types || [];
  const prices = tickets.map(t => t.price);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const totalQuota = tickets.reduce((acc, t) => acc + (t.quota || 0), 0);
  const totalReg = tickets.reduce((acc, t) => acc + (t.registered_count || 0), 0);
  const remaining = Math.max(0, totalQuota - totalReg);
  const progressPct = totalQuota > 0 ? Math.min(100, Math.round((totalReg / totalQuota) * 100)) : 0;

  return `
    <article class="group bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm hover:shadow-xl hover:border-indigo-200 transition-all duration-300 flex flex-col">
      <div class="relative h-48 overflow-hidden bg-slate-100">
        <img
          src="${escapeHtml(ev.cover_image_url || 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1000&q=80')}"
          alt="${escapeHtml(ev.title)}"
          class="w-full h-full object-cover group-hover:scale-105 transition duration-500"
        />
        <div class="absolute top-3 left-3 flex gap-2">
          <span class="px-3 py-1 rounded-full text-xs font-bold bg-indigo-600/90 text-white backdrop-blur-sm">
            ${escapeHtml(ev.category)}
          </span>
          ${ev.is_featured ? `
            <span class="px-3 py-1 rounded-full text-xs font-bold bg-amber-400 text-slate-950">
              精選推薦
            </span>
          ` : ''}
        </div>
        <div class="absolute bottom-3 right-3">
          <span class="px-3 py-1 rounded-lg text-xs font-bold bg-slate-900/80 text-white backdrop-blur-sm">
            ${minPrice === 0 ? '免費報名' : `${formatCurrency(minPrice)} 起`}
          </span>
        </div>
      </div>

      <div class="p-6 flex-1 flex flex-col">
        <div class="text-xs font-semibold text-indigo-600 mb-1.5 flex items-center gap-1.5">
          <span>📅 ${formatDateTime(ev.start_time)}</span>
        </div>
        <h3 class="text-lg font-bold text-slate-900 group-hover:text-indigo-600 transition line-clamp-2 mb-2">
          ${escapeHtml(ev.title)}
        </h3>
        <p class="text-xs text-slate-500 line-clamp-2 mb-4 flex-1">
          ${escapeHtml(ev.subtitle || ev.description)}
        </p>

        <div class="text-xs text-slate-600 space-y-1 mb-4 pt-3 border-t border-slate-100">
          <div class="truncate">📍 ${escapeHtml(ev.location)}</div>
          ${ev.speaker_name ? `<div class="truncate">🎙️ 講師：${escapeHtml(ev.speaker_name)}</div>` : ''}
        </div>

        <!-- 名額進度條 -->
        <div class="mb-4">
          <div class="flex justify-between text-xs mb-1">
            <span class="text-slate-500">已報名 ${totalReg} / ${totalQuota} 名</span>
            <span class="font-semibold ${remaining <= 5 ? 'text-rose-600' : 'text-indigo-600'}">
              ${remaining > 0 ? `剩餘 ${remaining} 名額` : '名額已滿'}
            </span>
          </div>
          <div class="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full bg-indigo-600 rounded-full transition-all" style="width: ${progressPct}%"></div>
          </div>
        </div>

        <button
          onclick="window.app.navigateTo('event-detail', '${escapeHtml(ev.slug)}')"
          class="w-full py-2.5 px-4 rounded-xl font-semibold text-sm transition ${
            ev.status === 'closed' || remaining === 0
              ? 'bg-slate-100 text-slate-500'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm shadow-indigo-100'
          }"
        >
          ${ev.status === 'closed' ? '報名已截止' : remaining === 0 ? '檢視詳情（已額滿）' : '立即查看與報名 →'}
        </button>
      </div>
    </article>
  `;
}

// ============================================================================
// 5. 活動詳情與動態表單報名頁 (Event Detail & Registration Form)
// ============================================================================
function renderEventDetailView() {
  const ev = state.selectedEvent;
  if (!ev) return `<div class="p-12 text-center">找不到該活動</div>`;

  const tickets = ev.ticket_types || [];
  const selectedTicket = tickets.find(t => t.id === state.selectedTicketId) || tickets[0];
  const customFields = Array.isArray(ev.custom_fields) ? ev.custom_fields : [];

  const prefillName = state.profile?.full_name || '';
  const prefillEmail = state.profile?.email || state.user?.email || '';
  const prefillPhone = state.profile?.phone || '';
  const prefillOrg = state.profile?.organization || '';

  return `
    <div class="mb-6">
      <button onclick="window.app.navigateTo('explore')" class="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-indigo-600 transition">
        ← 返回活動列表
      </button>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <!-- 左欄：活動詳細介紹 -->
      <div class="lg:col-span-7 space-y-6">
        <div class="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
          <img
            src="${escapeHtml(ev.cover_image_url || 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1200&q=80')}"
            alt="${escapeHtml(ev.title)}"
            class="w-full h-64 md:h-80 object-cover"
          />
          <div class="p-6 md:p-8">
            <div class="flex flex-wrap gap-2 mb-3">
              <span class="px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700">${escapeHtml(ev.category)}</span>
              <span class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">活動狀態：${ev.status === 'published' ? '開放報名中' : '已截止'}</span>
            </div>
            <h1 class="text-2xl md:text-3xl font-extrabold text-slate-900 mb-2">${escapeHtml(ev.title)}</h1>
            <p class="text-slate-600 text-base mb-6">${escapeHtml(ev.subtitle)}</p>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-100 mb-6 text-sm">
              <div>
                <div class="text-xs font-semibold text-slate-400 uppercase mb-1">活動時間</div>
                <div class="font-semibold text-slate-800">${formatDateTime(ev.start_time)}</div>
                <div class="text-xs text-slate-500">至 ${formatDateTime(ev.end_time)}</div>
              </div>
              <div>
                <div class="text-xs font-semibold text-slate-400 uppercase mb-1">活動地點</div>
                <div class="font-semibold text-slate-800">${escapeHtml(ev.location)}</div>
                <div class="text-xs text-slate-500">${escapeHtml(ev.location_address)}</div>
              </div>
            </div>

            <h2 class="text-lg font-bold text-slate-900 mb-3">活動內容與議程介紹</h2>
            <div class="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-line mb-8">${escapeHtml(ev.description)}</div>

            ${ev.speaker_name ? `
              <div class="p-5 rounded-2xl bg-indigo-50/60 border border-indigo-100">
                <div class="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-1">主講人資訊</div>
                <div class="text-base font-bold text-slate-900">${escapeHtml(ev.speaker_name)} <span class="text-xs font-medium text-slate-500 ml-1">${escapeHtml(ev.speaker_title)}</span></div>
                <p class="text-xs text-slate-600 mt-2 leading-relaxed">${escapeHtml(ev.speaker_bio)}</p>
              </div>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- 右欄：選擇票種與填寫報名表單 -->
      <div class="lg:col-span-5">
        <div class="bg-white rounded-3xl border border-slate-200 p-6 md:p-8 shadow-sm sticky top-24">
          <h2 class="text-xl font-extrabold text-slate-900 mb-1">線上報名填表</h2>
          <p class="text-xs text-slate-500 mb-6">選擇票種並填寫報名資訊，送出後即可於「我的票券」查看狀態與電子票券</p>

          <!-- 1. 選擇票種 -->
          <div class="space-y-3 mb-6">
            <label class="block text-xs font-bold text-slate-700 uppercase tracking-wider">1. 選擇報名票種</label>
            ${tickets.map(t => {
              const rem = Math.max(0, t.quota - t.registered_count);
              const isSelected = selectedTicket && selectedTicket.id === t.id;
              return `
                <div
                  onclick="${rem > 0 ? `window.app.selectTicket('${t.id}')` : ''}"
                  class="p-4 rounded-2xl border-2 transition cursor-pointer ${
                    rem === 0
                      ? 'border-slate-100 bg-slate-50 opacity-60 cursor-not-allowed'
                      : isSelected
                        ? 'border-indigo-600 bg-indigo-50/40'
                        : 'border-slate-200 hover:border-indigo-300'
                  }"
                >
                  <div class="flex items-center justify-between mb-1">
                    <span class="font-bold text-slate-900 text-sm">${escapeHtml(t.name)}</span>
                    <span class="font-extrabold text-indigo-600 text-base">${formatCurrency(t.price)}</span>
                  </div>
                  <p class="text-xs text-slate-500 mb-2">${escapeHtml(t.description)}</p>
                  <div class="flex items-center justify-between text-[11px]">
                    <span class="text-slate-400">名額上限 ${t.quota} 名</span>
                    <span class="font-semibold ${rem > 0 ? 'text-emerald-600' : 'text-rose-600'}">
                      ${rem > 0 ? `尚餘 ${rem} 名` : '已額滿'}
                    </span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <!-- 2. 填寫報名表單 -->
          ${!state.user ? `
            <div class="p-5 rounded-2xl bg-indigo-50 border border-indigo-100 text-center">
              <p class="text-sm font-semibold text-indigo-950 mb-1">請先登入或註冊會員以進行報名</p>
              <p class="text-xs text-indigo-700 mb-4">登入後可自動帶入個人基本資料、回報匯款後五碼及領取現場報到 QR Code 電子票券</p>
              <div class="flex justify-center gap-3">
                <button onclick="window.app.openAuthModal('login')" class="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition">
                  立即登入 / 註冊
                </button>
              </div>
            </div>
          ` : `
            <form id="event-registration-form" onsubmit="window.app.submitRegistration(event)" class="space-y-4">
              <div class="text-xs font-bold text-slate-700 uppercase tracking-wider pt-2 border-t border-slate-100">
                2. 學員基本聯絡資料
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-700 mb-1">真實姓名 <span class="text-rose-500">*</span></label>
                <input type="text" name="attendee_name" required value="${escapeHtml(prefillName)}" placeholder="請輸入您的真實姓名" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-600" />
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1">聯絡手機 <span class="text-rose-500">*</span></label>
                  <input type="tel" name="attendee_phone" required value="${escapeHtml(prefillPhone)}" placeholder="0912-345-678" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-600" />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1">電子信箱 <span class="text-rose-500">*</span></label>
                  <input type="email" name="attendee_email" required value="${escapeHtml(prefillEmail)}" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-600" />
                </div>
              </div>

              <div>
                <label class="block text-xs font-semibold text-slate-700 mb-1">服務單位／學校／公司名稱</label>
                <input type="text" name="attendee_org" value="${escapeHtml(prefillOrg)}" placeholder="選填" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-600" />
              </div>

              ${customFields.length > 0 ? `
                <div class="text-xs font-bold text-slate-700 uppercase tracking-wider pt-3 border-t border-slate-100">
                  3. 活動專屬調查欄位
                </div>
                ${customFields.map(field => renderCustomFormField(field)).join('')}
              ` : ''}

              <div class="pt-4">
                <button
                  type="submit"
                  ${!selectedTicket || selectedTicket.registered_count >= selectedTicket.quota || ev.status === 'closed' ? 'disabled' : ''}
                  class="w-full py-3.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-bold text-sm shadow-md shadow-indigo-100 transition"
                >
                  ${selectedTicket && selectedTicket.price > 0
                    ? `確認送出報名（應付 ${formatCurrency(selectedTicket.price)}）`
                    : '確認免費報名（立即領取電子票券）'}
                </button>
              </div>
            </form>
          `}
        </div>
      </div>
    </div>
  `;
}

function renderCustomFormField(field) {
  const reqBadge = field.required ? '<span class="text-rose-500">*</span>' : '';
  const reqAttr = field.required ? 'required' : '';
  const fieldName = `custom_${field.id}`;

  if (field.type === 'select') {
    const opts = Array.isArray(field.options) ? field.options : [];
    return `
      <div>
        <label class="block text-xs font-semibold text-slate-700 mb-1">${escapeHtml(field.label)} ${reqBadge}</label>
        <select name="${escapeHtml(fieldName)}" ${reqAttr} class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:border-indigo-600">
          <option value="">請選擇...</option>
          ${opts.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  if (field.type === 'textarea') {
    return `
      <div>
        <label class="block text-xs font-semibold text-slate-700 mb-1">${escapeHtml(field.label)} ${reqBadge}</label>
        <textarea name="${escapeHtml(fieldName)}" rows="3" ${reqAttr} class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-600"></textarea>
      </div>
    `;
  }

  return `
    <div>
      <label class="block text-xs font-semibold text-slate-700 mb-1">${escapeHtml(field.label)} ${reqBadge}</label>
      <input type="text" name="${escapeHtml(fieldName)}" ${reqAttr} class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-600" />
    </div>
  `;
}

// ============================================================================
// 6. 會員專區：我的票券與報名紀錄 (My Tickets & Payment Report)
// ============================================================================
function renderMyTicketsView() {
  if (!state.user) {
    return `
      <div class="max-w-lg mx-auto bg-white rounded-3xl border border-slate-200 p-10 text-center my-8">
        <div class="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-4 text-2xl">🎫</div>
        <h2 class="text-xl font-bold text-slate-900 mb-2">登入以查看您的報名紀錄與電子票券</h2>
        <p class="text-sm text-slate-500 mb-6">登入後即可查詢報名狀態、回報匯款帳號後五碼，並在活動現場出示專屬 QR Code 快速報到。</p>
        <button onclick="window.app.openAuthModal('login')" class="px-6 py-3 rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 transition">
          立即登入會員
        </button>
      </div>
    `;
  }

  const list = state.myRegistrations;

  return `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
      <div>
        <h1 class="text-2xl md:text-3xl font-extrabold text-slate-900">我的報名紀錄與電子票夾</h1>
        <p class="text-sm text-slate-500 mt-1">管理已報名的活動、填寫銀行匯款回報，以及出示現場報到 QR Code 電子票券</p>
      </div>
      <button onclick="window.app.openProfileModal()" class="px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-700 hover:border-indigo-300 text-sm font-semibold transition">
        ⚙️ 修改個人預設聯絡資料
      </button>
    </div>

    ${list.length === 0 ? `
      <div class="bg-white rounded-3xl border border-slate-200 p-12 text-center">
        <p class="text-slate-500 mb-4">您目前尚無任何報名紀錄</p>
        <button onclick="window.app.navigateTo('explore')" class="px-5 py-2.5 rounded-xl bg-indigo-600 text-white font-semibold text-sm">
          前往探索近期活動
        </button>
      </div>
    ` : `
      <div class="space-y-5">
        ${list.map(reg => renderMyRegistrationCard(reg)).join('')}
      </div>
    `}
  `;
}

function renderMyRegistrationCard(reg) {
  const ev = reg.events || {};
  const tk = reg.ticket_types || {};
  const bankInfo = ev.bank_info || {
    bank_name: '玉山銀行 (808)',
    branch: '營業部',
    account_name: 'EventPulse 活動報名平台',
    account_number: '0123-940-056789'
  };

  const statusBadgeMap = {
    pending_payment: '<span class="px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800">⏳ 待匯款回報</span>',
    pending_verification: '<span class="px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800">🔍 已回報匯款（待後台審核對帳）</span>',
    confirmed: reg.checked_in_at
      ? '<span class="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">✅ 已現場報到核銷</span>'
      : '<span class="px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">🎟️ 報名成功（已核發電子票券）</span>',
    cancelled: '<span class="px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-500">已取消報名</span>'
  };

  return `
    <div class="bg-white rounded-3xl border border-slate-200 p-6 md:p-8 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-3 pb-4 mb-4 border-b border-slate-100">
        <div class="flex items-center gap-3">
          ${statusBadgeMap[reg.status] || ''}
          <span class="text-xs text-slate-400">訂單建立：${formatDateTime(reg.created_at)}</span>
        </div>
        <div class="text-sm font-bold text-indigo-600">
          票種：${escapeHtml(tk.name || '')}（${formatCurrency(reg.amount)}）
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
        <div class="lg:col-span-7 space-y-2">
          <h3 class="text-xl font-extrabold text-slate-900">${escapeHtml(ev.title || '活動')}</h3>
          <div class="text-xs text-slate-600 space-y-1">
            <div>📅 活動時間：${formatDateTime(ev.start_time)}</div>
            <div>📍 活動地點：${escapeHtml(ev.location || '')}（${escapeHtml(ev.location_address || '')}）</div>
            <div>👤 報名學員：${escapeHtml(reg.attendee_name)} / ${escapeHtml(reg.attendee_phone)} / ${escapeHtml(reg.attendee_email)}</div>
          </div>

          ${reg.payment_last5 ? `
            <div class="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 text-xs">
              <span>💳 已回報匯款帳號後五碼：<strong>${escapeHtml(reg.payment_last5)}</strong>（金額 NT$ ${reg.payment_amount || reg.amount}）</span>
            </div>
          ` : ''}
        </div>

        <div class="lg:col-span-5 flex flex-wrap lg:justify-end gap-3">
          ${reg.status === 'pending_payment' || reg.status === 'pending_verification' ? `
            <button
              onclick="window.app.openPaymentModal('${reg.id}')"
              class="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs shadow-sm transition"
            >
              💰 ${reg.status === 'pending_payment' ? '填寫匯款帳號後五碼回報' : '修改匯款回報資訊'}
            </button>
          ` : ''}

          ${reg.status === 'confirmed' ? `
            <button
              onclick="window.app.openQrTicketModal('${reg.id}')"
              class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-sm shadow-indigo-100 transition flex items-center gap-1.5"
            >
              <span>📱 出示現場報到 QR Code 電子票券</span>
            </button>
          ` : ''}

          ${reg.status !== 'cancelled' && !reg.checked_in_at ? `
            <button
              onclick="window.app.openEditRegModal('${reg.id}')"
              class="px-3.5 py-2.5 rounded-xl border border-slate-200 hover:border-indigo-300 text-slate-700 font-semibold text-xs transition"
            >
              ✏️ 修改報名資料
            </button>
            <button
              onclick="window.app.cancelRegistration('${reg.id}')"
              class="px-3.5 py-2.5 rounded-xl border border-rose-200 hover:bg-rose-50 text-rose-600 font-semibold text-xs transition"
            >
              取消報名
            </button>
          ` : ''}
        </div>
      </div>

      ${reg.status === 'pending_payment' ? `
        <div class="mt-5 p-4 rounded-2xl bg-amber-50/80 border border-amber-200/80 text-xs text-amber-900">
          <div class="font-bold mb-1">🏦 主辦單位匯款帳戶資訊（完成轉帳後請點擊右側「填寫匯款帳號後五碼回報」）：</div>
          <div>銀行：${escapeHtml(bankInfo.bank_name)} ${escapeHtml(bankInfo.branch || '')} ｜ 戶名：${escapeHtml(bankInfo.account_name)} ｜ 帳號：<strong class="font-mono text-sm">${escapeHtml(bankInfo.account_number)}</strong></div>
        </div>
      ` : ''}
    </div>
  `;
}

// ============================================================================
// 7. 後台管理系統 (Admin Dashboard: 活動上下架、表單自訂、名單審核與匯出)
// ============================================================================
function renderAdminView() {
  const totalEvents = state.events.length;
  const activeRegs = state.adminRegistrations.filter(r => r.status !== 'cancelled');
  const pendingVerifyCount = state.adminRegistrations.filter(r => r.status === 'pending_verification').length;
  const confirmedRevenue = state.adminRegistrations
    .filter(r => r.status === 'confirmed')
    .reduce((sum, r) => sum + (r.amount || 0), 0);
  const checkedInCount = state.adminRegistrations.filter(r => r.checked_in_at).length;

  return `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
      <div>
        <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-indigo-100 text-indigo-800 text-xs font-bold mb-2">
          ADMIN CMS 控制台
        </div>
        <h1 class="text-2xl md:text-3xl font-extrabold text-slate-900">主辦方後台管理中心</h1>
        <p class="text-sm text-slate-500">管理活動上下架、自訂報名表單欄位、審核匯款後五碼並匯出學員名單</p>
      </div>
      <div class="flex flex-wrap gap-3">
        <button onclick="window.app.openEventEditorModal(null)" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm shadow-sm transition">
          ＋ 新增活動與自訂表單
        </button>
        <button onclick="window.app.exportRegistrationsCsv()" class="px-4 py-2.5 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 font-semibold text-sm transition">
          📥 匯出報名名單 Excel (CSV)
        </button>
      </div>
    </div>

    <!-- 統計指標卡 -->
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
      <div class="bg-white p-5 rounded-2xl border border-slate-200">
        <div class="text-xs font-semibold text-slate-400">總活動場次</div>
        <div class="text-2xl font-extrabold text-slate-900 mt-1">${totalEvents}</div>
      </div>
      <div class="bg-white p-5 rounded-2xl border border-slate-200">
        <div class="text-xs font-semibold text-slate-400">有效報名總人數</div>
        <div class="text-2xl font-extrabold text-indigo-600 mt-1">${activeRegs.length}</div>
      </div>
      <div class="bg-white p-5 rounded-2xl border border-amber-200 bg-amber-50/30">
        <div class="text-xs font-semibold text-amber-700">待審核對帳筆數</div>
        <div class="text-2xl font-extrabold text-amber-600 mt-1">${pendingVerifyCount}</div>
      </div>
      <div class="bg-white p-5 rounded-2xl border border-slate-200">
        <div class="text-xs font-semibold text-slate-400">已確認收款總額</div>
        <div class="text-2xl font-extrabold text-emerald-600 mt-1">NT$ ${confirmedRevenue.toLocaleString('zh-TW')}</div>
      </div>
      <div class="bg-white p-5 rounded-2xl border border-slate-200">
        <div class="text-xs font-semibold text-slate-400">已現場報到人數</div>
        <div class="text-2xl font-extrabold text-slate-900 mt-1">${checkedInCount}</div>
      </div>
    </div>

    <!-- 後台分頁切換 -->
    <div class="flex gap-2 border-b border-slate-200 mb-6">
      <button
        onclick="window.app.setAdminTab('events')"
        class="px-5 py-3 font-bold text-sm border-b-2 transition ${
          state.adminTab === 'events'
            ? 'border-indigo-600 text-indigo-600'
            : 'border-transparent text-slate-500 hover:text-slate-800'
        }"
      >
        📋 活動上／下架與表單欄位管理 (${state.events.length})
      </button>
      <button
        onclick="window.app.setAdminTab('registrations')"
        class="px-5 py-3 font-bold text-sm border-b-2 transition ${
          state.adminTab === 'registrations'
            ? 'border-indigo-600 text-indigo-600'
            : 'border-transparent text-slate-500 hover:text-slate-800'
        }"
      >
        💳 報名名單與匯款對帳審核 (${state.adminRegistrations.length})
      </button>
    </div>

    ${state.adminTab === 'events' ? renderAdminEventsTable() : renderAdminRegistrationsTable()}
  `;
}

function renderAdminEventsTable() {
  return `
    <div class="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase">
              <th class="py-4 px-6">活動名稱與時間</th>
              <th class="py-4 px-4">分類</th>
              <th class="py-4 px-4">上架狀態</th>
              <th class="py-4 px-4">票種與名額狀況</th>
              <th class="py-4 px-4">自訂表單欄位</th>
              <th class="py-4 px-6 text-right">管理操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${state.events.map(ev => {
              const fields = Array.isArray(ev.custom_fields) ? ev.custom_fields : [];
              const tickets = ev.ticket_types || [];
              const statusSelectClass =
                ev.status === 'published' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                ev.status === 'draft' ? 'bg-slate-100 text-slate-700 border-slate-300' :
                'bg-rose-50 text-rose-700 border-rose-200';

              return `
                <tr class="hover:bg-slate-50/80 transition">
                  <td class="py-4 px-6">
                    <div class="font-bold text-slate-900">${escapeHtml(ev.title)}</div>
                    <div class="text-xs text-slate-500 mt-0.5">📅 ${formatDateTime(ev.start_time)} ｜ 📍 ${escapeHtml(ev.location)}</div>
                  </td>
                  <td class="py-4 px-4">
                    <span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700">${escapeHtml(ev.category)}</span>
                  </td>
                  <td class="py-4 px-4">
                    <select
                      onchange="window.app.updateEventStatus('${ev.id}', this.value)"
                      class="px-3 py-1.5 rounded-xl border text-xs font-bold ${statusSelectClass}"
                    >
                      <option value="published" ${ev.status === 'published' ? 'selected' : ''}>🟢 已上架 (Published)</option>
                      <option value="draft" ${ev.status === 'draft' ? 'selected' : ''}>⚪ 草稿隱藏 (Draft)</option>
                      <option value="closed" ${ev.status === 'closed' ? 'selected' : ''}>🔴 已截止 (Closed)</option>
                    </select>
                  </td>
                  <td class="py-4 px-4">
                    <div class="space-y-1 text-xs">
                      ${tickets.map(t => `
                        <div>
                          <span class="font-medium text-slate-700">${escapeHtml(t.name)}</span>
                          <span class="text-slate-400">(${formatCurrency(t.price)})</span>：
                          <span class="font-bold text-indigo-600">${t.registered_count}/${t.quota}</span>
                        </div>
                      `).join('')}
                    </div>
                  </td>
                  <td class="py-4 px-4">
                    <div class="flex flex-wrap gap-1 max-w-xs">
                      ${fields.length === 0 ? '<span class="text-xs text-slate-400">僅基本資料</span>' : fields.map(f => `
                        <span class="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[11px]">${escapeHtml(f.label)}</span>
                      `).join('')}
                    </div>
                  </td>
                  <td class="py-4 px-6 text-right space-x-2 whitespace-nowrap">
                    <button
                      onclick="window.app.openEventEditorModal('${ev.id}')"
                      class="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold text-xs transition"
                    >
                      ✏️ 編輯活動／自訂欄位
                    </button>
                    <button
                      onclick="window.app.navigateTo('event-detail', '${escapeHtml(ev.slug)}')"
                      class="px-3 py-1.5 rounded-xl border border-slate-200 hover:border-slate-300 text-slate-600 font-semibold text-xs transition"
                    >
                      預覽前台
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAdminRegistrationsTable() {
  const filtered = state.adminRegistrations.filter(r => {
    const matchEv = state.adminEventFilter === 'all' || r.event_id === state.adminEventFilter;
    const matchSt = state.adminStatusFilter === 'all' || r.status === state.adminStatusFilter;
    return matchEv && matchSt;
  });

  return `
    <!-- 篩選列 -->
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <select
        onchange="window.app.setAdminEventFilter(this.value)"
        class="px-3.5 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700"
      >
        <option value="all">所有活動場次</option>
        ${state.events.map(e => `
          <option value="${e.id}" ${state.adminEventFilter === e.id ? 'selected' : ''}>${escapeHtml(e.title)}</option>
        `).join('')}
      </select>

      <select
        onchange="window.app.setAdminStatusFilter(this.value)"
        class="px-3.5 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700"
      >
        <option value="all" ${state.adminStatusFilter === 'all' ? 'selected' : ''}>所有訂單狀態</option>
        <option value="pending_verification" ${state.adminStatusFilter === 'pending_verification' ? 'selected' : ''}>🔍 待審核對帳 (已回報後五碼)</option>
        <option value="pending_payment" ${state.adminStatusFilter === 'pending_payment' ? 'selected' : ''}>⏳ 待匯款回報</option>
        <option value="confirmed" ${state.adminStatusFilter === 'confirmed' ? 'selected' : ''}>✅ 已確認核發票券</option>
        <option value="cancelled" ${state.adminStatusFilter === 'cancelled' ? 'selected' : ''}>❌ 已取消</option>
      </select>
    </div>

    <div class="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase">
              <th class="py-4 px-5">學員資訊</th>
              <th class="py-4 px-4">報名活動与票種</th>
              <th class="py-4 px-4">自訂表單填答內容</th>
              <th class="py-4 px-4">付款與後五碼對帳</th>
              <th class="py-4 px-4">票券與報到狀態</th>
              <th class="py-4 px-5 text-right">審核操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${filtered.length === 0 ? `
              <tr><td colspan="6" class="py-12 text-center text-slate-400">目前無符合條件的報名資料</td></tr>
            ` : filtered.map(reg => {
              const answers = reg.form_answers || {};
              const answerEntries = Object.entries(answers);
              return `
                <tr class="hover:bg-slate-50/70 transition">
                  <td class="py-4 px-5">
                    <div class="font-bold text-slate-900">${escapeHtml(reg.attendee_name)}</div>
                    <div class="text-xs text-slate-500">${escapeHtml(reg.attendee_phone)}</div>
                    <div class="text-xs text-slate-400">${escapeHtml(reg.attendee_email)}</div>
                    ${reg.attendee_org ? `<div class="text-xs text-indigo-600 font-medium">${escapeHtml(reg.attendee_org)}</div>` : ''}
                  </td>
                  <td class="py-4 px-4">
                    <div class="font-semibold text-slate-800 text-xs">${escapeHtml(reg.events?.title || '')}</div>
                    <div class="text-xs text-indigo-600 font-bold mt-0.5">${escapeHtml(reg.ticket_types?.name || '')} (${formatCurrency(reg.amount)})</div>
                  </td>
                  <td class="py-4 px-4">
                    <div class="space-y-1 text-xs max-w-xs">
                      ${answerEntries.length === 0 ? '<span class="text-slate-400">-</span>' : answerEntries.map(([k, v]) => `
                        <div><span class="text-slate-400">${escapeHtml(k)}：</span><span class="text-slate-700 font-medium">${escapeHtml(v)}</span></div>
                      `).join('')}
                    </div>
                  </td>
                  <td class="py-4 px-4 text-xs">
                    ${reg.amount === 0 ? `
                      <span class="text-emerald-600 font-semibold">免費票種</span>
                    ` : reg.payment_last5 ? `
                      <div class="p-2 rounded-xl bg-amber-50 border border-amber-200">
                        <div class="font-bold text-amber-900">後五碼：<span class="font-mono text-sm">${escapeHtml(reg.payment_last5)}</span></div>
                        <div class="text-amber-700">匯款金額：NT$ ${reg.payment_amount || reg.amount}</div>
                        ${reg.payment_date ? `<div class="text-amber-600">日期：${escapeHtml(reg.payment_date)}</div>` : ''}
                      </div>
                    ` : `
                      <span class="text-slate-400">尚未回報匯款資訊</span>
                    `}
                  </td>
                  <td class="py-4 px-4 text-xs">
                    <div>
                      ${reg.status === 'confirmed'
                        ? '<span class="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-bold">✅ 已核發票券</span>'
                        : reg.status === 'pending_verification'
                          ? '<span class="px-2.5 py-1 rounded-full bg-blue-100 text-blue-800 font-bold">🔍 待對帳審核</span>'
                          : reg.status === 'pending_payment'
                            ? '<span class="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-bold">⏳ 待匯款</span>'
                            : '<span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 font-bold">已取消</span>'
                      }
                    </div>
                    <div class="mt-1.5 text-[11px] font-mono text-slate-400">票號: ${escapeHtml(reg.checkin_token.slice(0, 10))}</div>
                    ${reg.checked_in_at ? `<div class="text-emerald-600 font-bold mt-0.5">📍 已於 ${formatDateTime(reg.checked_in_at)} 報到</div>` : ''}
                  </td>
                  <td class="py-4 px-5 text-right space-x-1.5 whitespace-nowrap">
                    ${reg.status !== 'confirmed' && reg.status !== 'cancelled' ? `
                      <button
                        onclick="window.app.verifyPaymentAndConfirm('${reg.id}')"
                        class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-sm transition"
                      >
                        ✓ 確認收款核發票券
                      </button>
                    ` : ''}
                    ${reg.status === 'confirmed' && !reg.checked_in_at ? `
                      <button
                        onclick="window.app.performCheckInByToken('${reg.checkin_token}')"
                        class="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs transition"
                      >
                        📍 手動簽到
                      </button>
                    ` : ''}
                    ${reg.status !== 'cancelled' ? `
                      <button
                        onclick="window.app.adminCancelRegistration('${reg.id}')"
                        class="px-2.5 py-1.5 rounded-xl text-rose-600 hover:bg-rose-50 text-xs font-semibold transition"
                      >
                        取消
                      </button>
                    ` : ''}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// 8. 現場 QR Code 報到核銷台 (Check-in Scanner View)
// ============================================================================
function renderCheckinView() {
  const confirmedRegs = state.adminRegistrations.filter(r => r.status === 'confirmed');
  const checkedInRegs = confirmedRegs.filter(r => r.checked_in_at);

  return `
    <div class="max-w-5xl mx-auto">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-emerald-100 text-emerald-800 text-xs font-bold mb-2">
            ON-SITE CHECK-IN 現場報到核銷系統
          </div>
          <h1 class="text-2xl md:text-3xl font-extrabold text-slate-900">QR Code 電子票券現場報到台</h1>
          <p class="text-sm text-slate-500">使用手機／平板／筆電鏡頭掃描學員出示之 QR Code，或輸入票號／姓名快速簽到</p>
        </div>
        <div class="bg-white px-5 py-3 rounded-2xl border border-slate-200 flex items-center gap-4">
          <div>
            <div class="text-xs text-slate-400">現場已報到 / 應到總人數</div>
            <div class="text-xl font-extrabold text-indigo-600">${checkedInRegs.length} / ${confirmedRegs.length} 名</div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <!-- 左側：鏡頭掃描與票號輸入 -->
        <div class="lg:col-span-6 space-y-6">
          <div class="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
            <h2 class="text-base font-bold text-slate-900 mb-3">📷 光學鏡頭即時掃描 QR Code</h2>
            <div id="qr-reader" class="w-full rounded-2xl overflow-hidden bg-slate-950 min-h-[260px] flex items-center justify-center text-slate-400 text-xs mb-4">
              點擊下方按鈕啟動相機鏡頭掃描學員票券
            </div>
            <div class="flex gap-3">
              <button
                onclick="window.app.startQrScanner()"
                class="flex-1 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition"
              >
                啟動相機掃描器
              </button>
              <button
                onclick="window.app.stopQrScanner()"
                class="py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition"
              >
                關閉鏡頭
              </button>
            </div>
          </div>

          <div class="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
            <h2 class="text-base font-bold text-slate-900 mb-2">⌨️ 票券驗證碼 / 條碼槍輸入核銷</h2>
            <form onsubmit="window.app.handleManualTokenSubmit(event)" class="flex gap-2">
              <input
                type="text"
                id="manual-checkin-token"
                placeholder="貼上或掃描票券驗證碼 (checkin_token)..."
                class="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-indigo-600"
              />
              <button type="submit" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition">
                立即核銷
              </button>
            </form>
            <div id="checkin-result-banner" class="mt-4 hidden"></div>
          </div>
        </div>

        <!-- 右側：快速名單搜尋與一鍵簽到 -->
        <div class="lg:col-span-6">
          <div class="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
            <h2 class="text-base font-bold text-slate-900 mb-4">📋 學員名單快速簽到列表</h2>
            <div class="space-y-3 max-h-[520px] overflow-y-auto pr-1">
              ${confirmedRegs.length === 0 ? `
                <div class="py-12 text-center text-slate-400 text-sm">目前尚無已核發票券之學員（請先於報名或後台審核通過）</div>
              ` : confirmedRegs.map(reg => `
                <div class="p-4 rounded-2xl border ${reg.checked_in_at ? 'bg-emerald-50/50 border-emerald-200' : 'border-slate-200'} flex items-center justify-between gap-3">
                  <div>
                    <div class="font-bold text-slate-900 text-sm">${escapeHtml(reg.attendee_name)} <span class="text-xs font-normal text-slate-500">(${escapeHtml(reg.attendee_phone)})</span></div>
                    <div class="text-xs text-slate-500">${escapeHtml(reg.events?.title || '')} — ${escapeHtml(reg.ticket_types?.name || '')}</div>
                    <div class="text-[11px] font-mono text-slate-400 mt-0.5">Token: ${escapeHtml(reg.checkin_token)}</div>
                  </div>
                  <div>
                    ${reg.checked_in_at ? `
                      <span class="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-bold inline-block">
                        ✓ 已報到 (${new Date(reg.checked_in_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })})
                      </span>
                    ` : `
                      <button
                        onclick="window.app.performCheckInByToken('${reg.checkin_token}')"
                        class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition"
                      >
                        點擊簽到
                      </button>
                    `}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// 9. 互動操作與表單送出處理 (Actions & Modals)
// ============================================================================
export function setSearchQuery(q) {
  state.searchQuery = q;
  renderMainView();
}

export function setCategory(cat) {
  state.selectedCategory = cat;
  renderMainView();
}

export function resetFilter() {
  state.searchQuery = '';
  state.selectedCategory = '全部';
  renderMainView();
}

export function selectTicket(ticketId) {
  state.selectedTicketId = ticketId;
  renderMainView();
}

export function setAdminTab(tab) {
  state.adminTab = tab;
  renderMainView();
}

export function setAdminEventFilter(val) {
  state.adminEventFilter = val;
  renderMainView();
}

export function setAdminStatusFilter(val) {
  state.adminStatusFilter = val;
  renderMainView();
}

// 送出活動報名
export async function submitRegistration(e) {
  e.preventDefault();
  if (!state.user || !state.selectedEvent || !state.selectedTicketId) {
    showToast('請先登入並選擇票種', 'error');
    return;
  }

  const form = e.target;
  const formData = new FormData(form);
  const attendee_name = formData.get('attendee_name')?.toString().trim() || '';
  const attendee_phone = formData.get('attendee_phone')?.toString().trim() || '';
  const attendee_email = formData.get('attendee_email')?.toString().trim() || '';
  const attendee_org = formData.get('attendee_org')?.toString().trim() || '';

  const customFields = Array.isArray(state.selectedEvent.custom_fields) ? state.selectedEvent.custom_fields : [];
  const form_answers = {};
  for (const f of customFields) {
    form_answers[f.label] = formData.get(`custom_${f.id}`)?.toString().trim() || '';
  }

  const ticket = (state.selectedEvent.ticket_types || []).find(t => t.id === state.selectedTicketId);
  const price = ticket ? ticket.price : 0;

  // 同步更新會員預設聯絡資料
  await supabase
    .from('profiles')
    .update({
      full_name: attendee_name,
      phone: attendee_phone,
      organization: attendee_org,
      updated_at: new Date().toISOString()
    })
    .eq('id', state.user.id);

  const { data, error } = await supabase
    .from('registrations')
    .insert({
      event_id: state.selectedEvent.id,
      ticket_type_id: state.selectedTicketId,
      user_id: state.user.id,
      attendee_name,
      attendee_email,
      attendee_phone,
      attendee_org,
      form_answers,
      amount: price,
      status: price === 0 ? 'confirmed' : 'pending_payment',
      payment_method: price === 0 ? 'free' : 'bank_transfer'
    })
    .select('*')
    .single();

  if (error) {
    showToast('報名失敗：' + error.message, 'error');
    return;
  }

  await fetchEvents();
  await ensureProfile();

  if (price === 0) {
    showToast('免費報名成功！已為您核發專屬 QR Code 電子票券', 'success');
    await navigateTo('my-tickets');
    if (data?.id) openQrTicketModal(data.id);
  } else {
    showToast('報名訂單已建立！請完成匯款並填寫帳號後五碼回報', 'success');
    await navigateTo('my-tickets');
    if (data?.id) openPaymentModal(data.id);
  }
}

// 開啟匯款後五碼回報 Modal
export function openPaymentModal(regId) {
  const reg = state.myRegistrations.find(r => r.id === regId);
  if (!reg) return;
  const ev = reg.events || {};
  const bankInfo = ev.bank_info || {
    bank_name: '玉山銀行 (808)',
    branch: '營業部',
    account_name: 'EventPulse 活動報名平台',
    account_number: '0123-940-056789'
  };

  const today = new Date().toISOString().slice(0, 10);
  openModal(`
    <div class="p-6 md:p-8">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-xl font-extrabold text-slate-900">💰 銀行匯款／轉帳回報</h3>
        <button onclick="window.app.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl">✕</button>
      </div>
      <div class="p-4 rounded-2xl bg-indigo-50 border border-indigo-100 text-xs text-indigo-950 space-y-1 mb-6">
        <div class="font-bold text-indigo-700 mb-1">匯款指定帳戶資訊</div>
        <div>銀行名稱：<strong>${escapeHtml(bankInfo.bank_name)} ${escapeHtml(bankInfo.branch || '')}</strong></div>
        <div>戶名：<strong>${escapeHtml(bankInfo.account_name)}</strong></div>
        <div>轉帳帳號：<strong class="font-mono text-sm text-indigo-700">${escapeHtml(bankInfo.account_number)}</strong></div>
        <div>應付金額：<strong class="text-sm text-rose-600">NT$ ${reg.amount}</strong></div>
      </div>

      <form onsubmit="window.app.submitPaymentReport(event, '${reg.id}')" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">您的轉帳帳號後五碼 <span class="text-rose-500">*</span></label>
          <input
            type="text"
            name="payment_last5"
            required
            maxlength="5"
            pattern="[0-9]{5}"
            value="${escapeHtml(reg.payment_last5 || '')}"
            placeholder="例如：12345 (請輸入 5 位數字)"
            class="w-full px-4 py-2.5 rounded-xl border border-slate-200 font-mono text-base focus:outline-none focus:border-indigo-600"
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">實際匯款金額 (NT$) <span class="text-rose-500">*</span></label>
            <input type="number" name="payment_amount" required value="${reg.payment_amount || reg.amount}" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">匯款日期 <span class="text-rose-500">*</span></label>
            <input type="date" name="payment_date" required value="${escapeHtml(reg.payment_date || today)}" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">匯款備註（選填）</label>
          <input type="text" name="payment_note" value="${escapeHtml(reg.payment_note || '')}" placeholder="如有特殊對帳說明請填寫" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div class="flex justify-end gap-3 pt-4">
          <button type="button" onclick="window.app.closeModal()" class="px-4 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold">取消</button>
          <button type="submit" class="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm">送出匯款回報</button>
        </div>
      </form>
    </div>
  `);
}

export async function submitPaymentReport(e, regId) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payment_last5 = fd.get('payment_last5')?.toString().trim() || '';
  const payment_amount = parseInt(fd.get('payment_amount')?.toString() || '0', 10);
  const payment_date = fd.get('payment_date')?.toString() || '';
  const payment_note = fd.get('payment_note')?.toString().trim() || '';

  const { error } = await supabase
    .from('registrations')
    .update({
      payment_last5,
      payment_amount,
      payment_date,
      payment_note,
      status: 'pending_verification',
      payment_reported_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', regId);

  if (error) {
    showToast('回報失敗：' + error.message, 'error');
    return;
  }

  closeModal();
  showToast('匯款資訊已成功送出！待主辦單位核對後即會核發電子票券', 'success');
  await fetchMyRegistrations();
  renderMainView();
}

// 開啟 QR Code 電子票券 Modal
export async function openQrTicketModal(regId) {
  const reg = state.myRegistrations.find(r => r.id === regId);
  if (!reg) return;
  const ev = reg.events || {};
  const tk = reg.ticket_types || {};

  const qrDataUrl = await QRCode.toDataURL(reg.checkin_token, {
    width: 260,
    margin: 2,
    color: { dark: '#1e1b4b', light: '#ffffff' }
  });

  openModal(`
    <div class="p-6 md:p-8 text-center">
      <div class="flex justify-between items-center mb-4">
        <span class="px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-bold">EVENTPULSE 電子入場票券</span>
        <button onclick="window.app.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl">✕</button>
      </div>
      <h3 class="text-lg font-extrabold text-slate-900 mb-1">${escapeHtml(ev.title || '')}</h3>
      <p class="text-xs text-indigo-600 font-bold mb-4">${escapeHtml(tk.name || '')} ｜ 學員：${escapeHtml(reg.attendee_name)}</p>

      <div class="inline-block p-4 rounded-3xl bg-white border-2 border-indigo-100 shadow-inner mb-4">
        <img src="${qrDataUrl}" alt="QR Code Ticket" class="w-56 h-56 mx-auto" />
      </div>

      <div class="bg-slate-50 rounded-2xl p-3 mb-4 text-xs">
        <div class="text-slate-400 mb-0.5">唯一報到核銷驗證碼 (Check-in Token)</div>
        <div class="font-mono font-bold text-slate-800 text-sm select-all">${escapeHtml(reg.checkin_token)}</div>
      </div>

      <div class="text-xs text-slate-500 space-y-1 text-left bg-slate-50 p-4 rounded-2xl mb-5">
        <div>📅 時間：${formatDateTime(ev.start_time)}</div>
        <div>📍 地點：${escapeHtml(ev.location || '')}</div>
        <div>📌 狀態：${reg.checked_in_at ? `已於 ${formatDateTime(reg.checked_in_at)} 完成報到` : '未報到（請於入場時出示此 QR Code）'}</div>
      </div>

      <button onclick="window.app.closeModal()" class="w-full py-2.5 rounded-xl bg-indigo-600 text-white font-bold text-xs">
        關閉票券視窗
      </button>
    </div>
  `);
}

// 修改報名資料 Modal
export function openEditRegModal(regId) {
  const reg = state.myRegistrations.find(r => r.id === regId);
  if (!reg) return;
  const answers = reg.form_answers || {};

  openModal(`
    <div class="p-6 md:p-8">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-lg font-extrabold text-slate-900">✏️ 修改報名聯絡與表單資料</h3>
        <button onclick="window.app.closeModal()" class="text-slate-400 hover:text-slate-600">✕</button>
      </div>
      <form onsubmit="window.app.saveEditedRegistration(event, '${reg.id}')" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">姓名</label>
          <input type="text" name="attendee_name" required value="${escapeHtml(reg.attendee_name)}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">聯絡電話</label>
          <input type="text" name="attendee_phone" required value="${escapeHtml(reg.attendee_phone)}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">服務單位／公司</label>
          <input type="text" name="attendee_org" value="${escapeHtml(reg.attendee_org || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        ${Object.entries(answers).map(([label, val]) => `
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">${escapeHtml(label)}</label>
            <input type="text" name="ans_${escapeHtml(label)}" value="${escapeHtml(val)}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
          </div>
        `).join('')}
        <div class="flex justify-end gap-2 pt-3">
          <button type="button" onclick="window.app.closeModal()" class="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold">取消</button>
          <button type="submit" class="px-5 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold">儲存修改</button>
        </div>
      </form>
    </div>
  `);
}

export async function saveEditedRegistration(e, regId) {
  e.preventDefault();
  const reg = state.myRegistrations.find(r => r.id === regId);
  if (!reg) return;
  const fd = new FormData(e.target);
  const newAnswers = {};
  for (const k of Object.keys(reg.form_answers || {})) {
    newAnswers[k] = fd.get(`ans_${k}`)?.toString().trim() || '';
  }

  const { error } = await supabase
    .from('registrations')
    .update({
      attendee_name: fd.get('attendee_name')?.toString().trim() || '',
      attendee_phone: fd.get('attendee_phone')?.toString().trim() || '',
      attendee_org: fd.get('attendee_org')?.toString().trim() || '',
      form_answers: newAnswers,
      updated_at: new Date().toISOString()
    })
    .eq('id', regId);

  if (error) {
    showToast('更新失敗：' + error.message, 'error');
    return;
  }

  closeModal();
  showToast('報名資料已更新', 'success');
  await fetchMyRegistrations();
  renderMainView();
}

export async function cancelRegistration(regId) {
  const { error } = await supabase
    .from('registrations')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', regId);

  if (error) {
    showToast('取消失敗：' + error.message, 'error');
    return;
  }
  showToast('已取消該筆報名並釋出名額', 'info');
  await Promise.all([fetchEvents(), fetchMyRegistrations()]);
  renderMainView();
}

// ============================================================================
// 10. 後台管理動作 (對帳確認、切換上架狀態、新增/編輯活動與自訂表單、CSV 匯出)
// ============================================================================
export async function verifyPaymentAndConfirm(regId) {
  const { error } = await supabase
    .from('registrations')
    .update({
      status: 'confirmed',
      payment_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', regId);

  if (error) {
    showToast('審核更新失敗：' + error.message, 'error');
    return;
  }

  showToast('已確認收款並核發學員 QR Code 電子票券！', 'success');
  await fetchAdminRegistrations();
  renderMainView();
}

export async function adminCancelRegistration(regId) {
  const { error } = await supabase
    .from('registrations')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', regId);

  if (error) {
    showToast('操作失敗：' + error.message, 'error');
    return;
  }
  showToast('已取消該筆報名', 'info');
  await Promise.all([fetchEvents(), fetchAdminRegistrations()]);
  renderMainView();
}

export async function updateEventStatus(eventId, newStatus) {
  const { error } = await supabase
    .from('events')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    showToast('狀態更新失敗：' + error.message, 'error');
    return;
  }
  showToast('活動上架狀態已更新', 'success');
  await fetchEvents();
}

// 開啟新增／編輯活動與自訂表單欄位建構器 Modal
export function openEventEditorModal(eventId = null) {
  const existing = eventId ? state.events.find(e => e.id === eventId) : null;
  state.editingEvent = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        id: null,
        title: '',
        slug: `event-${Date.now().toString().slice(-6)}`,
        subtitle: '',
        category: '工作坊',
        description: '',
        speaker_name: '',
        speaker_title: '',
        speaker_bio: '',
        cover_image_url: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1200&q=80',
        location: '台北市信義區數位創新中心',
        location_address: '台北市信義區松仁路 100 號',
        start_time: '2026-12-12T14:00',
        end_time: '2026-12-12T17:00',
        reg_end_time: '2026-12-11T23:59',
        status: 'published',
        is_featured: false,
        custom_fields: [
          { id: 'job_title', label: '目前職稱', type: 'text', required: true },
          { id: 'dietary', label: '餐點需求', type: 'select', required: true, options: ['葷食', '素食', '不需準備'] }
        ],
        ticket_types: [
          { name: '一般報名票', description: '含活動入場與講義教材', price: 800, quota: 40 }
        ]
      };

  renderEventEditorModalContent();
}

function renderEventEditorModalContent() {
  const ev = state.editingEvent;
  const startLocal = ev.start_time ? new Date(ev.start_time).toISOString().slice(0, 16) : '2026-12-12T14:00';
  const endLocal = ev.end_time ? new Date(ev.end_time).toISOString().slice(0, 16) : '2026-12-12T17:00';

  openModal(`
    <div class="p-6 md:p-8 max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-6">
        <h3 class="text-xl font-extrabold text-slate-900">${ev.id ? '✏️ 編輯活動與自訂報名表單' : '＋ 新增活動與自訂報名表單'}</h3>
        <button onclick="window.app.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl">✕</button>
      </div>

      <form id="admin-event-form" onsubmit="window.app.saveEventFromModal(event)" class="space-y-5 text-sm">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="md:col-span-2">
            <label class="block text-xs font-bold text-slate-700 mb-1">活動名稱 <span class="text-rose-500">*</span></label>
            <input type="text" name="title" required value="${escapeHtml(ev.title)}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">活動分類</label>
            <select name="category" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 bg-white">
              ${['講座', '工作坊', '課程', '論壇', '社群聚會'].map(c => `<option value="${c}" ${ev.category === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">副標題／簡短亮點</label>
          <input type="text" name="subtitle" value="${escapeHtml(ev.subtitle)}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">開始時間</label>
            <input type="datetime-local" name="start_time" required value="${startLocal}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">結束時間</label>
            <input type="datetime-local" name="end_time" required value="${endLocal}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">場地名稱</label>
            <input type="text" name="location" required value="${escapeHtml(ev.location)}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">場地詳細地址</label>
            <input type="text" name="location_address" value="${escapeHtml(ev.location_address || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">講師姓名</label>
            <input type="text" name="speaker_name" value="${escapeHtml(ev.speaker_name || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">講師頭銜</label>
            <input type="text" name="speaker_title" value="${escapeHtml(ev.speaker_title || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">封面圖片網址 (URL)</label>
          <input type="url" name="cover_image_url" value="${escapeHtml(ev.cover_image_url || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200" />
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">活動詳細介紹與議程</label>
          <textarea name="description" rows="4" class="w-full px-3.5 py-2 rounded-xl border border-slate-200">${escapeHtml(ev.description || '')}</textarea>
        </div>

        <!-- 動態票種設定區 -->
        <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-extrabold text-slate-800 uppercase">🎟️ 票種與名額設定</span>
            <button type="button" onclick="window.app.addTicketRowInEditor()" class="px-3 py-1 rounded-lg bg-indigo-50 text-indigo-700 font-bold text-xs">+ 新增票種</button>
          </div>
          <div id="editor-tickets-container" class="space-y-2">
            ${(ev.ticket_types || []).map((t, idx) => `
              <div class="grid grid-cols-12 gap-2 items-center bg-white p-2.5 rounded-xl border border-slate-200">
                <input type="text" placeholder="票種名稱" value="${escapeHtml(t.name)}" onchange="window.app.updateEditorTicket(${idx}, 'name', this.value)" class="col-span-4 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs" required />
                <input type="number" placeholder="票價(0=免費)" value="${t.price}" onchange="window.app.updateEditorTicket(${idx}, 'price', this.value)" class="col-span-3 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs" required />
                <input type="number" placeholder="名額" value="${t.quota}" onchange="window.app.updateEditorTicket(${idx}, 'quota', this.value)" class="col-span-2 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs" required />
                <input type="text" placeholder="票種說明" value="${escapeHtml(t.description || '')}" onchange="window.app.updateEditorTicket(${idx}, 'description', this.value)" class="col-span-3 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs" />
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 動態自訂表單欄位建構器 -->
        <div class="p-4 rounded-2xl bg-indigo-50/40 border border-indigo-100 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-extrabold text-indigo-950 uppercase">📝 自訂報名表單欄位 (Custom Form Builder)</span>
            <button type="button" onclick="window.app.addCustomFieldInEditor()" class="px-3 py-1 rounded-lg bg-indigo-600 text-white font-bold text-xs">+ 新增自訂問題欄位</button>
          </div>
          <div class="space-y-2">
            ${(ev.custom_fields || []).map((f, idx) => `
              <div class="grid grid-cols-12 gap-2 items-center bg-white p-2.5 rounded-xl border border-indigo-100">
                <input type="text" placeholder="欄位題目名稱" value="${escapeHtml(f.label)}" onchange="window.app.updateEditorCustomField(${idx}, 'label', this.value)" class="col-span-4 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs" required />
                <select onchange="window.app.updateEditorCustomField(${idx}, 'type', this.value)" class="col-span-3 px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white">
                  <option value="text" ${f.type === 'text' ? 'selected' : ''}>單行文字 (Text)</option>
                  <option value="textarea" ${f.type === 'textarea' ? 'selected' : ''}>多行問答 (Textarea)</option>
                  <option value="select" ${f.type === 'select' ? 'selected' : ''}>下拉單選 (Select)</option>
                </select>
                <input type="text" placeholder="單選選項 (以逗號分隔)" value="${escapeHtml((f.options || []).join(','))}" onchange="window.app.updateEditorCustomField(${idx}, 'options', this.value)" class="col-span-3 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs" />
                <label class="col-span-1 flex items-center gap-1 text-[11px] text-slate-600">
                  <input type="checkbox" ${f.required ? 'checked' : ''} onchange="window.app.updateEditorCustomField(${idx}, 'required', this.checked)" />必填
                </label>
                <button type="button" onclick="window.app.removeCustomFieldInEditor(${idx})" class="col-span-1 text-rose-500 hover:text-rose-700 text-xs font-bold">刪除</button>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="flex justify-end gap-3 pt-4 border-t border-slate-100">
          <button type="button" onclick="window.app.closeModal()" class="px-5 py-2.5 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold">取消</button>
          <button type="submit" class="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm">儲存並發佈活動設定</button>
        </div>
      </form>
    </div>
  `);
}

function syncEditorFormInputs() {
  const form = document.getElementById('admin-event-form');
  if (!form || !state.editingEvent) return;
  const fd = new FormData(form);
  state.editingEvent.title = fd.get('title')?.toString() || state.editingEvent.title;
  state.editingEvent.category = fd.get('category')?.toString() || state.editingEvent.category;
  state.editingEvent.subtitle = fd.get('subtitle')?.toString() || '';
  state.editingEvent.location = fd.get('location')?.toString() || '';
  state.editingEvent.location_address = fd.get('location_address')?.toString() || '';
  state.editingEvent.speaker_name = fd.get('speaker_name')?.toString() || '';
  state.editingEvent.speaker_title = fd.get('speaker_title')?.toString() || '';
  state.editingEvent.cover_image_url = fd.get('cover_image_url')?.toString() || '';
  state.editingEvent.description = fd.get('description')?.toString() || '';
}

export function addTicketRowInEditor() {
  syncEditorFormInputs();
  state.editingEvent.ticket_types.push({
    name: '新票種',
    description: '',
    price: 500,
    quota: 30
  });
  renderEventEditorModalContent();
}

export function updateEditorTicket(idx, key, val) {
  const t = state.editingEvent.ticket_types[idx];
  if (!t) return;
  t[key] = key === 'price' || key === 'quota' ? parseInt(val || '0', 10) : val;
}

export function addCustomFieldInEditor() {
  syncEditorFormInputs();
  state.editingEvent.custom_fields.push({
    id: `field_${Date.now().toString().slice(-4)}`,
    label: '新自訂問題',
    type: 'text',
    required: false,
    options: []
  });
  renderEventEditorModalContent();
}

export function updateEditorCustomField(idx, key, val) {
  const f = state.editingEvent.custom_fields[idx];
  if (!f) return;
  if (key === 'options') {
    f.options = String(val).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    f[key] = val;
  }
}

export function removeCustomFieldInEditor(idx) {
  syncEditorFormInputs();
  state.editingEvent.custom_fields.splice(idx, 1);
  renderEventEditorModalContent();
}

export async function saveEventFromModal(e) {
  e.preventDefault();
  syncEditorFormInputs();
  const fd = new FormData(e.target);
  const start_time = new Date(fd.get('start_time')?.toString() || Date.now()).toISOString();
  const end_time = new Date(fd.get('end_time')?.toString() || Date.now()).toISOString();
  const ev = state.editingEvent;

  const payload = {
    title: ev.title,
    subtitle: ev.subtitle,
    category: ev.category,
    description: ev.description,
    speaker_name: ev.speaker_name,
    speaker_title: ev.speaker_title,
    cover_image_url: ev.cover_image_url,
    location: ev.location,
    location_address: ev.location_address,
    start_time,
    end_time,
    reg_end_time: start_time,
    custom_fields: ev.custom_fields,
    updated_at: new Date().toISOString()
  };

  if (ev.id) {
    const { error } = await supabase.from('events').update(payload).eq('id', ev.id);
    if (error) {
      showToast('儲存活動失敗：' + error.message, 'error');
      return;
    }
    for (const [idx, tk] of (ev.ticket_types || []).entries()) {
      if (tk.id) {
        await supabase.from('ticket_types').update({
          name: tk.name,
          price: Number(tk.price),
          quota: Number(tk.quota),
          description: tk.description || '',
          sort_order: idx + 1
        }).eq('id', tk.id);
      } else {
        await supabase.from('ticket_types').insert({
          event_id: ev.id,
          name: tk.name,
          price: Number(tk.price),
          quota: Number(tk.quota),
          description: tk.description || '',
          sort_order: idx + 1
        });
      }
    }
  } else {
    const { data: created, error } = await supabase
      .from('events')
      .insert({
        ...payload,
        slug: ev.slug,
        status: 'published',
        created_by: state.user?.id || null
      })
      .select('*')
      .single();

    if (error) {
      showToast('新增活動失敗：' + error.message, 'error');
      return;
    }

    for (const [idx, tk] of (ev.ticket_types || []).entries()) {
      await supabase.from('ticket_types').insert({
        event_id: created.id,
        name: tk.name,
        price: Number(tk.price),
        quota: Number(tk.quota),
        description: tk.description || '',
        sort_order: idx + 1
      });
    }
  }

  closeModal();
  showToast('活動與自訂表單設定已成功儲存！', 'success');
  await fetchEvents();
}

// 匯出 CSV (含 UTF-8 BOM 支援 Excel 直接開啟)
export function exportRegistrationsCsv() {
  const rows = state.adminRegistrations;
  if (!rows.length) {
    showToast('目前無報名資料可匯出', 'info');
    return;
  }

  const headers = ['訂單編號', '活動名稱', '票種', '學員姓名', '聯絡電話', 'Email', '單位', '應付金額', '訂單狀態', '匯款後五碼', '報到驗證碼', '現場報到時間', '自訂欄位回答'];
  const csvLines = [headers.join(',')];

  for (const r of rows) {
    const ansStr = Object.entries(r.form_answers || {})
      .map(([k, v]) => `${k}:${v}`)
      .join(' | ');
    const cols = [
      r.id,
      r.events?.title || '',
      r.ticket_types?.name || '',
      r.attendee_name,
      r.attendee_phone,
      r.attendee_email,
      r.attendee_org || '',
      r.amount,
      r.status,
      r.payment_last5 || '',
      r.checkin_token,
      r.checked_in_at ? formatDateTime(r.checked_in_at) : '未報到',
      ansStr
    ].map(c => `"${String(c ?? '').replace(/"/g, '""')}"`);
    csvLines.push(cols.join(','));
  }

  const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `registrations_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已匯出 Excel (CSV) 報名名單！', 'success');
}

// ============================================================================
// 11. 現場 QR Code 掃描與核銷 (Check-in Verification)
// ============================================================================
export async function performCheckInByToken(token) {
  const cleanToken = (token || '').trim();
  if (!cleanToken) return;

  const { data: existing, error: findErr } = await supabase
    .from('registrations')
    .select('*, events(title), ticket_types(name)')
    .eq('checkin_token', cleanToken)
    .maybeSingle();

  const banner = document.getElementById('checkin-result-banner');

  if (findErr || !existing) {
    showToast('查無此票券驗證碼！請確認票號是否正確', 'error');
    if (banner) {
      banner.className = 'mt-4 p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold';
      banner.textContent = `❌ 驗證失敗：找不到票號 "${cleanToken}"`;
    }
    return;
  }

  if (existing.checked_in_at) {
    const msg = `⚠️ 學員【${existing.attendee_name}】已於 ${formatDateTime(existing.checked_in_at)} 報到過，請勿重複入場！`;
    showToast(msg, 'error');
    if (banner) {
      banner.className = 'mt-4 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-bold';
      banner.textContent = msg;
    }
    return;
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('registrations')
    .update({
      status: 'confirmed',
      checked_in_at: nowIso,
      updated_at: nowIso
    })
    .eq('id', existing.id);

  if (updErr) {
    showToast('簽到寫入失敗：' + updErr.message, 'error');
    return;
  }

  const okMsg = `✅ 報到成功！【${existing.attendee_name}】— ${existing.events?.title || ''} (${existing.ticket_types?.name || ''})`;
  showToast(okMsg, 'success');
  await fetchAdminRegistrations();
  renderMainView();

  const updatedBanner = document.getElementById('checkin-result-banner');
  if (updatedBanner) {
    updatedBanner.className = 'mt-4 p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm font-bold';
    updatedBanner.textContent = okMsg;
  }
}

export async function handleManualTokenSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('manual-checkin-token');
  if (!input) return;
  await performCheckInByToken(input.value);
  input.value = '';
}

export async function startQrScanner() {
  if (state.scannerRunning) return;
  if (!window.Html5Qrcode) {
    showToast('正在載入掃描器元件，請稍候再試', 'info');
    return;
  }
  try {
    const scanner = new window.Html5Qrcode('qr-reader');
    state.qrScanner = scanner;
    state.scannerRunning = true;
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        await stopQrScanner();
        await performCheckInByToken(decodedText);
      },
      () => {}
    );
  } catch (err) {
    state.scannerRunning = false;
    showToast('無法啟動相機鏡頭（請確認瀏覽器相機權限，或改用下方票號輸入核銷）', 'error');
  }
}

export async function stopQrScanner() {
  if (state.qrScanner && state.scannerRunning) {
    try {
      await state.qrScanner.stop();
      await state.qrScanner.clear();
    } catch (_) {}
  }
  state.scannerRunning = false;
  state.qrScanner = null;
}

// ============================================================================
// 12. 會員註冊、登入與個人資料 Modal
// ============================================================================
export function openAuthModal(mode = 'login') {
  const isLogin = mode === 'login';
  openModal(`
    <div class="p-6 md:p-8">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-xl font-extrabold text-slate-900">${isLogin ? '會員／管理員登入' : '免費註冊會員帳號'}</h3>
        <button onclick="window.app.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl">✕</button>
      </div>
      <p class="text-xs text-slate-500 mb-6">
        ${isLogin ? '登入以報名活動、管理票券與進入主辦方後台' : '註冊即刻開通報名與管理後台完整體驗權限（免等待驗證信）'}
      </p>

      <form onsubmit="window.app.handleAuthSubmit(event, '${mode}')" class="space-y-4">
        ${!isLogin ? `
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">您的姓名 <span class="text-rose-500">*</span></label>
            <input type="text" name="full_name" required placeholder="例如：王小明" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 mb-1">聯絡手機 <span class="text-rose-500">*</span></label>
            <input type="tel" name="phone" required placeholder="0912-345-678" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
        ` : ''}
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">電子信箱 Email <span class="text-rose-500">*</span></label>
          <input type="email" name="email" required placeholder="you@example.com" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">密碼（至少 6 碼） <span class="text-rose-500">*</span></label>
          <input type="password" name="password" required minlength="6" placeholder="••••••••" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
        </div>

        <button type="submit" class="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm shadow-sm transition">
          ${isLogin ? '立即登入' : '立即完成註冊並登入'}
        </button>
      </form>

      <div class="mt-5 pt-4 border-t border-slate-100 text-center text-xs text-slate-500">
        ${isLogin ? `
          還沒有帳號嗎？
          <button onclick="window.app.openAuthModal('signup')" class="text-indigo-600 font-bold hover:underline">點此免費註冊</button>
        ` : `
          已經有帳號了嗎？
          <button onclick="window.app.openAuthModal('login')" class="text-indigo-600 font-bold hover:underline">返回登入</button>
        `}
      </div>
    </div>
  `);
}

export async function handleAuthSubmit(e, mode) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email')?.toString().trim() || '';
  const password = fd.get('password')?.toString() || '';

  if (mode === 'signup') {
    const full_name = fd.get('full_name')?.toString().trim() || '';
    const phone = fd.get('phone')?.toString().trim() || '';
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name, phone } }
    });
    if (error) {
      showToast('註冊失敗：' + error.message, 'error');
      return;
    }
    showToast('註冊成功！已自動為您登入', 'success');
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      showToast('登入失敗：' + error.message, 'error');
      return;
    }
    showToast('歡迎回來！登入成功', 'success');
  }

  closeModal();
  await loadSessionAndProfile();
  await fetchMyRegistrations();
  renderMainView();
}

export function openProfileModal() {
  if (!state.user) return;
  const p = state.profile || {};
  openModal(`
    <div class="p-6 md:p-8">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-lg font-extrabold text-slate-900">⚙️ 個人基本資料設定</h3>
        <button onclick="window.app.closeModal()" class="text-slate-400 hover:text-slate-600 text-xl">✕</button>
      </div>
      <p class="text-xs text-slate-500 mb-5">設定後，未來報名任何活動時將自動預填以下聯絡資訊</p>
      <form onsubmit="window.app.saveProfile(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">姓名</label>
          <input type="text" name="full_name" required value="${escapeHtml(p.full_name || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">聯絡手機</label>
          <input type="tel" name="phone" value="${escapeHtml(p.phone || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 mb-1">服務單位／公司名稱</label>
          <input type="text" name="organization" value="${escapeHtml(p.organization || '')}" class="w-full px-3.5 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div class="flex justify-end gap-2 pt-3">
          <button type="button" onclick="window.app.closeModal()" class="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold">取消</button>
          <button type="submit" class="px-5 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold">儲存設定</button>
        </div>
      </form>
    </div>
  `);
}

export async function saveProfile(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: fd.get('full_name')?.toString().trim() || '',
      phone: fd.get('phone')?.toString().trim() || '',
      organization: fd.get('organization')?.toString().trim() || '',
      updated_at: new Date().toISOString()
    })
    .eq('id', state.user.id);

  if (error) {
    showToast('儲存失敗：' + error.message, 'error');
    return;
  }
  closeModal();
  await ensureProfile();
  renderNavbar();
  renderMainView();
  showToast('個人聯絡資料已更新', 'success');
}

export async function signOut() {
  await supabase.auth.signOut();
  state.user = null;
  state.profile = null;
  state.myRegistrations = [];
  showToast('您已安全登出', 'info');
  renderNavbar();
  renderMainView();
}

// Modal 控制
export function openModal(htmlContent) {
  const backdrop = document.getElementById('modal-backdrop');
  const box = document.getElementById('modal-box');
  if (!backdrop || !box) return;
  box.innerHTML = htmlContent;
  backdrop.classList.remove('hidden');
  backdrop.classList.add('flex');
}

export function closeModal() {
  const backdrop = document.getElementById('modal-backdrop');
  if (!backdrop) return;
  backdrop.classList.add('hidden');
  backdrop.classList.remove('flex');
}

// 系統啟動初始化
async function initApp() {
  await loadSessionAndProfile();
  await fetchEvents();
  supabase.auth.onAuthStateChange(async () => {
    await loadSessionAndProfile();
  });
}

window.app = {
  navigateTo,
  setSearchQuery,
  setCategory,
  resetFilter,
  selectTicket,
  setAdminTab,
  setAdminEventFilter,
  setAdminStatusFilter,
  submitRegistration,
  openPaymentModal,
  submitPaymentReport,
  openQrTicketModal,
  openEditRegModal,
  saveEditedRegistration,
  cancelRegistration,
  verifyPaymentAndConfirm,
  adminCancelRegistration,
  updateEventStatus,
  openEventEditorModal,
  addTicketRowInEditor,
  updateEditorTicket,
  addCustomFieldInEditor,
  updateEditorCustomField,
  removeCustomFieldInEditor,
  saveEventFromModal,
  exportRegistrationsCsv,
  performCheckInByToken,
  handleManualTokenSubmit,
  startQrScanner,
  stopQrScanner,
  openAuthModal,
  handleAuthSubmit,
  openProfileModal,
  saveProfile,
  signOut,
  closeModal
};

initApp();
