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
    weekOffset: 0, mineOnly: false,
    editingId: null, photoFile: null, photoRemoved: false,
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
  const errText = (e) => (e && e.message) || "저장하지 못했어요. 잠시 뒤 다시 시도해주세요.";

  function apply(data) {
    if (data.me) S.me = data.me;
    if (data.members) S.members = data.members;
    if (data.entries) S.entries = data.entries;
    if (data.settings) S.settings = data.settings;
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
      note: c.note || "",
      start: validDate(c.start) ? c.start : ymd(mondayOf(new Date())),
    };
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

  function avatar(m) {
    let h = 0;
    for (const ch of String(m.id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const initial = (m.name || "?").trim().charAt(0) || "?";
    return `<span class="avatar" style="background:hsl(${h} 55% 42%)" aria-hidden="true">${esc(initial)}</span>`;
  }
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
    document.title = c.title + " · 땀내기 운동 장부";
    $("#title").textContent = c.title;
    const pot = ms.reduce((t, m) => t + missedWeeks(m) * c.fine, 0);
    const startD = parseYmd(c.start);
    $("#rules").innerHTML =
      `<span class="rule">주 ${c.goal}일 이상</span>` +
      `<span class="rule">미달 시 ${esc(won(c.fine))}</span>` +
      `<span class="rule">${startD.getMonth() + 1}월 ${startD.getDate()}일 주부터</span>` +
      `<span class="rule pot">모인 벌금 <span class="num">${esc(won(pot))}</span></span>` +
      (c.note ? `<span class="rule">${esc(c.note)}</span>` : "") +
      (isAdmin ? `<button class="linkbtn" type="button" id="editRules">규칙 수정</button>` : "");

    // week nav
    const mon = selMonday();
    const sun = addDays(mon, 6);
    const isCurrent = S.weekOffset === 0;
    $("#weekTitle").textContent = isCurrent ? "이번 주" : S.weekOffset === -1 ? "지난 주" : `${-S.weekOffset}주 전`;
    $("#weekRange").textContent = `${mon.getMonth() + 1}.${mon.getDate()} – ${sun.getMonth() + 1}.${sun.getDate()}`;
    $("#next").disabled = isCurrent;

    // board
    const today = ymd(new Date());
    const daysLeft = 7 - ((new Date().getDay() + 6) % 7); // 오늘 포함
    const rows = ms.map((m) => ({ m, days: daysIn(m.list, mon), mins: minutesIn(m.list, mon), missed: missedWeeks(m) }))
      .sort((a, b) => b.days.size - a.days.size || b.mins - a.mins || String(a.m.name).localeCompare(String(b.m.name), "ko"));
    const board = $("#board");
    if (!rows.length) {
      board.innerHTML = `<div class="empty"><strong>아직 참가한 사람이 없어요</strong>${isAdmin ? "아래 ‘참가자 관리’에서 친구를 추가하고 링크를 보내주세요." : "친구들이 참가하면 순위가 여기에 표시돼요."}</div>`;
    } else {
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
        const owed = r.missed
          ? `<div class="owed"><span>지금까지 미달 <span class="num">${r.missed}</span>주</span><span>낼 벌금 <b>${esc(won(r.missed * c.fine))}</b></span></div>`
          : `<div class="owed"><span>아직 낼 벌금 없음</span></div>`;
        return `<div class="row">
          <div class="rank">${i + 1}</div>
          ${avatar(r.m)}
          <div class="who"><div class="name">${esc(r.m.name || "친구")}${isMe ? `<span class="me">나</span>` : ""}</div><div class="dots">${dots}</div></div>
          <div class="score"><div class="count">${done}<small>/${c.goal}일</small></div>${chip}</div>
          ${owed}
        </div>`;
      }).join("");
    }

    // feed
    const a = ymd(mon), b = ymd(sun);
    const byId = Object.fromEntries(ms.map((m) => [m.id, m]));
    let entries = S.entries.filter((e) => byId[e.memberId] && e.date >= a && e.date <= b);
    if (S.mineOnly && S.me) entries = entries.filter((e) => e.memberId === S.me.id);
    entries.sort((x, y) => y.date.localeCompare(x.date) || (Number(y.createdAt) || 0) - (Number(x.createdAt) || 0));
    $("#feedCount").textContent = `${entries.length}개`;
    const feed = $("#feed");
    if (!entries.length) {
      feed.innerHTML = `<div class="card veiled"><div class="empty"><strong>${isCurrent ? "이번 주" : "이 주"} 기록이 아직 없어요</strong>운동하고 ‘+ 기록하기’로 날짜, 종목, 시간, 사진을 남기면 여기에 쌓여요.</div></div>`;
    } else {
      let lastDate = "";
      feed.innerHTML = entries.map((e) => {
        const m = byId[e.memberId];
        const mine = S.me && e.memberId === S.me.id;
        const d = parseYmd(e.date);
        let head = "";
        if (e.date !== lastDate) { lastDate = e.date; head = `<div class="daylabel">${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[(d.getDay() + 6) % 7]}요일</div>`; }
        const stats = [Number(e.minutes) > 0 ? `${Number(e.minutes)}분` : "", Number(e.km) > 0 ? `${Number(e.km)}km` : ""].filter(Boolean).join(" · ");
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
          ${veiled ? `<p class="veil-note">사진과 메모는 숨겨져 있어요. 운동한 날은 순위표에 반영돼요.</p>` : ""}
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

  let toastTimer;
  function toast(t) {
    const el = $("#toast"); el.textContent = t; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- sheets ----------
  const anySheetOpen = () => [...document.querySelectorAll(".scrim")].some((s) => !s.hidden);
  function openSheet(id) { document.querySelectorAll(".scrim").forEach((s) => (s.hidden = s.id !== id)); }
  function closeSheets() { document.querySelectorAll(".scrim").forEach((s) => (s.hidden = true)); }
  document.querySelectorAll(".scrim").forEach((s) => {
    s.addEventListener("click", (ev) => { if (ev.target === s || ev.target.closest("[data-close]")) closeSheets(); });
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeSheets(); $("#lightbox").hidden = true; } });

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
      S.weekOffset = Math.round((mondayOf(parseYmd(date)) - mondayOf(new Date())) / (7 * 864e5));
      render();
    } catch (e) {
      if (e && e.error === "invalid_key") return;
      err.textContent = errText(e); err.hidden = false;
    } finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  // rename
  $("#rename").addEventListener("click", () => { $("#n-name").value = S.me?.name || ""; $("#nameErr").hidden = true; openSheet("nameSheet"); $("#n-name").focus(); });
  $("#nameForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#n-name").value.trim();
    if (!name) { $("#nameErr").textContent = "이름을 입력해주세요."; $("#nameErr").hidden = false; return; }
    try { apply(await api("rename", { name })); closeSheets(); toast("이름을 바꿨어요"); }
    catch (e) { $("#nameErr").textContent = errText(e); $("#nameErr").hidden = false; }
  });

  // rules (admin)
  function openRules() {
    const c = cfg();
    $("#r-title").value = c.title; $("#r-goal").value = c.goal; $("#r-fine").value = c.fine;
    $("#r-start").value = c.start; $("#r-note").value = c.note; $("#rulesErr").hidden = true;
    openSheet("rulesSheet");
  }
  $("#rulesForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const settings = {
      title: $("#r-title").value.trim(), goal: $("#r-goal").value, fine: $("#r-fine").value,
      start: $("#r-start").value, note: $("#r-note").value.trim(),
    };
    try { apply(await api("saveSettings", { settings })); closeSheets(); toast("규칙을 저장했어요"); }
    catch (e) { $("#rulesErr").textContent = errText(e); $("#rulesErr").hidden = false; }
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

  // ---------- page events ----------
  $("#prev").addEventListener("click", () => { S.weekOffset--; render(); });
  $("#next").addEventListener("click", () => { if (S.weekOffset < 0) { S.weekOffset++; render(); } });
  $("#tabAll").addEventListener("click", () => { S.mineOnly = false; $("#tabAll").setAttribute("aria-pressed", "true"); $("#tabMine").setAttribute("aria-pressed", "false"); render(); });
  $("#tabMine").addEventListener("click", () => { S.mineOnly = true; $("#tabMine").setAttribute("aria-pressed", "true"); $("#tabAll").setAttribute("aria-pressed", "false"); render(); });
  $("#fab").addEventListener("click", () => openEntry(null));
  $("#rules").addEventListener("click", (ev) => { if (ev.target.closest("#editRules")) openRules(); });
  $("#manage").addEventListener("click", openManage);
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
