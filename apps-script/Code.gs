/**
 * 땀내기 운동 장부 — Google Apps Script 백엔드
 *
 * 구글 시트에서 [확장 프로그램 → Apps Script]를 열고 이 파일 내용을 붙여넣어 사용합니다.
 * 설치 순서는 저장소의 README.md를 보세요.
 *
 * 모든 요청은 참가자 키(k)가 있어야 처리됩니다. 키는 members 시트에만 저장되며
 * 관리자 외에는 응답에 포함되지 않습니다.
 */

const SHEETS = {
  members: ['id', 'name', 'key', 'role', 'joinedAt'],
  entries: ['id', 'memberId', 'date', 'kind', 'minutes', 'km', 'memo', 'photoId', 'hidden', 'createdAt', 'updatedAt'],
  settings: ['key', 'value'],
};
const DEFAULT_SETTINGS = { title: '주 3회 운동 내기', goal: '3', fine: '10000', start: '', note: '' };
const PHOTO_FOLDER_NAME = 'healthy-photos';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 최초 1회 실행: 시트 만들기, 관리자 키 발급, 사진 폴더 만들기
// ---------------------------------------------------------------------------
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach((name) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  const settings = readSettings_();
  if (!settings.start) writeSettings_(Object.assign({}, DEFAULT_SETTINGS, settings, { start: mondayOf_(today_()) }));
  let admin = table_('members').rows.find((m) => m.role === 'admin');
  if (!admin) admin = addMember_('나', 'admin');
  photoFolder_();
  Logger.log('관리자 키: ' + admin.key);
  Logger.log('관리자 링크: <GitHub Pages 주소>#k=' + admin.key);
}

// ---------------------------------------------------------------------------
// 웹 앱 진입점
// ---------------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, app: 'healthy', message: 'API가 동작 중이에요.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (_) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    const me = auth_(req.k);
    if (!me) return json_({ ok: false, error: 'invalid_key' });
    const fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: 'unknown_action' });
    return json_(Object.assign({ ok: true }, fn(me, req)));
  } catch (err) {
    return json_({ ok: false, error: err.code || 'server_error', message: String(err.message || err) });
  }
}

const ACTIONS = {
  state: (me) => stateFor_(me),

  saveEntry: (me, req) => {
    const src = req.entry || {};
    const clean = cleanEntry_(src);
    // 사진 업로드는 느리니까 잠금 밖에서 처리
    const newPhoto = src.photo && src.photo.data ? savePhoto_(me, src.photo) : '';
    let oldPhoto = '';
    try {
      withLock_(() => {
        const t = table_('entries');
        const now = String(Date.now());
        const existing = src.id ? t.rows.find((r) => r.id === src.id) : null;
        if (src.id && !existing) throw fail_('not_found', '기록을 찾을 수 없어요.');
        if (existing && existing.memberId !== me.id) throw fail_('forbidden', '본인 기록만 수정할 수 있어요.');
        let photoId = existing ? existing.photoId : '';
        if (newPhoto || src.removePhoto) {
          oldPhoto = photoId;
          photoId = newPhoto;
        }
        const row = {
          id: existing ? existing.id : 'e' + uid_(12),
          memberId: me.id,
          date: clean.date,
          kind: clean.kind,
          minutes: String(clean.minutes),
          km: String(clean.km),
          memo: clean.memo,
          photoId,
          hidden: clean.hidden ? 'Y' : '',
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
        };
        writeRow_(t.sh, existing ? existing._row : null, SHEETS.entries.map((c) => row[c]));
      });
    } catch (err) {
      if (newPhoto) trashPhoto_(newPhoto);
      throw err;
    }
    if (oldPhoto) trashPhoto_(oldPhoto);
    return stateFor_(me);
  },

  toggleHidden: (me, req) => {
    withLock_(() => {
      const t = table_('entries');
      const r = ownEntry_(t, me, req.id, false);
      t.sh.getRange(r._row, SHEETS.entries.indexOf('hidden') + 1).setNumberFormat('@').setValue(r.hidden === 'Y' ? '' : 'Y');
    });
    return stateFor_(me);
  },

  deleteEntry: (me, req) => {
    let photo = '';
    withLock_(() => {
      const t = table_('entries');
      const r = ownEntry_(t, me, req.id, true);
      photo = r.photoId;
      t.sh.deleteRow(r._row);
    });
    if (photo) trashPhoto_(photo);
    return stateFor_(me);
  },

  rename: (me, req) => {
    const name = cleanName_(req.name);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === me.id);
      t.sh.getRange(r._row, SHEETS.members.indexOf('name') + 1).setNumberFormat('@').setValue(safe_(name));
      me.name = name;
    });
    return stateFor_(me);
  },

  saveSettings: (me, req) => {
    requireAdmin_(me);
    const s = req.settings || {};
    const goal = Math.round(Number(s.goal));
    if (!(goal >= 1 && goal <= 7)) throw fail_('invalid', '목표 운동일은 1에서 7 사이로 정해주세요.');
    const fine = Math.round(Number(s.fine) || 0);
    if (fine < 0 || fine > 10000000) throw fail_('invalid', '벌금 금액을 확인해주세요.');
    if (!isDate_(s.start)) throw fail_('invalid', '시작일을 골라주세요.');
    withLock_(() => writeSettings_({
      title: String(s.title || '').trim().slice(0, 40) || DEFAULT_SETTINGS.title,
      goal: String(goal),
      fine: String(fine),
      start: s.start,
      note: String(s.note || '').trim().slice(0, 60),
    }));
    return stateFor_(me);
  },

  // --- 관리자: 참가자 관리 ---
  members: (me) => {
    requireAdmin_(me);
    return { roster: roster_() };
  },

  addMember: (me, req) => {
    requireAdmin_(me);
    withLock_(() => addMember_(cleanName_(req.name), 'member'));
    return Object.assign(stateFor_(me), { roster: roster_() });
  },

  resetKey: (me, req) => {
    requireAdmin_(me);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === req.id);
      if (!r) throw fail_('not_found', '참가자를 찾을 수 없어요.');
      if (r.id === me.id) throw fail_('invalid', '내 링크는 여기서 재발급할 수 없어요. members 시트에서 직접 바꿔주세요.');
      t.sh.getRange(r._row, SHEETS.members.indexOf('key') + 1).setNumberFormat('@').setValue(uid_(32));
    });
    return { roster: roster_() };
  },

  removeMember: (me, req) => {
    requireAdmin_(me);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === req.id);
      if (!r) throw fail_('not_found', '참가자를 찾을 수 없어요.');
      if (r.id === me.id) throw fail_('invalid', '나 자신은 내보낼 수 없어요.');
      t.sh.deleteRow(r._row);
    });
    return Object.assign(stateFor_(me), { roster: roster_() });
  },
};

// ---------------------------------------------------------------------------
// 상태 조립: 숨긴 기록의 메모와 사진은 작성자에게만 내려보냄
// ---------------------------------------------------------------------------
function stateFor_(me) {
  const members = table_('members').rows.map((m) => ({ id: m.id, name: m.name, joinedAt: Number(m.joinedAt) || 0 }));
  const ids = {};
  members.forEach((m) => (ids[m.id] = true));
  const entries = table_('entries').rows
    .filter((r) => ids[r.memberId] && isDate_(r.date))
    .map((r) => {
      const hidden = r.hidden === 'Y';
      const e = {
        id: r.id,
        memberId: r.memberId,
        date: r.date,
        kind: r.kind,
        minutes: Number(r.minutes) || 0,
        km: Number(r.km) || 0,
        hidden,
        createdAt: Number(r.createdAt) || 0,
      };
      if (!hidden || r.memberId === me.id) {
        e.memo = r.memo;
        e.photo = r.photoId || '';
      }
      return e;
    });
  return {
    me: { id: me.id, name: me.name, role: me.role },
    members,
    entries,
    settings: readSettings_(),
  };
}

function roster_() {
  return table_('members').rows.map((m) => ({ id: m.id, name: m.name, role: m.role, key: m.key }));
}

// ---------------------------------------------------------------------------
// 인증과 검증
// ---------------------------------------------------------------------------
function auth_(key) {
  if (typeof key !== 'string' || key.length < 16) return null;
  const m = table_('members').rows.find((r) => r.key === key);
  return m ? { id: m.id, name: m.name, role: m.role === 'admin' ? 'admin' : 'member' } : null;
}

function requireAdmin_(me) {
  if (me.role !== 'admin') throw fail_('forbidden', '관리자만 할 수 있어요.');
}

function ownEntry_(t, me, id, allowAdmin) {
  const r = t.rows.find((x) => x.id === id);
  if (!r) throw fail_('not_found', '기록을 찾을 수 없어요.');
  if (r.memberId !== me.id && !(allowAdmin && me.role === 'admin')) throw fail_('forbidden', '본인 기록만 바꿀 수 있어요.');
  return r;
}

function cleanEntry_(src) {
  const date = String(src.date || '');
  if (!isDate_(date)) throw fail_('invalid', '날짜가 올바르지 않아요.');
  // 시간대 차이를 감안해 하루 여유를 둠
  if (date > addDaysStr_(today_(), 1)) throw fail_('invalid', '미래 날짜에는 기록할 수 없어요.');
  const kind = String(src.kind || '').trim().slice(0, 30);
  if (!kind) throw fail_('invalid', '종목을 입력해주세요.');
  return {
    date,
    kind,
    minutes: Math.max(0, Math.min(1440, Math.round(Number(src.minutes) || 0))),
    km: Math.max(0, Math.min(1000, Math.round((Number(src.km) || 0) * 10) / 10)),
    memo: String(src.memo || '').trim().slice(0, 1000),
    hidden: !!src.hidden,
  };
}

function cleanName_(name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) throw fail_('invalid', '이름을 입력해주세요.');
  return n;
}

// ---------------------------------------------------------------------------
// 사진 (구글 드라이브)
// ---------------------------------------------------------------------------
function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (_) {}
  }
  const folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function savePhoto_(me, photo) {
  const mime = /^image\/(jpeg|png|webp|gif)$/.test(photo.mime) ? photo.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(photo.data));
  if (!bytes.length) throw fail_('invalid', '사진 파일이 비어 있어요.');
  if (bytes.length > MAX_PHOTO_BYTES) throw fail_('too_large', '사진은 8MB 이하만 올릴 수 있어요.');
  const blob = Utilities.newBlob(bytes, mime, me.id + '-' + Date.now() + '.' + mime.split('/')[1]);
  const file = photoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

function trashPhoto_(id) {
  try {
    DriveApp.getFileById(id).setTrashed(true);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 시트 헬퍼
// ---------------------------------------------------------------------------
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw fail_('not_setup', '시트가 없어요. Apps Script에서 setup을 먼저 실행해주세요.');
  return sh;
}

function table_(name) {
  const sh = sheet_(name);
  const cols = SHEETS[name];
  const last = sh.getLastRow();
  if (last < 2) return { sh, rows: [] };
  const vals = sh.getRange(2, 1, last - 1, cols.length).getDisplayValues();
  const rows = [];
  vals.forEach((v, i) => {
    if (!v[0]) return;
    const o = { _row: i + 2 };
    cols.forEach((c, j) => (o[c] = String(v[j]).trim()));
    rows.push(o);
  });
  return { sh, rows };
}

// 모든 칸을 일반 텍스트로 써서 날짜·숫자 자동 변환을 막음
function writeRow_(sh, row, values) {
  if (!row) {
    row = sh.getLastRow() + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  }
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values.map((v) => safe_(String(v == null ? '' : v)))]);
}

// =, +, -, @ 로 시작하는 글이 수식으로 실행되지 않게 함
function safe_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function addMember_(name, role) {
  const sh = sheet_('members');
  const m = { id: 'm' + uid_(10), name, key: uid_(32), role, joinedAt: String(Date.now()) };
  writeRow_(sh, null, SHEETS.members.map((c) => m[c]));
  return m;
}

function readSettings_() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  table_('settings').rows.forEach((r) => {
    if (r.key in out) out[r.key] = r.value;
  });
  return out;
}

function writeSettings_(s) {
  const t = table_('settings');
  Object.keys(DEFAULT_SETTINGS).forEach((k) => {
    const existing = t.rows.find((r) => r.key === k);
    writeRow_(t.sh, existing ? existing._row : null, [k, s[k] == null ? '' : s[k]]);
    if (!existing) t.rows.push({ key: k, _row: t.sh.getLastRow() });
  });
}

// ---------------------------------------------------------------------------
// 기타
// ---------------------------------------------------------------------------
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail_('busy', '다른 저장이 진행 중이에요. 잠시 뒤 다시 시도해주세요.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function uid_(n) {
  let s = '';
  while (s.length < n) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, n);
}

function isDate_(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDaysStr_(s, n) {
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function mondayOf_(s) {
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
