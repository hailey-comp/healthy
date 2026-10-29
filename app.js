(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => "₩" + Math.round(n).toLocaleString("ko-KR");
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const validFileId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{10,120}$/.test(s);
  const WD = ["월", "화", "수", "목", "금", "토", "일"];
  const KINDS = ["러닝", "걷기", "헬스", "수영", "자전거", "등산", "요가·필라테스", "구기 종목"];
  const KEY_STORE = "healthy.key";
  const API = (window.HEALTHY_CONFIG && window.HEALTHY_CONFIG.apiUrl) || "";

  const S = {
    me: null, members: [], entries: [], settings: null, loaded: false,
    view: (() => { try { return localStorage.getItem("healthy.view") === "month" ? "month" : "week"; } catch (_) { return "week"; } })(),
    weekOffset: 0, monthOffset: 0, mineOnly: false,
    editingId: null, photoFile: null, photoRemoved: false, intensity: "normal",
    bodies: {}, inbody: [],
  };

  // ---------- key: 링크의 #k=… 를 이 기기에 저장하고 주소창에서는 지움 ----------
  function readKey() {
    const m = location.hash.match(/k=([A-Za-z0-9]+)/);
    if (m) {
      try { localStorage.setItem(KEY_STORE, m[1]); } catch (_) {}
      history.replaceState(null, "", location.pathname + location.search);
      return m[1];
    }
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (_) { return ""; }
  }
  let KEY = readKey();
  // 페이지가 열린 상태에서 다른 링크(#k=…)로 들어오면 그 키로 다시 시작
  window.addEventListener("hashchange", () => { if (/k=[A-Za-z0-9]+/.test(location.hash)) { readKey(); location.reload(); } });

  function showGate(title, text) {
    $("#app").hidden = true; $("#fab").hidden = true; $("#gate").hidden = false;
    if (title) $("#gateTitle").textContent = title;
    if (text) $("#gateText").textContent = text;
  }

  // ---------- API ----------
  async function api(action, payload = {}) {
    let res;
    try {
      // Content-Type을 지정하지 않아야(text/plain) Apps Script가 CORS 사전 요청 없이 받음
      res = await fetch(API, { method: "POST", body: JSON.stringify({ k: KEY, action, ...payload }) });
    } catch (_) {
      throw { error: "network", message: "서버에 연결하지 못했어요. 인터넷 연결을 확인해주세요." };
    }
    let data;
    try { data = await res.json(); } catch (_) { throw { error: "bad_response", message: "서버 응답을 읽지 못했어요. Apps Script 배포 설정을 확인해주세요." }; }
    if (!data.ok) {
      if (data.error === "invalid_key") {
        try { localStorage.removeItem(KEY_STORE); } catch (_) {}
        showGate("링크가 더 이상 유효하지 않아요", "링크가 재발급되었거나 참가자 목록에서 빠졌어요. 내기를 만든 친구에게 새 링크를 받아주세요.");
      }
      throw data;
    }
    return data;
  }
  const errText = (e) => {
    if (e && e.error === "unknown_action") return "서버 코드가 예전 버전이에요. Apps Script에 새 Code.gs를 붙여넣고 새 버전으로 배포해주세요.";
    return (e && e.message) || "저장하지 못했어요. 잠시 뒤 다시 시도해주세요.";
  };

  function apply(data) {
    if (data.me) S.me = data.me;
    if (data.members) S.members = data.members;
    if (data.entries) S.entries = data.entries;
    if (data.settings) S.settings = data.settings;
    if (data.bodies) S.bodies = data.bodies;
    if (data.inbody) S.inbody = data.inbody;
    S.loaded = true;
    render();
  }

  async function load() {
    try { apply(await api("state")); }
    catch (e) {
      if (e && e.error === "invalid_key") return;
      if (!S.loaded) $("#board").innerHTML = `<div class="empty"><strong>기록을 불러오지 못했어요</strong>${esc(errText(e))}</div>`;
    }
  }

  // ---------- config ----------
  function cfg() {
    const c = S.settings || {};
    const fine = Number(c.fine);
    return {
      title: (c.title || "").trim() || "주 3회 운동 내기",
      goal: Math.min(7, Math.max(1, Number(c.goal) || 3)),
      fine: Number.isFinite(fine) && fine >= 0 ? fine : 10000,
      start: validDate(c.start) ? c.start : ymd(mondayOf(new Date())),
      rules: parseRules(c),
    };
  }
  // 추가 규칙 목록. 예전 버전의 '벌금 사용처 / 메모'는 첫 규칙으로 보여줌
  function parseRules(c) {
    let r = c.rules;
    if (typeof r === "string") { try { r = JSON.parse(r || "[]"); } catch (_) { r = []; } }
    r = Array.isArray(r) ? r.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!r.length && c.note) r = [String(c.note)];
    return r;
  }

  // ---------- derived ----------
  function members() {
    const byId = {};
    const list = S.members.map((m) => (byId[m.id] = { ...m, list: [] }));
    for (const e of S.entries) if (byId[e.memberId] && validDate(e.date)) byId[e.memberId].list.push(e);
    return list;
  }
  function daysIn(list, monday) {
    const a = ymd(monday), b = ymd(addDays(monday, 6));
    const set = new Set();
    for (const e of list) if (e.date >= a && e.date <= b) set.add(e.date);
    return set;
  }
  function minutesIn(list, monday) {
    const a = ymd(monday), b = ymd(addDays(monday, 6));
    return list.reduce((t, e) => t + (e.date >= a && e.date <= b ? Number(e.minutes) || 0 : 0), 0);
  }
  function missedWeeks(m) {
    const c = cfg();
    const thisMon = mondayOf(new Date());
    let w = mondayOf(parseYmd(c.start));
    if (m.joinedAt) { const j = mondayOf(new Date(m.joinedAt)); if (j > w) w = j; }
    let missed = 0, guard = 0;
    while (w < thisMon && guard++ < 520) {
      if (daysIn(m.list, w).size < c.goal) missed++;
      w = addDays(w, 7);
    }
    return missed;
  }
  const selMonday = () => addDays(mondayOf(new Date()), S.weekOffset * 7);
  const selMonth = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth() + S.monthOffset, 1); };
  const hueOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const kcalIn = (list, a, b) => list.reduce((t, e) => t + (e.date >= a && e.date <= b ? Number(e.kcal) || 0 : 0), 0);
  const nameBtn = (m) => `<button type="button" class="namebtn" data-member="${esc(m.id)}">${esc(m.name || "친구")}</button>`;
  const fmtMinutes = (n) => (n >= 60 ? `${Math.floor(n / 60)}시간${n % 60 ? ` ${n % 60}분` : ""}` : `${n}분`);

  // 프로필 사진이 있으면 사진, 없거나 못 불러오면 이름 첫 글자
  function avatar(m, previewUrl) {
    const h = hueOf(m.id);
    const initial = (m.name || "?").trim().charAt(0) || "?";
    const style = `background:hsl(${h} 55% 42%)`;
    const src = previewUrl || (validFileId(m.avatar) ? photoSrc(m.avatar, 200) : "");
    if (src) return `<img class="avatar" src="${esc(src)}" data-initial="${esc(initial)}" style="${style}" alt="" referrerpolicy="no-referrer">`;
    return `<span class="avatar" style="${style}" aria-hidden="true">${esc(initial)}</span>`;
  }
  document.addEventListener("error", (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("avatar")) return;
    const span = document.createElement("span");
    span.className = "avatar";
    span.setAttribute("style", img.getAttribute("style") || "");
    span.setAttribute("aria-hidden", "true");
    span.textContent = img.dataset.initial || "?";
    img.replaceWith(span);
  }, true);
  const photoSrc = (id, w) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
  const photoAlt = (id, w) => `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}=w${w}`;

  // ---------- render ----------
  function render() {
    if (!S.loaded) return;
    $("#gate").hidden = true; $("#app").hidden = false;
    const c = cfg();
    const ms = members();
    const isAdmin = S.me && S.me.role === "admin";

    // header
    document.title = c.title + " · JJJ Healthy Girl";
    $("#title").textContent = c.title;
    const pot = ms.reduce((t, m) => t + missedWeeks(m) * c.fine, 0);
    const startD = parseYmd(c.start);
    $("#rules").innerHTML =
      `<span class="rule">주 ${c.goal}일 이상</span>` +
      `<span class="rule">미달 시 ${esc(won(c.fine))}</span>` +
      `<span class="rule">${startD.getMonth() + 1}월 ${startD.getDate()}일 주부터</span>` +
      `<span class="rule pot">모인 벌금 <span class="num">${esc(won(pot))}</span></span>` +
      (isAdmin ? `<button class="linkbtn" type="button" id="editRules">규칙 수정</button>` : "");
    $("#ruleList").innerHTML = c.rules.map((r) => `<li>${esc(r)}</li>`).join("");
    $("#ruleList").hidden = !c.rules.length;

    // 기간: 주간 또는 월별
    const isWeek = S.view === "week";
    $("#viewWeek").setAttribute("aria-pressed", String(isWeek));
    $("#viewMonth").setAttribute("aria-pressed", String(!isWeek));
    const mon = selMonday();
    const sun = addDays(mon, 6);
    const m1 = selMonth();
    const mEnd = new Date(m1.getFullYear(), m1.getMonth() + 1, 0);
    const isCurrent = isWeek ? S.weekOffset === 0 : S.monthOffset === 0;
    if (isWeek) {
      $("#weekTitle").textContent = isCurrent ? "이번 주" : S.weekOffset === -1 ? "지난 주" : `${-S.weekOffset}주 전`;
      $("#weekRange").textContent = `${mon.getMonth() + 1}.${mon.getDate()} – ${sun.getMonth() + 1}.${sun.getDate()}`;
    } else {
      $("#weekTitle").textContent = isCurrent ? "이번 달" : S.monthOffset === -1 ? "지난 달" : `${-S.monthOffset}개월 전`;
      $("#weekRange").textContent = `${m1.getFullYear()}년 ${m1.getMonth() + 1}월`;
    }
    $("#next").disabled = isCurrent;
    $("#boardSub").textContent = isWeek ? "요일별 운동한 날" : "날짜별 운동한 멤버";
    const rangeA = isWeek ? ymd(mon) : ymd(m1);
    const rangeB = isWeek ? ymd(sun) : ymd(mEnd);

    // board
    const today = ymd(new Date());
    const daysLeft = 7 - ((new Date().getDay() + 6) % 7); // 오늘 포함
    const board = $("#board");
    if (!ms.length) {
      board.innerHTML = `<div class="empty"><strong>아직 참가한 사람이 없어요</strong>${isAdmin ? "아래 ‘참가자 관리’에서 친구를 추가하고 링크를 보내주세요." : "친구들이 참가하면 여기에 표시돼요."}</div>`;
    } else if (!isWeek) {
      board.innerHTML = monthBoard(ms, m1, mEnd, today);
    } else {
      const rows = ms.map((m) => ({ m, days: daysIn(m.list, mon), mins: minutesIn(m.list, mon), kcal: kcalIn(m.list, ymd(mon), ymd(sun)), missed: missedWeeks(m) }))
        .sort((a, b) => b.days.size - a.days.size || b.mins - a.mins || String(a.m.name).localeCompare(String(b.m.name), "ko"));
      board.innerHTML = rows.map((r, i) => {
        const done = r.days.size;
        let chip;
        if (done >= c.goal) chip = `<span class="chip good">달성</span>`;
        else if (!isCurrent) chip = `<span class="chip bad">벌금 ${esc(won(c.fine))}</span>`;
        else if (c.goal - done > daysLeft) chip = `<span class="chip bad">미달 확정</span>`;
        else chip = `<span class="chip wait">${c.goal - done}일 더</span>`;
        const dots = WD.map((w, k) => {
          const d = ymd(addDays(mon, k));
          return `<span class="dot${r.days.has(d) ? " on" : ""}${d === today ? " today" : ""}" title="${d}">${w}</span>`;
        }).join("");
        const isMe = S.me && r.m.id === S.me.id;
        // 벌금이 생긴 멤버에게만 표시
        const owed = r.missed && c.fine > 0
          ? `<div class="owed"><span>지금까지 미달 <span class="num">${r.missed}</span>주</span><span>낼 벌금 <b>${esc(won(r.missed * c.fine))}</b></span></div>`
          : "";
        return `<div class="mcard${isMe ? " mine" : ""}">
          <div class="mtop">${avatar(r.m)}<span class="rank">${i + 1}위</span></div>
          <div class="name">${nameBtn(r.m)}${isMe ? `<span class="me">나</span>` : ""}</div>
          <div class="mscore"><span class="count">${done}<small>/${c.goal}일</small></span>${chip}</div>
          <div class="dots">${dots}</div>
          ${r.kcal ? `<span class="kcalsum">약 ${r.kcal.toLocaleString("ko-KR")}kcal</span>` : ""}
          ${owed}
        </div>`;
      }).join("");
      board.innerHTML = `<div class="mstrip">${board.innerHTML}</div>`;
    }
    $("#boardKcalNote").hidden = !ms.some((m) => kcalIn(m.list, rangeA, rangeB) > 0);

    // feed
    const a = rangeA, b = rangeB;
    const byId = Object.fromEntries(ms.map((m) => [m.id, m]));
    let entries = S.entries.filter((e) => byId[e.memberId] && e.date >= a && e.date <= b);
    if (S.mineOnly && S.me) entries = entries.filter((e) => e.memberId === S.me.id);
    entries.sort((x, y) => y.date.localeCompare(x.date) || (Number(y.createdAt) || 0) - (Number(x.createdAt) || 0));
    $("#feedCount").textContent = `${entries.length}개`;
    $("#feedKcalNote").hidden = !entries.some((e) => e.kcal > 0);
    const feed = $("#feed");
    if (!entries.length) {
      feed.innerHTML = `<div class="card veiled"><div class="empty"><strong>${isWeek ? (isCurrent ? "이번 주" : "이 주") : (isCurrent ? "이번 달" : "이 달")} 기록이 아직 없어요</strong>운동하고 ‘+ 기록하기’로 날짜, 종목, 시간, 사진을 남기면 여기에 쌓여요.</div></div>`;
    } else {
      let lastDate = "";
      feed.innerHTML = entries.map((e) => {
        const m = byId[e.memberId];
        const mine = S.me && e.memberId === S.me.id;
        const d = parseYmd(e.date);
        let head = "";
        if (e.date !== lastDate) { lastDate = e.date; head = `<div class="daylabel">${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[(d.getDay() + 6) % 7]}요일</div>`; }
        const stats = [Number(e.minutes) > 0 ? `${Number(e.minutes)}분` : "", Number(e.km) > 0 ? `${Number(e.km)}km` : "", e.kcal > 0 ? `약 ${Number(e.kcal).toLocaleString("ko-KR")}kcal` : ""].filter(Boolean).join(" · ");
        const veiled = e.hidden && !mine;
        const photo = !veiled && validFileId(e.photo)
          ? `<button type="button" class="photo" data-act="zoom" data-id="${esc(e.photo)}"><img src="${esc(photoSrc(e.photo, 1200))}" data-alt="${esc(photoAlt(e.photo, 1200))}" alt="${esc(m.name)}의 운동 사진" loading="lazy" referrerpolicy="no-referrer"></button>` : "";
        const memo = !veiled && e.memo ? `<p class="memo">${esc(e.memo)}</p>` : "";
        let actions = "";
        if (mine) {
          actions = `<div class="actions">
            <button type="button" class="act" data-act="edit" data-id="${esc(e.id)}">수정</button>
            <button type="button" class="act" data-act="hide" data-id="${esc(e.id)}">${e.hidden ? "공개하기" : "숨기기"}</button>
            <button type="button" class="act danger" data-act="del" data-id="${esc(e.id)}">삭제</button>
          </div>`;
        } else if (isAdmin) {
          actions = `<div class="actions"><button type="button" class="act danger" data-act="del" data-id="${esc(e.id)}">관리자 삭제</button></div>`;
        }
        return `${head}<article class="card${veiled ? " veiled" : ""}">
          <div class="card-head">${avatar(m)}<span class="name">${esc(m.name || "친구")}</span>${e.hidden ? `<span class="badge">${mine ? "숨김 · 나만 보기" : "숨긴 기록"}</span>` : ""}<span class="when num">${d.getMonth() + 1}.${d.getDate()}</span></div>
          <div class="what"><span class="kind">${esc(e.kind || "운동")}</span>${stats ? `<span class="stats">${esc(stats)}</span>` : ""}</div>
          ${veiled ? `<p class="veil-note">사진과 메모는 숨겨져 있어요. 운동한 날은 멤버 현황에 반영돼요.</p>` : ""}
          ${memo}${photo}${actions}
        </article>`;
      }).join("");
      feed.querySelectorAll(".photo img").forEach((img) => img.addEventListener("error", function onErr() {
        if (img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ""; return; }
        img.removeEventListener("error", onErr);
        const btn = img.parentElement; btn.classList.add("broken"); btn.textContent = "사진을 불러올 수 없어요"; btn.disabled = true;
      }));
    }

    // footer / fab
    $("#meLine").textContent = S.me ? `${S.me.name || "나"}(으)로 참여 중` : "";
    $("#manage").hidden = !isAdmin;
    $("#fab").hidden = false;
  }

  // 월별 보기: 달력(날짜마다 운동한 멤버 색 점) + 멤버별 합계
  function monthBoard(ms, m1, mEnd, today) {
    const a = ymd(m1), b = ymd(mEnd);
    const byDate = {};
    const rows = ms.map((m) => {
      const list = m.list.filter((e) => e.date >= a && e.date <= b);
      const days = new Set(list.map((e) => e.date));
      days.forEach((d) => (byDate[d] = byDate[d] || []).push(m));
      return {
        m, days: days.size, n: list.length,
        mins: list.reduce((t, e) => t + (Number(e.minutes) || 0), 0),
        km: Math.round(list.reduce((t, e) => t + (Number(e.km) || 0), 0) * 10) / 10,
        kcal: kcalIn(list, a, b),
      };
    }).sort((x, y) => y.days - x.days || y.mins - x.mins || String(x.m.name).localeCompare(String(y.m.name), "ko"));

    let cal = WD.map((w) => `<div class="wd">${w}</div>`).join("");
    cal += "<div></div>".repeat((m1.getDay() + 6) % 7);
    for (let d = 1; d <= mEnd.getDate(); d++) {
      const ds = ymd(new Date(m1.getFullYear(), m1.getMonth(), d));
      const who = byDate[ds] || [];
      const dots = who.slice(0, 6).map((m) => `<i style="background:hsl(${hueOf(m.id)} 55% 42%)" title="${esc(m.name)}"></i>`).join("")
        + (who.length > 6 ? `<em>+${who.length - 6}</em>` : "");
      const label = `${m1.getMonth() + 1}월 ${d}일${who.length ? ": " + who.map((m) => m.name).join(", ") : ""}`;
      cal += `<div class="cday${who.length ? " has" : ""}${ds === today ? " today" : ""}${ds > today ? " future" : ""}" title="${esc(label)}" aria-label="${esc(label)}"><span class="cnum">${d}</span><span class="cdots">${dots}</span></div>`;
    }

    const list = rows.map((r, i) => {
      const isMe = S.me && r.m.id === S.me.id;
      const stats = r.n
        ? `<span>총 <span class="num">${esc(fmtMinutes(r.mins))}</span>${r.km ? ` · <span class="num">${r.km}</span>km` : ""}</span>`
          + (r.kcal ? `<span>약 <span class="num">${r.kcal.toLocaleString("ko-KR")}</span>kcal</span>` : "")
          + `<span>기록 <span class="num">${r.n}</span>개</span>`
        : "<span>아직 기록 없음</span>";
      return `<div class="mcard${isMe ? " mine" : ""}">
        <div class="mtop">${avatar(r.m)}<span class="rank">${i + 1}위</span></div>
        <div class="name">${nameBtn(r.m)}${isMe ? `<span class="me">나</span>` : ""}</div>
        <div class="mscore"><span class="count">${r.days}<small>일</small></span></div>
        <div class="mstats">${stats}</div>
      </div>`;
    }).join("");
    return `<div class="cal">${cal}</div><div class="mstrip">${list}</div>`;
  }

  let toastTimer;
  function toast(t) {
    const el = $("#toast"); el.textContent = t; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- sheets ----------
  const anySheetOpen = () => [...document.querySelectorAll(".scrim")].some((s) => !s.hidden);
  function openSheet(id) { document.querySelectorAll(".scrim").forEach((s) => (s.hidden = s.id !== id)); }
  function closeSheets() { document.querySelectorAll(".scrim").forEach((s) => (s.hidden = true)); }
  document.querySelectorAll(".scrim:not(.confirm)").forEach((s) => {
    s.addEventListener("click", (ev) => { if (ev.target === s || ev.target.closest("[data-close]")) closeSheets(); });
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeSheets(); $("#lightbox").hidden = true; } });

  // intensity
  function setIntensity(v) {
    S.intensity = ["light", "normal", "hard"].includes(v) ? v : "normal";
    $("#f-int").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === S.intensity)));
  }
  $("#f-int").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-v]"); if (b) setIntensity(b.dataset.v); });

  // kinds
  $("#kindChips").innerHTML = KINDS.map((k) => `<button type="button" data-kind="${esc(k)}" aria-pressed="false">${esc(k)}</button>`).join("");
  function syncKinds() {
    const v = $("#f-kind").value.trim();
    $("#kindChips").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === v)));
  }
  $("#kindChips").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-kind]"); if (!b) return;
    $("#f-kind").value = b.dataset.kind; syncKinds();
  });
  $("#f-kind").addEventListener("input", syncKinds);

  // photo
  let previewUrl = null;
  function setPreview(src) {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    const img = $("#f-preview");
    if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute("src"); img.hidden = true; }
    $("#removePhoto").hidden = !src;
    $("#pickLabel").textContent = src ? "다른 사진" : "사진 선택";
  }
  $("#f-photo").addEventListener("change", () => {
    const f = $("#f-photo").files[0]; if (!f) return;
    S.photoFile = f; S.photoRemoved = false;
    setPreview(null);
    previewUrl = URL.createObjectURL(f);
    $("#f-preview").src = previewUrl; $("#f-preview").hidden = false;
    $("#removePhoto").hidden = false; $("#pickLabel").textContent = "다른 사진";
  });
  $("#removePhoto").addEventListener("click", () => { S.photoFile = null; S.photoRemoved = true; $("#f-photo").value = ""; setPreview(null); });

  // 긴 변 1600px JPEG로 줄여서 업로드 시간을 줄임
  async function shrink(file) {
    if (file.type === "image/gif") return file;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      const out = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.82));
      return out || file;
    } catch (_) { return file; }
  }
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  function openEntry(id) {
    const e = id ? S.entries.find((x) => x.id === id) : null;
    S.editingId = e ? id : null; S.photoFile = null; S.photoRemoved = false;
    $("#entryTitle").textContent = e ? "기록 수정하기" : "운동 기록하기";
    $("#f-date").value = e?.date || ymd(new Date());
    $("#f-date").max = ymd(new Date());
    $("#f-min").value = e?.minutes || "";
    $("#f-kind").value = e?.kind || "";
    $("#f-km").value = e?.km || "";
    $("#f-memo").value = e?.memo || "";
    $("#f-hidden").checked = !!e?.hidden;
    setIntensity(e?.intensity || "normal");
    $("#f-photo").value = "";
    setPreview(e && validFileId(e.photo) ? photoSrc(e.photo, 800) : null);
    $("#entryErr").hidden = true;
    syncKinds();
    openSheet("entrySheet");
  }

  $("#entryForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#entryErr");
    const date = $("#f-date").value;
    const kind = $("#f-kind").value.trim();
    if (!validDate(date)) { err.textContent = "날짜를 골라주세요."; err.hidden = false; return; }
    if (date > ymd(new Date())) { err.textContent = "미래 날짜에는 기록할 수 없어요."; err.hidden = false; return; }
    if (!kind) { err.textContent = "종목을 고르거나 직접 입력해주세요."; err.hidden = false; return; }
    err.hidden = true;
    const btn = $("#entrySave"); btn.disabled = true;
    try {
      const entry = {
        id: S.editingId || undefined,
        date, kind,
        minutes: Math.round(Number($("#f-min").value) || 0),
        km: Math.round((Number($("#f-km").value) || 0) * 10) / 10,
        memo: $("#f-memo").value.trim().slice(0, 1000),
        hidden: $("#f-hidden").checked,
        intensity: S.intensity,
        removePhoto: S.photoRemoved,
      };
      if (S.photoFile) {
        btn.textContent = "사진 올리는 중…";
        const blob = await shrink(S.photoFile);
        entry.photo = { mime: blob.type || "image/jpeg", data: await toBase64(blob) };
      } else {
        btn.textContent = "저장 중…";
      }
      apply(await api("saveEntry", { entry }));
      closeSheets();
      toast(S.editingId ? "수정했어요" : "기록했어요");
      const saved = parseYmd(date), now = new Date();
      S.weekOffset = Math.round((mondayOf(saved) - mondayOf(now)) / (7 * 864e5));
      S.monthOffset = (saved.getFullYear() - now.getFullYear()) * 12 + saved.getMonth() - now.getMonth();
      render();
    } catch (e) {
      if (e && e.error === "invalid_key") return;
      err.textContent = errText(e); err.hidden = false;
    } finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  // profile: 이름 + 프로필 사진
  const P = { file: null, removed: false, url: null };
  const myMember = () => (S.me && S.members.find((m) => m.id === S.me.id)) || S.me || { id: "", name: "" };
  function drawProfilePreview() {
    const m = { ...myMember(), name: $("#n-name").value.trim() || myMember().name };
    if (P.removed) m.avatar = "";
    $("#p-preview").innerHTML = avatar(m, P.url);
    const has = !!P.url || (!P.removed && validFileId(m.avatar));
    $("#p-remove").hidden = !has;
    $("#p-pick").textContent = has ? "사진 바꾸기" : "사진 올리기";
  }
  function resetProfilePhoto() {
    if (P.url) URL.revokeObjectURL(P.url);
    P.file = null; P.url = null; P.removed = false; $("#p-photo").value = "";
  }
  $("#rename").addEventListener("click", () => {
    resetProfilePhoto();
    $("#n-name").value = S.me?.name || ""; $("#nameErr").hidden = true;
    drawProfilePreview();
    openSheet("nameSheet");
  });
  $("#n-name").addEventListener("input", drawProfilePreview);
  $("#p-photo").addEventListener("change", () => {
    const f = $("#p-photo").files[0]; if (!f) return;
    if (P.url) URL.revokeObjectURL(P.url);
    P.file = f; P.url = URL.createObjectURL(f); P.removed = false;
    drawProfilePreview();
  });
  $("#p-remove").addEventListener("click", () => {
    if (P.url) URL.revokeObjectURL(P.url);
    P.file = null; P.url = null; P.removed = true; $("#p-photo").value = "";
    drawProfilePreview();
  });
  // 가운데를 정사각형으로 잘라 400px로 줄임
  async function squareCrop(file) {
    try {
      const bmp = await createImageBitmap(file);
      const side = Math.min(bmp.width, bmp.height), out = Math.min(400, side);
      const cv = document.createElement("canvas"); cv.width = cv.height = out;
      cv.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
      return (await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85))) || file;
    } catch (_) { return file; }
  }
  $("#nameForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#n-name").value.trim();
    if (!name) { $("#nameErr").textContent = "이름을 입력해주세요."; $("#nameErr").hidden = false; return; }
    const btn = $("#p-save"); btn.disabled = true;
    try {
      if (P.file) {
        btn.textContent = "사진 올리는 중…";
        const blob = await squareCrop(P.file);
        apply(await api("updateProfile", { name, photo: { mime: blob.type || "image/jpeg", data: await toBase64(blob) } }));
      } else if (P.removed) {
        apply(await api("updateProfile", { name, removePhoto: true }));
      } else {
        apply(await api("rename", { name }));
      }
      resetProfilePhoto(); closeSheets(); toast("프로필을 바꿨어요");
    } catch (e) { $("#nameErr").textContent = errText(e); $("#nameErr").hidden = false; }
    finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  // rules (admin): 기본 규칙 + 추가 규칙 목록(추가·수정·삭제)
  const MAX_RULES = 20;
  function addRuleRow(text, focus) {
    const box = $("#ruleEdit");
    const row = document.createElement("div");
    row.className = "rrow";
    row.innerHTML = `<span class="rno"></span><input type="text" maxlength="80" placeholder="예: 운동 인증은 사진 필수"><button type="button" class="act danger" data-del>삭제</button>`;
    row.querySelector("input").value = text || "";
    box.appendChild(row);
    numberRules();
    if (focus) row.querySelector("input").focus();
  }
  function numberRules() {
    const rows = [...$("#ruleEdit").children];
    rows.forEach((r, i) => { r.querySelector(".rno").textContent = i + 1; r.querySelector("input").setAttribute("aria-label", `추가 규칙 ${i + 1}`); });
    $("#addRule").disabled = rows.length >= MAX_RULES;
  }
  $("#addRule").addEventListener("click", () => addRuleRow("", true));
  $("#ruleEdit").addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-del]")) return;
    ev.target.closest(".rrow").remove();
    numberRules();
  });
  function openRules() {
    const c = cfg();
    $("#r-title").value = c.title; $("#r-goal").value = c.goal; $("#r-fine").value = c.fine;
    $("#r-start").value = c.start; $("#rulesErr").hidden = true;
    $("#ruleEdit").innerHTML = "";
    c.rules.forEach((r) => addRuleRow(r));
    numberRules();
    openSheet("rulesSheet");
  }
  $("#rulesForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const rules = [...$("#ruleEdit").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    // 예전 서버 코드는 rules를 모르니, 그때는 규칙을 메모 칸에 합쳐서라도 남김
    const serverKnowsRules = !!(S.settings && "rules" in S.settings);
    const settings = {
      title: $("#r-title").value.trim(), goal: $("#r-goal").value, fine: $("#r-fine").value,
      start: $("#r-start").value, rules, note: serverKnowsRules ? "" : rules.join(" / ").slice(0, 60),
    };
    try {
      apply(await api("saveSettings", { settings }));
      closeSheets();
      toast(serverKnowsRules || rules.length < 2 ? "규칙을 저장했어요" : "저장했어요. 규칙을 따로따로 보려면 Apps Script를 새 버전으로 배포해주세요");
    } catch (e) { $("#rulesErr").textContent = errText(e); $("#rulesErr").hidden = false; }
  });

  // members (admin)
  const linkFor = (key) => location.origin + location.pathname + "#k=" + key;
  function renderRoster(roster) {
    $("#roster").innerHTML = roster.map((m) => `<div class="mrow">
        ${avatar(m)}<span class="mname">${esc(m.name)}${m.role === "admin" ? " · 관리자" : ""}</span>
        <span class="mbtns">
          <button type="button" class="act" data-act="copy" data-id="${esc(m.id)}">링크 복사</button>
          ${m.role === "admin" ? "" : `<button type="button" class="act" data-act="reset" data-id="${esc(m.id)}">재발급</button>
          <button type="button" class="act danger" data-act="remove" data-id="${esc(m.id)}">내보내기</button>`}
        </span>
        <input class="linkbox" type="text" readonly value="${esc(linkFor(m.key))}" data-link="${esc(m.id)}" aria-label="${esc(m.name)}의 링크" hidden>
      </div>`).join("");
  }
  async function openManage() {
    $("#manageErr").hidden = true; $("#a-name").value = "";
    $("#roster").innerHTML = `<div class="empty">불러오는 중…</div>`;
    openSheet("manageSheet");
    try { renderRoster((await api("members")).roster); }
    catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; }
  }
  $("#addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#a-name").value.trim();
    if (!name) { $("#manageErr").textContent = "이름을 입력해주세요."; $("#manageErr").hidden = false; return; }
    try {
      const data = await api("addMember", { name });
      apply(data); renderRoster(data.roster); $("#a-name").value = ""; $("#manageErr").hidden = true;
      toast(`${name}을(를) 추가했어요. ‘링크 복사’로 보내주세요`);
    } catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; }
  });
  $("#roster").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === "copy") {
      const box = $(`#roster [data-link="${CSS.escape(id)}"]`);
      try { await navigator.clipboard.writeText(box.value); toast("링크를 복사했어요"); }
      catch (_) { box.hidden = false; box.focus(); box.select(); toast("링크를 길게 눌러 복사해주세요"); }
      return;
    }
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      const orig = b.textContent; b.textContent = b.dataset.act === "reset" ? "예전 링크 막기?" : "정말 내보내기?";
      setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = orig; } }, 3500);
      return;
    }
    b.disabled = true;
    try {
      const data = await api(b.dataset.act === "reset" ? "resetKey" : "removeMember", { id });
      if (data.members) apply(data);
      renderRoster(data.roster);
      toast(b.dataset.act === "reset" ? "새 링크를 만들었어요. 다시 보내주세요" : "내보냈어요");
    } catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; b.disabled = false; }
  });

  // ---------- 내 몸 기록 · 인바디 · 멤버 상세 ----------
  const BODY_LABELS = { height: "키", weight: "몸무게", birthYear: "출생 연도", sex: "성별" };
  const SEX_LABEL = { F: "여성", M: "남성" };
  const IB_FIELDS = [
    ["weight", "체중", "kg"], ["muscle", "골격근량", "kg"], ["fatMass", "체지방량", "kg"], ["fatPct", "체지방률", "%"],
    ["bmi", "BMI", ""], ["bmr", "기초대사량", "kcal"], ["score", "인바디 점수", "점"],
  ];
  const TREND = [["weight", "체중", "kg"], ["muscle", "골격근량", "kg"], ["fatPct", "체지방률", "%"]];
  const fmtDate = (s) => { const d = parseYmd(s); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; };
  const bodyText = (k, v) => (k === "height" ? `${v}cm` : k === "weight" ? `${v}kg` : k === "birthYear" ? `${v}년생` : SEX_LABEL[v] || "");
  const myBody = () => (S.me && S.bodies[S.me.id]) || {};
  const inbodyOf = (id) => S.inbody.filter((r) => r.memberId === id);
  const adminName = () => (S.members.find((m) => m.admin) || {}).name || "관리자";

  function openZoom(id) {
    const img = $("#lightImg");
    img.dataset.alt = photoAlt(id, 2400); img.src = photoSrc(id, 2400);
    $("#lightbox").hidden = false;
  }

  // 저장 전에 무엇이 공개되는지 보여주고 확인을 받음
  function confirmVisibility({ title, pub, priv, notes }) {
    return new Promise((resolve) => {
      const li = (xs) => (xs.length ? xs.map((x) => `<li>${esc(x)}</li>`).join("") : `<li class="none">없음</li>`);
      $("#cfTitle").textContent = title;
      $("#cfPub").innerHTML = li(pub);
      $("#cfPriv").innerHTML = li(priv);
      $("#cfNotes").innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join("");
      const sheet = $("#confirmSheet");
      const done = (v) => { sheet.hidden = true; sheet.onclick = null; resolve(v); };
      $("#cfOk").onclick = () => done(true);
      $("#cfBack").onclick = () => done(false);
      sheet.onclick = (ev) => { if (ev.target === sheet) done(false); };
      sheet.hidden = false;
      $("#cfOk").focus();
    });
  }
  function privacyNotes(includesWeight) {
    const notes = [];
    if (includesWeight) notes.push("몸무게는 운동 칼로리 계산에 쓰여요. 몸무게를 공개하지 않아도 칼로리 숫자는 친구들에게 보여요.");
    notes.push("나만 보기 정보는 구글 백업 시트에 저장되고 관리자만 볼 수 있어요.");
    return notes;
  }

  // Mifflin-St Jeor 공식으로 기초대사량 추정
  function estimateBmr(b) {
    const w = latestWeight(S.me && S.me.id) || b.weight;
    if (!w || !b.height || !b.birthYear || !b.sex) return 0;
    const age = new Date().getFullYear() - b.birthYear;
    return Math.round(10 * w + 6.25 * b.height - 5 * age + (b.sex === "M" ? 5 : -161));
  }
  function latestWeight(id) {
    const list = inbodyOf(id).filter((r) => r.weight);
    return list.length ? list[list.length - 1].weight : 0;
  }

  // 측정값 하나당 작은 선 그래프 하나 (단위가 달라 한 축에 겹치지 않음)
  function trendHtml(records) {
    const W = 300, H = 92, L = 34, R = 10, T = 10, B = 20;
    const charts = TREND.map(([k, label, unit]) => {
      const pts = records.filter((r) => r[k] != null).map((r) => ({ d: r.date, v: r[k] }));
      if (!pts.length) return "";
      const first = pts[0], last = pts[pts.length - 1];
      const delta = Math.round((last.v - first.v) * 10) / 10;
      const sub = pts.length > 1 ? `처음(${fmtDate(first.d)})보다 ${delta > 0 ? "+" : ""}${delta}${unit}` : `${fmtDate(last.d)} 측정`;
      let svg = "";
      if (pts.length > 1) {
        const ts = pts.map((p) => parseYmd(p.d).getTime());
        const t0 = ts[0], t1 = ts[ts.length - 1];
        const xs = ts.map((t, i) => (t1 > t0 ? L + ((t - t0) / (t1 - t0)) * (W - L - R) : L + (i / (pts.length - 1)) * (W - L - R)));
        let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
        if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
        const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
        const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
        const fmt = (v) => (Math.round(v * 10) / 10).toString();
        const path = pts.map((p, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)},${y(p.v).toFixed(1)}`).join("");
        const dots = pts.map((p, i) => `<circle class="pt" cx="${xs[i].toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === pts.length - 1 ? 5 : 4}"></circle>`).join("");
        const d0 = parseYmd(first.d), d1 = parseYmd(last.d);
        svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} 변화: ${esc(pts.map((p) => `${fmtDate(p.d)} ${p.v}${unit}`).join(", "))}" data-xs="${esc(JSON.stringify(xs))}">
          <line class="grid" x1="${L}" x2="${W - R}" y1="${y(hi - pad).toFixed(1)}" y2="${y(hi - pad).toFixed(1)}"></line>
          <line class="grid" x1="${L}" x2="${W - R}" y1="${y(lo + pad).toFixed(1)}" y2="${y(lo + pad).toFixed(1)}"></line>
          <text class="axis" x="${L - 6}" y="${(y(hi - pad) + 3).toFixed(1)}" text-anchor="end">${fmt(hi - pad)}</text>
          <text class="axis" x="${L - 6}" y="${(y(lo + pad) + 3).toFixed(1)}" text-anchor="end">${fmt(lo + pad)}</text>
          <text class="axis" x="${L}" y="${H - 4}" text-anchor="start">${d0.getMonth() + 1}.${d0.getDate()}</text>
          <text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${d1.getMonth() + 1}.${d1.getDate()}</text>
          <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"></line>
          <path class="line" d="${path}"></path>${dots}
        </svg>`;
      }
      return `<figure class="trend" data-unit="${esc(unit)}" data-pts="${esc(JSON.stringify(pts))}">
        <figcaption><span>${label}</span><b>${last.v}${unit}</b><small>${esc(sub)}</small></figcaption>${svg}<div class="tip" hidden></div>
      </figure>`;
    }).join("");
    return charts ? `<div class="trends">${charts}</div>` : "";
  }
  function trendHover(ev) {
    const svg = ev.target.closest && ev.target.closest(".trend svg");
    document.querySelectorAll(".trend .tip:not([hidden])").forEach((t) => {
      if (svg && t.parentElement === svg.parentElement) return;
      t.hidden = true;
      const xh = t.parentElement.querySelector(".xh"); if (xh) xh.setAttribute("visibility", "hidden");
    });
    if (!svg) return;
    const fig = svg.parentElement, tip = fig.querySelector(".tip");
    const pts = JSON.parse(fig.dataset.pts), xs = JSON.parse(svg.dataset.xs);
    const rect = svg.getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * 300;
    let i = 0;
    xs.forEach((x, k) => { if (Math.abs(x - vx) < Math.abs(xs[i] - vx)) i = k; });
    tip.textContent = `${fmtDate(pts[i].d)} · ${pts[i].v}${fig.dataset.unit}`;
    tip.hidden = false;
    const fr = fig.getBoundingClientRect();
    // 풍선이 카드 밖으로 잘리지 않게 좌우 끝을 막음
    const half = tip.offsetWidth / 2 || 50;
    const left = Math.min(Math.max(rect.left - fr.left + (xs[i] / 300) * rect.width, half + 4), fr.width - half - 4);
    tip.style.left = `${left.toFixed(0)}px`;
    tip.style.top = `${(rect.top - fr.top - 6).toFixed(0)}px`;
    tip.hidden = false;
    const xh = svg.querySelector(".xh");
    xh.setAttribute("x1", xs[i]); xh.setAttribute("x2", xs[i]); xh.setAttribute("visibility", "visible");
  }
  document.addEventListener("pointermove", trendHover);
  document.addEventListener("pointerdown", trendHover);

  function inbodyItem(r, mine) {
    const vals = IB_FIELDS.filter(([k]) => r[k] != null).map(([k, l, u]) => `<span>${l} <b class="num">${r[k]}</b>${u}</span>`).join("");
    const acts = [
      validFileId(r.photo) ? `<button type="button" class="act" data-ib="zoom" data-id="${esc(r.photo)}">결과지 보기</button>` : "",
      mine ? `<button type="button" class="act" data-ib="edit" data-id="${esc(r.id)}">수정</button><button type="button" class="act danger" data-ib="del" data-id="${esc(r.id)}">삭제</button>` : "",
    ].join("");
    return `<div class="ibitem">
      <div class="ibtop"><b class="num">${fmtDate(r.date)}</b>${mine ? `<span class="badge">${r.public ? "친구들에게 공개" : "나만 보기"}</span>` : ""}</div>
      <div class="ibvals">${vals}</div>${acts ? `<div class="actions">${acts}</div>` : ""}
    </div>`;
  }

  // --- 내 몸 기록 ---
  function openBody() {
    const b = myBody();
    ["height", "weight", "birthYear"].forEach((k) => ($("#b-" + k).value = b[k] || ""));
    $("#b-sex").value = b.sex || "";
    $("#b-birthYear").max = new Date().getFullYear() - 5;
    const pub = b.pub || [];
    $("#bodyForm").querySelectorAll("[data-pub]").forEach((c) => (c.checked = pub.includes(c.dataset.pub)));
    $("#bodyErr").hidden = true;
    renderBodySheet();
    openSheet("bodySheet");
  }
  function renderBodySheet() {
    const b = myBody();
    const est = estimateBmr(b);
    const mine = inbodyOf(S.me && S.me.id);
    const measured = [...mine].reverse().find((r) => r.bmr);
    const parts = [];
    if (est) parts.push(`예상 기초대사량 <b>${est.toLocaleString("ko-KR")}</b>kcal/일`);
    if (measured) parts.push(`인바디 측정 <b>${measured.bmr.toLocaleString("ko-KR")}</b>kcal`);
    if (!b.weight && !latestWeight(S.me && S.me.id)) parts.push("몸무게를 입력하면 운동 칼로리가 계산돼요.");
    else if (!est) parts.push("키·출생 연도·성별까지 입력하면 기초대사량도 알려드려요.");
    $("#bmrLine").innerHTML = parts.join(" · ");
    $("#myTrend").innerHTML = trendHtml(mine);
    $("#myInbody").innerHTML = mine.length
      ? [...mine].reverse().map((r) => inbodyItem(r, true)).join("")
      : `<p class="veil-note">아직 인바디 기록이 없어요. 측정할 때마다 추가하면 변화 그래프가 그려져요.</p>`;
  }
  $("#bodyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = { sex: $("#b-sex").value, pub: [] };
    ["height", "weight", "birthYear"].forEach((k) => (body[k] = $("#b-" + k).value === "" ? "" : Number($("#b-" + k).value)));
    $("#bodyForm").querySelectorAll("[data-pub]").forEach((c) => { if (c.checked) body.pub.push(c.dataset.pub); });
    const pub = [], priv = [];
    Object.keys(BODY_LABELS).forEach((k) => {
      if (body[k] === "" || body[k] == null) return;
      const line = `${BODY_LABELS[k]}: ${bodyText(k, body[k])}`;
      (body.pub.includes(k) ? pub : priv).push(line);
    });
    const ok = await confirmVisibility({
      title: pub.length || priv.length ? "기본 정보 공개 범위 확인" : "기본 정보를 모두 지울까요?",
      pub, priv, notes: privacyNotes(body.weight !== ""),
    });
    if (!ok) return;
    try {
      apply(await api("saveBody", { body }));
      renderBodySheet();
      toast("기본 정보를 저장했어요");
    } catch (e) { $("#bodyErr").textContent = errText(e); $("#bodyErr").hidden = false; }
  });

  // --- 인바디 작성/수정 ---
  const IB = { id: null, file: null, url: null, removed: false };
  function setIbPreview(src) {
    if (IB.url && src !== IB.url) { URL.revokeObjectURL(IB.url); IB.url = null; }
    const img = $("#i-preview");
    if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute("src"); img.hidden = true; }
    $("#i-removePhoto").hidden = !src;
    $("#i-pick").textContent = src ? "다른 사진" : "사진 선택";
  }
  function openInbody(id) {
    const r = id ? S.inbody.find((x) => x.id === id) : null;
    IB.id = r ? r.id : null; IB.file = null; IB.removed = false;
    $("#ibTitle").textContent = r ? "인바디 기록 수정" : "인바디 기록 추가";
    $("#i-date").value = r ? r.date : ymd(new Date());
    $("#i-date").max = ymd(new Date());
    IB_FIELDS.forEach(([k]) => ($("#i-" + k).value = r && r[k] != null ? r[k] : ""));
    $("#i-photo").value = "";
    setIbPreview(r && validFileId(r.photo) ? photoSrc(r.photo, 800) : null);
    document.querySelector(`input[name="i-vis"][value="${r && r.public ? "public" : "private"}"]`).checked = true;
    $("#ibErr").hidden = true;
    openSheet("inbodySheet");
  }
  // 키를 알면 체중으로 BMI 칸을 미리 채워줌
  $("#i-weight").addEventListener("input", () => {
    const h = myBody().height, w = Number($("#i-weight").value);
    if (h && w && !$("#i-bmi").dataset.touched) $("#i-bmi").value = (Math.round((w / ((h / 100) ** 2)) * 10) / 10).toString();
  });
  $("#i-bmi").addEventListener("input", () => ($("#i-bmi").dataset.touched = "1"));
  $("#i-photo").addEventListener("change", () => {
    const f = $("#i-photo").files[0]; if (!f) return;
    IB.file = f; IB.removed = false;
    const url = URL.createObjectURL(f);
    setIbPreview(url); IB.url = url;
  });
  $("#i-removePhoto").addEventListener("click", () => { IB.file = null; IB.removed = true; $("#i-photo").value = ""; setIbPreview(null); });
  $("#ibCancel").addEventListener("click", () => { delete $("#i-bmi").dataset.touched; renderBodySheet(); openSheet("bodySheet"); });
  $("#addInbody").addEventListener("click", () => { delete $("#i-bmi").dataset.touched; openInbody(null); });

  $("#inbodyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#ibErr");
    const record = { id: IB.id || undefined, date: $("#i-date").value, public: document.querySelector('input[name="i-vis"]:checked').value === "public", removePhoto: IB.removed };
    IB_FIELDS.forEach(([k]) => (record[k] = $("#i-" + k).value === "" ? "" : Number($("#i-" + k).value)));
    if (!validDate(record.date)) { err.textContent = "측정일을 골라주세요."; err.hidden = false; return; }
    const filled = IB_FIELDS.filter(([k]) => record[k] !== "").map(([k, l, u]) => `${l} ${record[k]}${u}`);
    if (!filled.length) { err.textContent = "측정값을 하나 이상 입력해주세요."; err.hidden = false; return; }
    err.hidden = true;
    const hasPhoto = !!IB.file || (!IB.removed && IB.id && validFileId((S.inbody.find((x) => x.id === IB.id) || {}).photo));
    const items = [`${fmtDate(record.date)} 측정값: ${filled.join(", ")}`].concat(hasPhoto ? ["결과지 사진"] : []);
    const ok = await confirmVisibility({
      title: "인바디 기록 공개 범위 확인",
      pub: record.public ? items : [], priv: record.public ? [] : items,
      notes: privacyNotes(record.weight !== ""),
    });
    if (!ok) return;
    const btn = $("#ibSave"); btn.disabled = true;
    try {
      if (IB.file) {
        btn.textContent = "사진 올리는 중…";
        const blob = await shrink(IB.file);
        record.photo = { mime: blob.type || "image/jpeg", data: await toBase64(blob) };
      }
      apply(await api("saveInbody", { record }));
      delete $("#i-bmi").dataset.touched;
      renderBodySheet(); openSheet("bodySheet");
      toast("인바디 기록을 저장했어요");
    } catch (e) { err.textContent = errText(e); err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  $("#myInbody").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-ib]"); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.ib === "zoom") return openZoom(id);
    if (b.dataset.ib === "edit") { delete $("#i-bmi").dataset.touched; $("#i-bmi").dataset.touched = "1"; return openInbody(id); }
    if (!b.classList.contains("armed")) {
      b.classList.add("armed"); b.textContent = "한 번 더 누르면 삭제";
      setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = "삭제"; } }, 3500);
      return;
    }
    b.disabled = true;
    try { apply(await api("deleteInbody", { id })); renderBodySheet(); toast("삭제했어요"); }
    catch (e) { toast(errText(e)); b.disabled = false; }
  });

  // --- 멤버 상세 (다른 사람이 공개한 정보만 보임) ---
  function openMember(id) {
    const m = S.members.find((x) => x.id === id); if (!m) return;
    const b = S.bodies[id] || {};
    const facts = Object.keys(BODY_LABELS).filter((k) => b[k]).map((k) => `<span>${esc(bodyText(k, b[k]))}</span>`).join("");
    const t = new Date();
    const a = ymd(new Date(t.getFullYear(), t.getMonth(), 1)), z = ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0));
    const list = S.entries.filter((e) => e.memberId === id && e.date >= a && e.date <= z);
    const days = new Set(list.map((e) => e.date)).size;
    const mins = list.reduce((s, e) => s + (Number(e.minutes) || 0), 0);
    const kcal = kcalIn(list, a, z);
    const ib = inbodyOf(id);
    $("#mHead").innerHTML = `${avatar(m)}<b>${esc(m.name || "친구")}</b>`;
    $("#mBody").innerHTML = `
      <section><h4>이번 달</h4><p class="bmr">${list.length ? `운동 <b>${days}</b>일 · 총 <b>${esc(fmtMinutes(mins))}</b>${kcal ? ` · 약 <b>${kcal.toLocaleString("ko-KR")}</b>kcal` : ""}` : "이번 달 기록이 아직 없어요."}</p>${kcal ? `<p class="kcalnote">칼로리는 대략적인 추정치(±20~30%)예요.</p>` : ""}</section>
      <section><h4>공개한 정보</h4>${facts ? `<div class="facts">${facts}</div>` : `<p class="veil-note">공개한 몸 정보가 없어요.</p>`}</section>
      <section><h4>인바디</h4>${ib.length ? trendHtml(ib) + `<div class="iblist">${[...ib].reverse().map((r) => inbodyItem(r, false)).join("")}</div>` : `<p class="veil-note">공개한 인바디 기록이 없어요.</p>`}</section>`;
    openSheet("memberSheet");
  }
  $("#mBody").addEventListener("click", (ev) => { const b = ev.target.closest('[data-ib="zoom"]'); if (b) openZoom(b.dataset.id); });

  // ---------- page events ----------
  $("#prev").addEventListener("click", () => { if (S.view === "week") S.weekOffset--; else S.monthOffset--; render(); });
  $("#next").addEventListener("click", () => {
    if (S.view === "week" && S.weekOffset < 0) S.weekOffset++;
    else if (S.view === "month" && S.monthOffset < 0) S.monthOffset++;
    render();
  });
  function setView(v) {
    S.view = v;
    try { localStorage.setItem("healthy.view", v); } catch (_) {}
    render();
  }
  $("#viewWeek").addEventListener("click", () => setView("week"));
  $("#viewMonth").addEventListener("click", () => setView("month"));
  $("#tabAll").addEventListener("click", () => { S.mineOnly = false; $("#tabAll").setAttribute("aria-pressed", "true"); $("#tabMine").setAttribute("aria-pressed", "false"); render(); });
  $("#tabMine").addEventListener("click", () => { S.mineOnly = true; $("#tabMine").setAttribute("aria-pressed", "true"); $("#tabAll").setAttribute("aria-pressed", "false"); render(); });
  $("#fab").addEventListener("click", () => openEntry(null));
  $("#rules").addEventListener("click", (ev) => { if (ev.target.closest("#editRules")) openRules(); });
  $("#manage").addEventListener("click", openManage);
  $("#openBody").addEventListener("click", openBody);
  $("#board").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-member]"); if (!b) return;
    if (S.me && b.dataset.member === S.me.id) openBody(); else openMember(b.dataset.member);
  });
  $("#signout").addEventListener("click", () => {
    try { localStorage.removeItem(KEY_STORE); } catch (_) {}
    KEY = ""; S.loaded = false;
    showGate("이 기기에서 나갔어요", "다시 들어오려면 받은 링크를 눌러주세요.");
  });
  $("#lightbox").addEventListener("click", () => ($("#lightbox").hidden = true));
  $("#lightImg").addEventListener("error", () => {
    const img = $("#lightImg");
    if (img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ""; }
  });

  $("#feed").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === "zoom") {
      const img = $("#lightImg");
      img.dataset.alt = photoAlt(id, 2400); img.src = photoSrc(id, 2400);
      $("#lightbox").hidden = false;
      return;
    }
    const e = S.entries.find((x) => x.id === id); if (!e) return;
    if (act === "edit") return openEntry(id);
    if (act === "hide") {
      b.disabled = true;
      try { apply(await api("toggleHidden", { id })); toast(e.hidden ? "공개했어요" : "숨겼어요"); }
      catch (err) { toast(errText(err)); b.disabled = false; }
      return;
    }
    if (act === "del") {
      if (!b.classList.contains("armed")) {
        const orig = b.textContent;
        b.classList.add("armed"); b.textContent = "한 번 더 누르면 삭제";
        setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = orig; } }, 3500);
        return;
      }
      b.disabled = true;
      try { apply(await api("deleteEntry", { id })); toast("삭제했어요"); }
      catch (err) { toast(errText(err)); b.disabled = false; }
    }
  });

  // ---------- boot ----------
  if (!API) {
    showGate("아직 설정이 끝나지 않았어요", "config.js에 Apps Script 웹 앱 주소를 넣어주세요. 자세한 방법은 README.md에 있어요.");
    return;
  }
  if (!KEY) { showGate(); return; }
  $("#app").hidden = false;
  load();
  // 친구들의 새 기록을 가져오려고 1분마다, 그리고 다시 화면에 돌아왔을 때 새로고침
  setInterval(() => { if (KEY && document.visibilityState === "visible" && !anySheetOpen()) load(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (KEY && document.visibilityState === "visible" && S.loaded && !anySheetOpen()) load(); });
})();
