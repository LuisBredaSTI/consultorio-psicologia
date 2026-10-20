const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT,'version.json'),'utf8')); } catch { return { version:'0.0.0', channel:'' }; } })();
const DATA_DIR = process.env.CONSULTORIO_DATA_DIR || path.join(ROOT, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'consultorio.db'));
db.exec('PRAGMA foreign_keys = ON');

// Tabelas base (instalação nova). Em bancos existentes nada muda; as colunas mais novas são
// adicionadas por addColumn logo abaixo.
db.exec(`CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, whatsapp TEXT, email TEXT, fee REAL NOT NULL DEFAULT 0, notes TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, session_date TEXT NOT NULL, session_time TEXT,
  status TEXT NOT NULL DEFAULT 'Agendada', value REAL NOT NULL DEFAULT 0, notes TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
)`);
db.exec(`CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL, payment_date TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, notes TEXT,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
)`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumn(table, column, definition) {
  if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('sessions', 'rescheduled_to_id', 'INTEGER');
addColumn('sessions', 'rescheduled_from_id', 'INTEGER');
addColumn('sessions', 'slot_removed', 'INTEGER DEFAULT 0');
addColumn('sessions', 'created_at', 'TEXT');
addColumn('patients', 'active', 'INTEGER DEFAULT 1');
addColumn('patients', 'weekday', 'INTEGER');
addColumn('patients', 'habitual_time', 'TEXT');
addColumn('patients', 'frequency', "TEXT DEFAULT 'Semanal'");
addColumn('patients', 'frequency_start', 'TEXT');
addColumn('sessions', 'billable_override', 'INTEGER');
// Preserve the financial meaning of historical cancellations before unifying their visible status.
db.exec("UPDATE sessions SET billable_override=1 WHERE status='Cancelada em cima da hora' AND billable_override IS NULL");
db.exec("UPDATE sessions SET billable_override=0 WHERE status='Cancelada antecipadamente' AND billable_override IS NULL");
db.exec("UPDATE sessions SET status='Desmarcou' WHERE status IN ('Cancelada antecipadamente','Cancelada em cima da hora')");

db.exec(`CREATE TABLE IF NOT EXISTS agenda_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lock_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_date_time ON sessions(session_date, session_time)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_patient_date ON sessions(patient_id, session_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_locks_date_time ON agenda_locks(lock_date, start_time)');
db.exec(`CREATE TABLE IF NOT EXISTS personal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  series_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
addColumn('personal_events', 'series_id', 'INTEGER');
db.exec('UPDATE personal_events SET series_id=id WHERE series_id IS NULL');

db.exec('CREATE INDEX IF NOT EXISTS idx_personal_events_date_time ON personal_events(event_date, event_time)');
db.exec(`CREATE TABLE IF NOT EXISTS patient_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  data BLOB NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_patient_attachments_patient ON patient_attachments(patient_id, created_at)');

const STATUSES = ['Agendada','Realizada','Desmarcou','Faltou'];
const json = (res, status, data) => { const body = JSON.stringify(data); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(body); };
const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
async function body(req) { let data=''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; }
const nowIso = () => new Date().toISOString();
function isoDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
// Sessão do paciente cai nesta data? Semanal: todo dia da semana preferencial.
// Quinzenal: a cada 14 dias (mesmo dia da semana), contando a partir da primeira
// ocorrência do dia preferencial na data de referência.
function patientDue(p,d){
  if(new Date(d+'T12:00:00').getDay()!==Number(p.weekday)) return false;
  if((p.frequency||'Semanal')!=='Quinzenal') return true;
  const ref=p.frequency_start; if(!ref||d<ref) return false;
  const base=new Date(ref+'T12:00:00'); base.setDate(base.getDate()+((Number(p.weekday)-base.getDay()+7)%7));
  const days=Math.round((new Date(d+'T12:00:00')-base)/86400000);
  return days>=0 && days%14===0;
}
const today = () => isoDate(new Date());
const thisMonth = () => today().slice(0,7);
function eachDay(from, to, fn){ for(const dt=new Date(from+'T12:00:00'), last=new Date(to+'T12:00:00'); dt<=last; dt.setDate(dt.getDate()+1)) fn(isoDate(dt)); }
function groupBy(rows, key){ const m=new Map(); for(const r of rows){ if(!m.has(r[key])) m.set(r[key],[]); m.get(r[key]).push(r); } return m; }
const weeksCount = n => Math.max(1,Math.min(52,Number(n)||16));
const collisionError = c => c.type==='lock' ? `Horário travado: ${c.lock.reason}`
  : c.type==='event' ? `Horário já ocupado por compromisso pessoal: ${c.event.title}`
  : `Horário já ocupado por ${c.session.patient_name}`;
const money = v => Number(v || 0);
const xmlEsc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const excelCell = (value, type='String') => `<Cell><Data ss:Type="${type}">${xmlEsc(value)}</Data></Cell>`;
function excelXml(workbookName, sheets){
  const rows=sheets.map(sh=>`<Worksheet ss:Name="${xmlEsc(sh.name)}"><Table>${sh.rows.map(r=>`<Row>${r.map(c=>excelCell(c.value,c.type||'String')).join('')}</Row>`).join('')}</Table></Worksheet>`).join('');
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>${xmlEsc(workbookName)}</Title></DocumentProperties>${rows}</Workbook>`;
}



function isLocked(date, time=null) {
  const day = get('SELECT * FROM agenda_locks WHERE lock_date=? AND start_time IS NULL LIMIT 1', date);
  if (day) return day;
  if (time) return get('SELECT * FROM agenda_locks WHERE lock_date=? AND substr(start_time,1,2)=substr(?,1,2) LIMIT 1', date, time);
  return null;
}
function sessionById(id) {
  return get(`SELECT s.*, p.name AS patient_name, p.whatsapp, p.fee AS patient_fee
              FROM sessions s JOIN patients p ON p.id=s.patient_id WHERE s.id=?`, id);
}
function checkCollision(date, time, ignoreId=null) {
  if (!time) return null;
  const lock = isLocked(date, time); if (lock) return {type:'lock', lock};
  let sql=`SELECT s.*, p.name AS patient_name FROM sessions s JOIN patients p ON p.id=s.patient_id
           WHERE s.session_date=? AND substr(s.session_time,1,2)=substr(?,1,2) AND COALESCE(s.slot_removed,0)=0 AND s.status<>'Desmarcou'`;
  const params=[date,time];
  if (ignoreId) { sql += ' AND s.id<>?'; params.push(ignoreId); }
  const s=get(sql,...params); if (s) return {type:'session',session:s};
  const event=get('SELECT * FROM personal_events WHERE event_date=? AND substr(event_time,1,2)=substr(?,1,2) LIMIT 1',date,time);
  return event ? {type:'event',event} : null;
}
function normalizeValue(b, patientId) {
  if (b.valor !== undefined && b.valor !== null && b.valor !== '') return money(b.valor);
  const p=get('SELECT fee FROM patients WHERE id=?', patientId); return money(p?.fee);
}
function billableSessions() {
  return all(`SELECT s.*, p.name AS patient_name, p.whatsapp
              FROM sessions s JOIN patients p ON p.id=s.patient_id
              WHERE s.status IN ('Realizada','Faltou')
              ORDER BY s.patient_id, s.session_date, COALESCE(s.session_time,'00:00'), s.id`);
}
function unpaidSessionRows() {
  const sessions=billableSessions();
  const payments=all(`SELECT patient_id, payment_date, amount, id FROM payments ORDER BY patient_id, payment_date, id`);
  const byPatient=groupBy(payments.map(p=>({...p, remaining:Number(p.amount||0)})),'patient_id');
  const out=[];
  for(const s of sessions){
    let remaining=Number(s.value||0);
    const ps=byPatient.get(s.patient_id)||[];
    for(const p of ps){
      if(remaining<=0) break;
      const used=Math.min(remaining,p.remaining);
      remaining-=used; p.remaining-=used;
    }
    if(remaining>0.005) out.push({...s, remaining:Math.round(remaining*100)/100});
  }
  return out;
}

function insertSession(patientId, date, time, status, value, notes){
  return db.prepare('INSERT INTO sessions (patient_id,session_date,session_time,status,value,notes,slot_removed,created_at) VALUES (?,?,?,?,?,?,0,?)')
    .run(patientId,date,time,status,value,notes||null,nowIso()).lastInsertRowid;
}
// Cria as sessões 'Agendada' do paciente nos dias previstos pelo cadastro entre inicio e fim.
// Pula horários ocupados/travados e dias em que o paciente já tem sessão (de qualquer status),
// para não recriar o que foi desmarcado, reagendado ou excluído.
function fillPatientAgenda(p, inicio, fim){
  let created=0, skipped=0; const t=p.habitual_time;
  eachDay(inicio, fim, d=>{
    if(!patientDue(p,d)) return;
    if(checkCollision(d,t) || get('SELECT 1 FROM sessions WHERE patient_id=? AND session_date=?',p.id,d)){ skipped++; return; }
    insertSession(p.id,d,t,'Agendada',p.fee,null); created++;
  });
  return {created,skipped};
}

async function api(req,res,url) {
  try {
    if (url.pathname==='/api/health' && req.method==='GET') return json(res,200,{ok:true,runtime:'Node.js',sqlite:'node:sqlite',version:APP_VERSION.version,channel:APP_VERSION.channel});

    // Patients
    if (url.pathname==='/api/pacientes' && req.method==='GET') {
      const q=(url.searchParams.get('q')||'').trim();
      const status=url.searchParams.get('status')||'ativos';
      let where=[]; const params=[];
      if (q) { where.push('(p.name LIKE ? OR p.whatsapp LIKE ? OR printf("%.2f",p.fee) LIKE ? OR p.habitual_time LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
      if (status==='ativos') where.push('COALESCE(p.active,1)=1');
      if (status==='inativos') where.push('COALESCE(p.active,1)=0');
      const sql=`SELECT p.*,
        COALESCE((SELECT SUM(CASE WHEN s.status IN ('Realizada','Faltou') THEN s.value ELSE 0 END) FROM sessions s WHERE s.patient_id=p.id),0) AS total_due,
        COALESCE((SELECT SUM(pg.amount) FROM payments pg WHERE pg.patient_id=p.id),0) AS total_paid,
        COALESCE((SELECT SUM(CASE WHEN s.status IN ('Realizada','Faltou') THEN s.value ELSE 0 END) FROM sessions s WHERE s.patient_id=p.id),0)
          - COALESCE((SELECT SUM(pg.amount) FROM payments pg WHERE pg.patient_id=p.id),0) AS pending
        FROM patients p ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY p.name`;
      return json(res,200,all(sql,...params));
    }
    if (url.pathname==='/api/pacientes' && req.method==='POST') {
      const b=await body(req);
      if(!String(b.nome||'').trim() || b.valor_sessao==null || b.dia_preferencial==null || !b.horario_preferencial) return json(res,400,{error:'Nome, valor da sessão, dia e horário preferencial são obrigatórios'});
      const fee=money(b.valor_sessao), weekday=Number(b.dia_preferencial), frequency=b.frequencia||'Semanal', frequencyStart=b.data_inicio_frequencia||null;
      if(!Number.isInteger(weekday)||weekday<0||weekday>6) return json(res,400,{error:'Dia da semana inválido'});
      const info=db.prepare(`INSERT INTO patients (name,whatsapp,email,fee,frequency,frequency_start,weekday,habitual_time,active,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(String(b.nome).trim(),b.telefone||null,b.email||null,fee,frequency,frequencyStart,weekday,b.horario_preferencial,1,b.observacoes||null);
      return json(res,201,get('SELECT * FROM patients WHERE id=?',info.lastInsertRowid));
    }
    let m=url.pathname.match(/^\/api\/pacientes\/(\d+)$/);
    if(m && req.method==='GET') {
      const p=get('SELECT * FROM patients WHERE id=?',m[1]); if(!p) return json(res,404,{error:'Paciente não encontrado'});
      return json(res,200,{paciente:p,sessoes:all('SELECT * FROM sessions WHERE patient_id=? ORDER BY session_date DESC, session_time DESC',m[1]),pagamentos:all('SELECT * FROM payments WHERE patient_id=? ORDER BY payment_date DESC',m[1]),anexos:all('SELECT id,patient_id,filename,mime_type,size,created_at FROM patient_attachments WHERE patient_id=? ORDER BY created_at DESC,id DESC',m[1])});
    }
    if(m && req.method==='PATCH') {
      const p=get('SELECT * FROM patients WHERE id=?',m[1]); if(!p) return json(res,404,{error:'Paciente não encontrado'});
      const b=await body(req);
      const name=b.nome!==undefined?String(b.nome).trim():p.name;
      const phone=b.telefone!==undefined?b.telefone:p.whatsapp;
      const email=b.email!==undefined?b.email:p.email;
      const fee=b.valor_sessao!==undefined?money(b.valor_sessao):p.fee;
      const weekday=b.dia_preferencial!==undefined?Number(b.dia_preferencial):p.weekday;
      const time=b.horario_preferencial!==undefined?b.horario_preferencial:p.habitual_time;
      const frequency=b.frequencia!==undefined?b.frequencia:(p.frequency||'Semanal');
      const frequencyStart=b.data_inicio_frequencia!==undefined?(b.data_inicio_frequencia||null):(p.frequency_start||null);
      const active=b.active!==undefined?Number(!!b.active):Number(p.active??1);
      db.prepare(`UPDATE patients SET name=?, whatsapp=?, email=?, fee=?, frequency=?, frequency_start=?, weekday=?, habitual_time=?, active=?, notes=? WHERE id=?`)
        .run(name,phone,email,fee,frequency,frequencyStart,weekday,time,active,b.observacoes!==undefined?b.observacoes:p.notes,m[1]);
      return json(res,200,get('SELECT * FROM patients WHERE id=?',m[1]));
    }

    // Patient report (Excel-compatible .xls with two worksheets)
    if(url.pathname==='/api/relatorio-pacientes' && req.method==='GET') {
      const from=(url.searchParams.get('from')||'').trim();
      const patientRows=all('SELECT id,name,whatsapp,fee,active FROM patients ORDER BY name COLLATE NOCASE');
      let sessionSql=`SELECT s.patient_id,s.session_date,s.session_time,p.name AS patient_name,s.status,s.notes,s.value FROM sessions s JOIN patients p ON p.id=s.patient_id`;
      let paymentSql=`SELECT pg.patient_id,pg.payment_date,p.name AS patient_name,pg.notes,pg.amount FROM payments pg JOIN patients p ON p.id=pg.patient_id`;
      if(from){sessionSql+=' WHERE s.session_date>=?';paymentSql+=' WHERE pg.payment_date>=?'}
      sessionSql+=' ORDER BY p.name COLLATE NOCASE,s.session_date,s.session_time,s.id';
      paymentSql+=' ORDER BY p.name COLLATE NOCASE,pg.payment_date,pg.id';
      const fromParams=from?[from]:[];
      const sessionsBy=groupBy(all(sessionSql,...fromParams),'patient_id'), paymentsBy=groupBy(all(paymentSql,...fromParams),'patient_id');
      const sOut=[['Nome','Data sessão','Horário','Status','Observação','Valor'].map(v=>({value:v}))];
      for(const p of patientRows){const rows=sessionsBy.get(p.id)||[]; for(const r of rows)sOut.push([{value:p.name},{value:r.session_date},{value:r.session_time||''},{value:r.status},{value:r.notes||''},{value:Number(r.value||0),type:'Number'}])}
      const payOut=[['Nome','Data pagamento','Observação','Valor'].map(v=>({value:v}))];
      for(const p of patientRows){const rows=paymentsBy.get(p.id)||[]; for(const r of rows)payOut.push([{value:p.name},{value:r.payment_date},{value:r.notes||''},{value:Number(r.amount||0),type:'Number'}])}
      const xml=excelXml('Relatório de pacientes',[{name:'Atendimentos',rows:sOut},{name:'Pagamentos',rows:payOut}]);
      res.writeHead(200,{'Content-Type':'application/vnd.ms-excel; charset=utf-8','Content-Disposition':`attachment; filename="relatorio-pacientes.xls"`,'Cache-Control':'no-store'});res.end(xml);return;
    }
    // Patient attachments stored as BLOBs in SQLite
    let am=url.pathname.match(/^\/api\/pacientes\/(\d+)\/anexos$/);
    if(am && req.method==='GET') {
      const pid=Number(am[1]); if(!get('SELECT id FROM patients WHERE id=?',pid)) return json(res,404,{error:'Paciente não encontrado'});
      return json(res,200,all('SELECT id,patient_id,filename,mime_type,size,created_at FROM patient_attachments WHERE patient_id=? ORDER BY created_at DESC,id DESC',pid));
    }
    if(am && req.method==='POST') {
      const pid=Number(am[1]); if(!get('SELECT id FROM patients WHERE id=?',pid)) return json(res,404,{error:'Paciente não encontrado'});
      const b=await body(req); if(!b.filename||!b.data) return json(res,400,{error:'Arquivo e dados são obrigatórios'});
      const raw=String(b.data).replace(/^data:[^;]+;base64,/,''); const buf=Buffer.from(raw,'base64');
      if(!buf.length) return json(res,400,{error:'Arquivo vazio'}); if(buf.length>20*1024*1024) return json(res,413,{error:'Arquivo maior que 20 MB'});
      const info=db.prepare('INSERT INTO patient_attachments (patient_id,filename,mime_type,size,data) VALUES (?,?,?,?,?)').run(pid,String(b.filename).slice(0,255),String(b.mime_type||'application/octet-stream'),buf.length,buf);
      return json(res,201,get('SELECT id,patient_id,filename,mime_type,size,created_at FROM patient_attachments WHERE id=?',info.lastInsertRowid));
    }
    let ax=url.pathname.match(/^\/api\/anexos\/(\d+)$/);
    if(ax && req.method==='GET') {
      const a=get('SELECT * FROM patient_attachments WHERE id=?',Number(ax[1])); if(!a)return json(res,404,{error:'Arquivo não encontrado'});
      const safe=String(a.filename).replace(/[\\\"\r\n]/g,'_');res.writeHead(200,{'Content-Type':a.mime_type||'application/octet-stream','Content-Length':a.size,'Content-Disposition':`attachment; filename="${safe}"`,'Cache-Control':'no-store'});res.end(Buffer.from(a.data));return;
    }
    if(ax && req.method==='DELETE') {db.prepare('DELETE FROM patient_attachments WHERE id=?').run(Number(ax[1]));return json(res,200,{ok:true});}

    // Agenda
    if(url.pathname==='/api/agenda' && req.method==='GET') {
      const start=url.searchParams.get('start'), end=url.searchParams.get('end');
      if(!start||!end) return json(res,400,{error:'start e end são obrigatórios'});
      const sessoes=all(`SELECT s.*, p.name AS patient_name, p.whatsapp, p.fee AS patient_fee
        FROM sessions s JOIN patients p ON p.id=s.patient_id
        WHERE s.session_date BETWEEN ? AND ? ORDER BY s.session_date, s.session_time, p.name`,start,end);
      const locks=all('SELECT * FROM agenda_locks WHERE lock_date BETWEEN ? AND ? ORDER BY lock_date,start_time',start,end);
      const eventos=all('SELECT * FROM personal_events WHERE event_date BETWEEN ? AND ? ORDER BY event_date,event_time,title',start,end);
      return json(res,200,{sessoes,locks,eventos});
    }
    if(url.pathname==='/api/sessoes' && req.method==='GET') {
      const mes=url.searchParams.get('mes'); let sql='SELECT s.*, p.name AS patient_name FROM sessions s JOIN patients p ON p.id=s.patient_id';
      if(mes) sql+=' WHERE substr(s.session_date,1,7)=?'; sql+=' ORDER BY s.session_date, s.session_time, p.name';
      return json(res,200,mes?all(sql,mes):all(sql));
    }
    if(url.pathname==='/api/sessoes' && req.method==='POST') {
      const b=await body(req); if(!b.patient_id||!b.data||!b.status) return json(res,400,{error:'patient_id, data e status são obrigatórios'});
      if(!STATUSES.includes(b.status)) return json(res,400,{error:'Status inválido'});
      const collision=checkCollision(b.data,b.horario||null); if(collision) return json(res,409,{error:collisionError(collision)});
      const value=normalizeValue(b,b.patient_id);
      const firstId=insertSession(b.patient_id,b.data,b.horario||null,b.status,value,b.observacao);
      let criadas=1, ignoradas=0;
      if(b.repetir && b.horario){ // mesmas data e horário nas semanas seguintes, pulando conflitos
        for(let i=1;i<weeksCount(b.semanas);i++){
          const dt=new Date(b.data+'T12:00:00'); dt.setDate(dt.getDate()+i*7); const d=isoDate(dt);
          if(checkCollision(d,b.horario)){ ignoradas++; continue; }
          insertSession(b.patient_id,d,b.horario,b.status,value,b.observacao); criadas++;
        }
      }
      return json(res,201,{...sessionById(firstId),criadas,ignoradas});
    }
    let rm=url.pathname.match(/^\/api\/sessoes\/(\d+)\/reagendar$/);
    if(rm && req.method==='POST') {
      const id=Number(rm[1]); const old=sessionById(id); if(!old) return json(res,404,{error:'Sessão não encontrada'});
      const b=await body(req); const newDate=b.data,newTime=b.horario;
      if(!newDate||!newTime) return json(res,400,{error:'Nova data e horário são obrigatórios'});
      const collision=checkCollision(newDate,newTime); if(collision) return json(res,409,{error:collisionError(collision)});
      const info=db.prepare('INSERT INTO sessions (patient_id,session_date,session_time,status,value,notes,slot_removed,created_at,rescheduled_from_id) VALUES (?,?,?,?,?,?,0,?,?)').run(old.patient_id,newDate,newTime,'Agendada',old.value,old.notes||null,nowIso(),id);
      db.prepare('UPDATE sessions SET rescheduled_to_id=?, slot_removed=1 WHERE id=?').run(info.lastInsertRowid,id);
      return json(res,201,{original:sessionById(id),nova:sessionById(info.lastInsertRowid)});
    }
    rm=url.pathname.match(/^\/api\/sessoes\/(\d+)\/sem-reagendamento$/);
    if(rm && req.method==='POST') { const id=Number(rm[1]); const s=sessionById(id); if(!s) return json(res,404,{error:'Sessão não encontrada'}); db.prepare('UPDATE sessions SET slot_removed=1 WHERE id=?').run(id); return json(res,200,sessionById(id)); }
    m=url.pathname.match(/^\/api\/sessoes\/(\d+)$/);
    if(m && req.method==='PATCH') {
      const id=Number(m[1]); const old=sessionById(id); if(!old) return json(res,404,{error:'Sessão não encontrada'});
      const b=await body(req); const date=b.data??old.session_date, time=b.horario??old.session_time, status=b.status??old.status;
      if(!STATUSES.includes(status)) return json(res,400,{error:'Status inválido'});
      if((date!==old.session_date || time!==old.session_time) && ['Realizada','Faltou'].includes(old.status)) return json(res,409,{error:'Sessões Realizada e Faltou não podem ser remanejadas.'});
      if(isLocked(date,time) && (date!==old.session_date || time!==old.session_time || b.status!==undefined)) return json(res,409,{error:'Este horário está travado'});
      const slotRemoved=b.slot_removed!==undefined?Number(!!b.slot_removed):Number(old.slot_removed||0);
      const occupiedBefore=old.status!=='Desmarcou' && !Number(old.slot_removed), occupiesNow=status!=='Desmarcou' && !slotRemoved;
      const moved=date!==old.session_date || time!==old.session_time;
      const collision=occupiesNow && (moved || !occupiedBefore) ? checkCollision(date,time,id) : null; if(collision) return json(res,409,{error:collisionError(collision)});
      const value=b.valor!==undefined?money(b.valor):old.value;
      const billableOverride=status==='Desmarcou'?0:null;
      db.prepare('UPDATE sessions SET session_date=?,session_time=?,status=?,value=?,notes=?,slot_removed=?,billable_override=? WHERE id=?').run(date,time,status,value,b.observacao!==undefined?b.observacao:old.notes,slotRemoved,billableOverride,id);
      return json(res,200,sessionById(id));
    }

    // Exclui os agendamentos futuros (status Agendada) do paciente. Mantém realizadas, faltas,
    // desmarcadas e as sessões criadas por reagendamento.
    let delSched=url.pathname.match(/^\/api\/pacientes\/(\d+)\/agendamentos$/);
    if(delSched && req.method==='DELETE') {
      if(!get('SELECT id FROM patients WHERE id=?',delSched[1])) return json(res,404,{error:'Paciente não encontrado'});
      const r=db.prepare("DELETE FROM sessions WHERE patient_id=? AND status='Agendada' AND session_date>=? AND rescheduled_from_id IS NULL").run(delSched[1],today());
      return json(res,200,{deleted:Number(r.changes)});
    }

    // Popular somente a agenda do paciente cujo horário foi alterado.
    let popPatient=url.pathname.match(/^\/api\/pacientes\/(\d+)\/popular$/);
    if(popPatient && req.method==='POST') {
      const p=get('SELECT * FROM patients WHERE id=?',popPatient[1]); if(!p) return json(res,404,{error:'Paciente não encontrado'});
      const b=await body(req), inicio=b.inicio||today(), fim=b.fim;
      if(!fim||inicio>fim) return json(res,400,{error:'Informe um período válido'});
      return json(res,200,fillPatientAgenda(p,inicio,fim));
    }

    // Popular agenda a partir do cadastro dos pacientes
    if(url.pathname==='/api/agenda/popular' && req.method==='POST') {
      const b=await body(req); const inicio=b.inicio||today(), fim=b.fim;
      if(!fim) return json(res,400,{error:'Data final é obrigatória'});
      if(inicio>fim) return json(res,400,{error:'A data final não pode ser anterior à inicial'});
      const patients=all(`SELECT * FROM patients WHERE COALESCE(active,1)=1 AND weekday IS NOT NULL AND habitual_time IS NOT NULL AND habitual_time<>'' ORDER BY name`);
      let created=0, skipped=0;
      for(const p of patients){ const r=fillPatientAgenda(p,inicio,fim); created+=r.created; skipped+=r.skipped; }
      return json(res,201,{created,skipped});
    }
    // Personal events
    if(url.pathname==='/api/eventos' && req.method==='POST') {
      const b=await body(req);
      if(!b.data||!b.horario||!String(b.titulo||'').trim()) return json(res,400,{error:'Data, horário e título são obrigatórios'});
      const first=checkCollision(b.data,b.horario); if(first) return json(res,409,{error:collisionError(first)});
      const repeat=!!b.repetir;
      const count=repeat?weeksCount(b.semanas):1;
      let created=[], skipped=0, seriesId=null;
      for(let i=0;i<count;i++){
        const dt=new Date(b.data+'T12:00:00'); dt.setDate(dt.getDate()+i*7); const d=isoDate(dt);
        if(checkCollision(d,b.horario)){ skipped++; continue; }
        const info=db.prepare('INSERT INTO personal_events (event_date,event_time,title,notes,series_id) VALUES (?,?,?,?,NULL)')
          .run(d,b.horario,String(b.titulo).trim(),b.observacao||null);
        if(seriesId===null) seriesId=Number(info.lastInsertRowid);
        db.prepare('UPDATE personal_events SET series_id=? WHERE id=?').run(seriesId,info.lastInsertRowid);
        created.push(get('SELECT * FROM personal_events WHERE id=?',info.lastInsertRowid));
      }
      return json(res,201,{eventos:created,skipped,series_id:seriesId});
    }
    m=url.pathname.match(/^\/api\/eventos\/(\d+)$/);
    if(m && req.method==='DELETE') {
      const ev=get('SELECT * FROM personal_events WHERE id=?',m[1]);
      if(!ev) return json(res,404,{error:'Compromisso não encontrado'});
      const scope=url.searchParams.get('scope')||'one';
      if(scope==='series' && ev.series_id) db.prepare('DELETE FROM personal_events WHERE series_id=?').run(ev.series_id);
      else db.prepare('DELETE FROM personal_events WHERE id=?').run(m[1]);
      return json(res,200,{ok:true,scope});
    }

    // Locks
    if(url.pathname==='/api/travar' && req.method==='POST') {
      const b=await body(req);
      const startDate=b.inicio||b.data, endDate=b.fim||b.data;
      if(!startDate||!endDate||!b.motivo) return json(res,400,{error:'Data inicial, data final e motivo são obrigatórios'});
      if(startDate>endDate) return json(res,400,{error:'A data final não pode ser anterior à inicial'});
      const start=b.horario||null, end=b.horario||null, created=[];
      eachDay(startDate,endDate,d=>{
        if(!isLocked(d,start)){
          const info=db.prepare('INSERT INTO agenda_locks (lock_date,start_time,end_time,reason) VALUES (?,?,?,?)').run(d,start,end,b.motivo);
          created.push(get('SELECT * FROM agenda_locks WHERE id=?',info.lastInsertRowid));
        }
      });
      return json(res,201,{locks:created});
    }
    m=url.pathname.match(/^\/api\/travar\/(\d+)$/);
    if(m && req.method==='DELETE') { db.prepare('DELETE FROM agenda_locks WHERE id=?').run(m[1]); return json(res,200,{ok:true}); }

    // Finance session launch editing: historical billable sessions are editable from Financeiro.
    let fm=url.pathname.match(/^\/api\/financeiro\/sessoes\/(\d+)$/);
    if(fm && req.method==='PATCH') {
      const id=Number(fm[1]); const old=sessionById(id);
      if(!old) return json(res,404,{error:'Lançamento de sessão não encontrado'});
      const b=await body(req);
      const patientId=b.patient_id!==undefined?Number(b.patient_id):old.patient_id;
      const date=b.data!==undefined?String(b.data):old.session_date;
      const time=b.horario!==undefined?(b.horario||null):old.session_time;
      const status=b.status!==undefined?String(b.status):old.status;
      if(!STATUSES.includes(status)) return json(res,400,{error:'Status inválido'});
      if(!patientId) return json(res,400,{error:'Paciente é obrigatório'});
      if(!date) return json(res,400,{error:'Data é obrigatória'});
      if((date!==old.session_date || time!==old.session_time) && isLocked(date,time)) return json(res,409,{error:'Este horário está travado'});
      const occupies=status!=='Desmarcou' && (date!==old.session_date || time!==old.session_time || old.status==='Desmarcou');
      const collision=occupies ? checkCollision(date,time,id) : null;
      if(collision) return json(res,409,{error:collisionError(collision)});
      const value=b.valor!==undefined?money(b.valor):old.value;
      const billableOverride=status==='Desmarcou'?0:null;
      db.prepare('UPDATE sessions SET patient_id=?,session_date=?,session_time=?,status=?,value=?,notes=?,billable_override=? WHERE id=?').run(patientId,date,time,status,value,b.observacao!==undefined?b.observacao:old.notes,billableOverride,id);
      return json(res,200,sessionById(id));
    }

    // Payments
    if(url.pathname==='/api/pagamentos' && req.method==='GET') {
      const mes=url.searchParams.get('mes'); let sql='SELECT pg.*, p.name AS patient_name FROM payments pg JOIN patients p ON p.id=pg.patient_id';
      if(mes) sql+=' WHERE substr(pg.payment_date,1,7)=?'; sql+=' ORDER BY pg.payment_date DESC, p.name'; return json(res,200,mes?all(sql,mes):all(sql));
    }
    if(url.pathname==='/api/pagamentos' && req.method==='POST') {
      const b=await body(req); if(!b.patient_id||!b.data||b.valor==null) return json(res,400,{error:'patient_id, data e valor são obrigatórios'});
      const info=db.prepare('INSERT INTO payments (patient_id,payment_date,amount,notes) VALUES (?,?,?,?)').run(b.patient_id,b.data,money(b.valor),b.observacao||null); return json(res,201,get('SELECT * FROM payments WHERE id=?',info.lastInsertRowid));
    }
    let pm=url.pathname.match(/^\/api\/pagamentos\/(\d+)$/);
    if(pm && req.method==='PATCH') {
      const old=get('SELECT * FROM payments WHERE id=?',pm[1]); if(!old) return json(res,404,{error:'Pagamento não encontrado'});
      const b=await body(req);
      db.prepare('UPDATE payments SET patient_id=?, payment_date=?, amount=?, notes=? WHERE id=?').run(
        b.patient_id!==undefined?Number(b.patient_id):old.patient_id,
        b.data!==undefined?b.data:old.payment_date,
        b.valor!==undefined?money(b.valor):old.amount,
        b.observacao!==undefined?b.observacao:old.notes,
        pm[1]);
      return json(res,200,get('SELECT * FROM payments WHERE id=?',pm[1]));
    }
    if(pm && req.method==='DELETE') { db.prepare('DELETE FROM payments WHERE id=?').run(pm[1]); return json(res,200,{ok:true}); }

    // Finance drill-down and payment entry
    if(url.pathname==='/api/financeiro/previsao' && req.method==='GET') {
      const weeks=Math.max(1,Math.min(12,Number(url.searchParams.get('weeks')||4)));
      const today=new Date(); today.setHours(12,0,0,0);
      const day=today.getDay(); const daysToNextMonday=(8-day)%7 || 7;
      const start=new Date(today); start.setDate(start.getDate()+daysToNextMonday);
      const out=[];
      let total=0, qtd=0;
      for(let i=0;i<weeks;i++){
        const a=new Date(start); a.setDate(a.getDate()+i*7);
        const b=new Date(a); b.setDate(b.getDate()+6);
        const ini=isoDate(a), fim=isoDate(b);
        const rows=all(`SELECT s.id,s.session_date,s.session_time,s.value,s.status,p.name AS patient_name
          FROM sessions s JOIN patients p ON p.id=s.patient_id
          WHERE s.session_date BETWEEN ? AND ? AND s.status='Agendada' AND COALESCE(s.slot_removed,0)=0
          ORDER BY s.session_date,s.session_time,p.name`,ini,fim);
        const valor=rows.reduce((sum,x)=>sum+Number(x.value||0),0);
        total+=valor; qtd+=rows.length;
        out.push({inicio:ini,fim:fim,qtd:rows.length,valor,agendamentos:rows});
      }
      return json(res,200,{weeks,start:isoDate(start),total,qtd,periodos:out});
    }
    if(url.pathname==='/api/financeiro/resumo' && req.method==='GET') {
      const mes=url.searchParams.get('mes')||thisMonth();
      const atendimento=get(`SELECT COALESCE(SUM(CASE WHEN status='Realizada' THEN value ELSE 0 END),0) valor, COUNT(CASE WHEN status='Realizada' THEN 1 END) qtd FROM sessions WHERE substr(session_date,1,7)=?`,mes);
      const rec=get(`SELECT COALESCE(SUM(amount),0) valor, COUNT(*) qtd FROM payments WHERE substr(payment_date,1,7)=?`,mes);
      const faltas=get(`SELECT COALESCE(SUM(value),0) valor, COUNT(*) qtd FROM sessions WHERE substr(session_date,1,7)=? AND status='Faltou'`,mes);
      const reag=get(`SELECT COALESCE(SUM(value),0) valor, COUNT(*) qtd FROM sessions WHERE substr(session_date,1,7)=? AND rescheduled_to_id IS NOT NULL`,mes);
      const unpaid=unpaidSessionRows();
      const due=unpaid.reduce((a,x)=>a+x.remaining,0);
      const today=new Date(); today.setHours(0,0,0,0); const cutoff=new Date(today); cutoff.setDate(cutoff.getDate()-30);
      const atrasados=unpaid.filter(x=>new Date(x.session_date+'T12:00:00')<=cutoff);
      return json(res,200,{mes,atendimento,devido:{valor:due,qtd:unpaid.length},recebimentos:rec,realizadas:atendimento,faltas,reagendadas:reag,atrasados:{valor:atrasados.reduce((a,x)=>a+x.remaining,0),qtd:atrasados.length}});
    }
    if(url.pathname==='/api/financeiro/detalhes' && req.method==='GET') {
      const mes=url.searchParams.get('mes')||thisMonth(), tipo=url.searchParams.get('tipo')||'recebimentos';
      if(tipo==='recebimentos') return json(res,200,all(`SELECT pg.id,pg.payment_date AS data,pg.amount AS valor,p.name AS paciente_name,pg.notes AS observacao FROM payments pg JOIN patients p ON p.id=pg.patient_id WHERE substr(pg.payment_date,1,7)=? ORDER BY p.name,pg.payment_date,pg.id`,mes));
      if(tipo==='devido'){
        const rows=unpaidSessionRows().sort((a,b)=>a.patient_name.localeCompare(b.patient_name)||a.session_date.localeCompare(b.session_date));
        return json(res,200,rows.map(x=>({id:x.id,data:x.session_date,horario:x.session_time,valor:x.remaining,valor_original:x.value,status:x.status,paciente_name:x.patient_name,observacao:x.notes,origem:'Sessão'})));
      }
      if(tipo==='atrasados'){
        const cutoff=new Date(); cutoff.setHours(0,0,0,0); cutoff.setDate(cutoff.getDate()-30);
        const rows=unpaidSessionRows().filter(x=>new Date(x.session_date+'T12:00:00')<=cutoff).sort((a,b)=>a.patient_name.localeCompare(b.patient_name)||a.session_date.localeCompare(b.session_date));
        return json(res,200,rows.map(x=>({id:x.id,data:x.session_date,horario:x.session_time,valor:x.remaining,status:x.status,paciente_name:x.patient_name,observacao:x.notes,dias:Math.floor((Date.now()-new Date(x.session_date+'T12:00:00').getTime())/86400000)})));
      }
      const map={realizadas:"status='Realizada'",faltas:"status='Faltou'",reagendadas:"rescheduled_to_id IS NOT NULL"};
      const where=map[tipo]||map.realizadas;
      const isYear=/^\d{4}$/.test(mes);
      const period=isYear?`substr(s.session_date,1,4)=?`:`substr(s.session_date,1,7)=?`;
      return json(res,200,all(`SELECT s.id,s.session_date AS data,s.session_time AS horario,s.value AS valor,s.status,p.name AS paciente_name,s.notes AS observacao FROM sessions s JOIN patients p ON p.id=s.patient_id WHERE ${period} AND ${where} ORDER BY p.name,s.session_date,s.session_time,s.id`,mes));
    }
    if(url.pathname==='/api/resumo-ano' && req.method==='GET') {
      const ano=String(url.searchParams.get('ano')||new Date().getFullYear());
      const out=[];
      for(let i=1;i<=12;i++){
        const mes=`${ano}-${String(i).padStart(2,'0')}`;
        const atendimento=get(`SELECT COALESCE(SUM(value),0) valor, COUNT(*) qtd FROM sessions WHERE substr(session_date,1,7)=? AND status='Realizada'`,mes);
        const rec=get(`SELECT COALESCE(SUM(amount),0) valor FROM payments WHERE substr(payment_date,1,7)=?`,mes);
        const faltas=get(`SELECT COALESCE(SUM(value),0) valor, COUNT(*) qtd FROM sessions WHERE substr(session_date,1,7)=? AND status='Faltou'`,mes);
        const reag=get(`SELECT COALESCE(SUM(value),0) valor, COUNT(*) qtd FROM sessions WHERE substr(session_date,1,7)=? AND rescheduled_to_id IS NOT NULL`,mes);
        out.push({mes,atendimento_qtd:atendimento.qtd,atendimento_valor:atendimento.valor,recebimento:rec.valor,faltas_qtd:faltas.qtd,faltas_valor:faltas.valor,reag_qtd:reag.qtd,reag_valor:reag.valor});
      }
      const totals={};
      for(const k of Object.keys(out[0]).filter(k=>k!=='mes')) totals[k]=out.reduce((a,x)=>a+x[k],0);
      return json(res,200,{ano,meses:out,totals});
    }
    return json(res,404,{error:'Rota não encontrada'});
  } catch(e) { console.error(e); return json(res,500,{error:e.message}); }
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.ico':'image/x-icon','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname.startsWith('/api/')) return api(req,res,url);
  const file=url.pathname==='/'?path.join(ROOT,'public','index.html'):path.join(ROOT,'public',url.pathname.replace(/^\/+/,''));
  if(!file.startsWith(path.join(ROOT,'public'))) return res.writeHead(403).end();
  fs.readFile(file,(err,data)=>{if(err)return res.writeHead(404).end('Not found');res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);});
});
server.listen(PORT,()=>console.log(`Consultório rodando em http://localhost:${PORT}`));
process.on('SIGINT',()=>{db.close();process.exit(0)});
