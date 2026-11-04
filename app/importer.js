// Importação da planilha de controle financeiro (Controle Sessões.xlsx).
// Cada aba de paciente tem a lista de sessões (Data | Valor | Observação) e, ao lado, a lista de pagamentos
// (rótulo "Pagamentos", depois Data | Valor). A aba inicial (resumo) é ignorada.
const { readXlsx, colNum } = require('./xlsx');

const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function money(cell) {
  if (!cell) return null;
  if (cell.t === 'n') return cell.v;
  if (cell.t === 's') { // "R$ 1.250,50"
    const s = cell.v.replace(/[^\d,.-]/g, ''); if (!/\d/.test(s)) return null;
    const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : null;
  }
  return null;
}
function dateOf(cell) {
  if (!cell) return null;
  if (cell.t === 'd') return cell.v;
  if (cell.t === 's') { const m = cell.v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
}

// Lê uma aba de paciente. Devolve {sessions, payments, ignored, problems}.
function parsePatientSheet(sh) {
  const cell = (c, r) => sh.cells.get(c + r);
  const text = (c, r) => { const x = cell(c, r); return x && x.t === 's' ? x.v.trim() : ''; };
  const out = { sessions: [], payments: [], ignored: 0, problems: [] };
  // cabeçalho das sessões: Data | Valor na linha 1..12
  let hdr = 0; for (let r = 1; r <= 12 && !hdr; r++) if (norm(text('A', r)) === 'data' && norm(text('B', r)) === 'valor') hdr = r;
  if (!hdr) { out.problems.push({ row: 0, msg: 'Cabeçalho "Data | Valor" das sessões não encontrado' }); }
  // bloco de pagamentos: rótulo "Pagamentos" nas colunas D..H
  let pc = null, pHdr = 0;
  for (let r = 1; r <= sh.maxRow && !pc; r++) for (const c of 'DEFGH') if (norm(text(c, r)).startsWith('pagamentos')) { pc = c; pHdr = r; break; }
  if (pc) { for (let r = pHdr; r <= pHdr + 3; r++) if (norm(text(pc, r)) === 'data') { pHdr = r; break; } }
  else for (let r = 1; r <= 12 && !pc; r++) if (norm(text('E', r)) === 'data' && norm(text('F', r)) === 'valor') { pc = 'E'; pHdr = r; }
  const pv = pc && COLS[COLS.indexOf(pc) + 1], po = pc && COLS[COLS.indexOf(pc) + 2];
  if (hdr) for (let r = hdr + 1; r <= sh.maxRow; r++) {
    const dc = cell('A', r), vc = cell('B', r); if (!dc && !vc) continue;
    const date = dateOf(dc), value = money(vc), obs = text('C', r);
    if (!date) { if (dc && dc.t === 's' && /^(pagamentos|total|valor|data)/i.test(norm(dc.v))) continue; out.problems.push({ row: r, kind: 'sessao', msg: 'Data inválida', date: dc && String(dc.v), value, obs }); continue; }
    if (value === null) { out.ignored++; continue; } // data sem valor (ainda não preenchida)
    out.sessions.push({ row: r, date, value, obs });
  }
  if (pc) for (let r = pHdr + 1; r <= sh.maxRow; r++) {
    const dc = cell(pc, r), vc = cell(pv, r); if (!dc && !vc) continue;
    const date = dateOf(dc), value = money(vc);
    if (!date) { if (dc && dc.t === 's') continue; out.problems.push({ row: r, kind: 'pagamento', msg: 'Data de pagamento inválida', date: dc && String(dc.v), value }); continue; }
    if (value === null) { out.ignored++; continue; }
    out.payments.push({ row: r, date, value, obs: text(po, r) });
  }
  return out;
}

// Classifica a sessão da planilha pelo valor e pela observação.
function classify(s) {
  if (!(s.value > 0)) {
    const o = norm(s.obs);
    // desmarcou = paciente; desmarquei, feriado, congresso etc. = a profissional não atendeu
    const kind = !o ? 'vazio' : /desmarcou/.test(o) ? 'Desmarcou' : /d[e]s?marquei|feriad|congress|natal|ano novo|ferias|recesso|viage/.test(o) ? 'Desmarquei' : 'outro';
    return { billed: false, kind };
  }
  return { billed: true, status: /falt|sem anteced/i.test(s.obs) ? 'Faltou' : 'Realizada' };
}

function parseWorkbook(buf) {
  const sheets = readXlsx(buf);
  const patients = [];
  const skippedSheets = [];
  for (const sh of sheets.slice(1)) {
    if (/^\d{4}$/.test(sh.name.trim())) { skippedSheets.push(sh.name.trim()); continue; } // resumos por ano
    const p = parsePatientSheet(sh);
    patients.push({ sheet: sh.name.trim(), hidden: sh.hidden, ...p });
  }
  // saldos exibidos no resumo (aba inicial): nome | saldo
  const summary = new Map(); const first = sheets[0];
  if (first) for (let r = 1; r <= Math.min(first.maxRow, 200); r++) { const n = first.cells.get('B' + r), v = first.cells.get('C' + r); if (n && n.t === 's' && v && v.t === 'n') summary.set(norm(n.v), v.v); }
  return { patients, summary, firstSheet: first, skippedSheets };
}



// ---------------------------------------------------------------------------------------------
// Comparação com o banco do programa e aplicação
// ---------------------------------------------------------------------------------------------
const cents = v => Math.round(Number(v) * 100);
const round2 = v => Math.round(v * 100) / 100;
const isIso = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const groupDates = arr => { const m = new Map(); for (const x of arr) { if (!m.has(x.date)) m.set(x.date, []); m.get(x.date).push(x); } return m; };

// Compara os itens da planilha com os do programa (mesmo paciente), dia a dia.
// 1) pares com mesmo valor ficam como estão; 2) sobras do mesmo dia com valor diferente viram correção de valor;
// 3) o que só está na planilha é incluído; 4) o que só está no programa (dentro da janela) é "extra".
function reconcile(sheetItems, progItems, win) {
  const prog = progItems.filter(x => x.date >= win.from && x.date <= win.to);
  const S = groupDates(sheetItems), P = groupDates(prog);
  const ops = { ins: [], upd: [], del: [] };
  for (const date of new Set([...S.keys(), ...P.keys()])) {
    const ss = (S.get(date) || []).slice(), pp = (P.get(date) || []).slice();
    for (let i = ss.length - 1; i >= 0; i--) { const j = pp.findIndex(p => cents(p.value) === cents(ss[i].value)); if (j >= 0) { pp.splice(j, 1); ss.splice(i, 1); } }
    while (ss.length && pp.length) { const a = ss.shift(), b = pp.shift(); ops.upd.push({ id: b.id, date, from: b.value, to: a.value }); }
    for (const a of ss) ops.ins.push(a);
    for (const b of pp) ops.del.push(b);
  }
  return ops;
}

function suggestPatient(sheetName, dbPatients) {
  const k = norm(sheetName), exact = dbPatients.filter(p => norm(p.name) === k);
  if (exact.length === 1) return exact[0];
  const tk = k.split(' ').filter(Boolean);
  const sub = dbPatients.filter(p => { const pk = norm(p.name).split(' ').filter(Boolean); const [a, b] = tk.length <= pk.length ? [tk, pk] : [pk, tk]; return a.length >= 2 && a.every(t => b.includes(t)); });
  return sub.length === 1 ? sub[0] : null;
}

// settings: { map: {nomeDaAba: idDoPaciente | 'novo' | 'ignorar'}, removerExtras: bool, corrigir: {"aba|linha|tipo": 'AAAA-MM-DD'} }
const parsedZeroEmpty = sheets => sheets.reduce((a, s) => a + s.zeros.filter(z => z.vazio).length, 0);
function buildPlan(parsed, db, settings = {}, today = new Date().toISOString().slice(0, 10)) {
  const removerExtras = settings.removerExtras !== false, map = settings.map || {}, fixes = settings.corrigir || {};
  const maxYear = Number(today.slice(0, 4)) + 1, valid = d => isIso(d) && d >= '2020-01-01' && d <= maxYear + '-12-31';
  const dbPatients = db.prepare('SELECT id, name, active FROM patients ORDER BY name').all();
  const byId = new Map(dbPatients.map(p => [p.id, p]));
  const sheets = [], problemas = [];
  for (const p of parsed.patients) {
    const billed = [], zeros = [], pays = [];
    const addProblem = (kind, row, date, value, obs) => {
      const key = `${p.sheet}|${row}|${kind}`, fix = fixes[key];
      problemas.push({ chave: key, aba: p.sheet, linha: row, tipo: kind, data: date, valor: value, obs: obs || '', correcao: fix || '' });
      return valid(fix) ? fix : null;
    };
    for (const s of p.sessions) {
      const c = classify(s);
      if (!c.billed) { if (valid(s.date)) zeros.push({ date: s.date, kind: c.kind === 'vazio' ? (settings.zeroSemObservacao || 'nao') : c.kind, obs: s.obs, vazio: c.kind === 'vazio' }); continue; }
      if (valid(s.date)) billed.push({ date: s.date, value: s.value, status: c.status, obs: s.obs });
      else { const d = addProblem('sessao', s.row, s.date, s.value, s.obs); if (d) billed.push({ date: d, value: s.value, status: c.status, obs: s.obs }); }
    }
    for (const x of p.payments) {
      if (valid(x.date)) pays.push({ date: x.date, value: x.value, obs: x.obs });
      else { const d = addProblem('pagamento', x.row, x.date, x.value, x.obs); if (d) pays.push({ date: d, value: x.value, obs: x.obs }); }
    }
    for (const pr of p.problems) if (pr.row && pr.value > 0) { const d = addProblem(pr.kind, pr.row, pr.date, pr.value, pr.obs); if (d) (pr.kind === 'pagamento' ? pays : billed).push({ date: d, value: pr.value, status: classify({ value: pr.value, obs: pr.obs || '' }).status, obs: pr.obs || '' }); }
    sheets.push({ sheet: p.sheet, hidden: p.hidden, billed, zeros, pays });
  }
  // janela de comparação: do primeiro ao último dia com lançamentos válidos na planilha
  const all = sheets.flatMap(s => [...s.billed, ...s.pays]).map(x => x.date).sort();
  const win = { from: all[0] || today, to: all.length && all[all.length - 1] > today ? all[all.length - 1] : today };
  const pacientes = [], semCorrespondencia = [];
  const totals = { historicoIncluir: 0, sessoesIncluir: 0, valorIncluir: 0, sessoesCorrigir: 0, sessoesRemover: 0, valorRemover: 0, pagIncluir: 0, valorPagIncluir: 0, pagCorrigir: 0, pagRemover: 0, valorPagRemover: 0 };
  for (const sh of sheets) {
    if (!sh.billed.length && !sh.pays.length) continue;
    let target = map[sh.sheet], how = 'manual';
    if (target === undefined) { const sug = suggestPatient(sh.sheet, dbPatients); target = sug ? sug.id : null; how = 'auto'; }
    const summaryBalance = parsed.summary.get(norm(sh.sheet));
    const sheetSaldo = round2(sh.billed.reduce((a, x) => a + x.value, 0) - sh.pays.reduce((a, x) => a + x.value, 0));
    if (target === 'ignorar' || target == null || (target !== 'novo' && !byId.has(Number(target)))) {
      semCorrespondencia.push({ aba: sh.sheet, oculta: sh.hidden, sessoes: sh.billed.length, pagamentos: sh.pays.length, saldo: sheetSaldo, escolha: target === 'ignorar' ? 'ignorar' : '' });
      continue;
    }
    const isNew = target === 'novo', pid = isNew ? null : Number(target);
    const pSess = isNew ? [] : db.prepare("SELECT id, session_date AS date, value, status, notes FROM sessions WHERE patient_id=? AND status IN ('Realizada','Faltou')").all(pid);
    const pPay = isNew ? [] : db.prepare('SELECT id, payment_date AS date, amount AS value, notes FROM payments WHERE patient_id=?').all(pid);
    const sOps = reconcile(sh.billed, pSess, win), pOps = reconcile(sh.pays, pPay, win);
    // sessões do programa que ainda não são cobradas (Agendada/Desmarcou/Desmarquei) até hoje, dentro da janela
    const pOpen = isNew ? [] : db.prepare("SELECT id, session_date AS date, status FROM sessions WHERE patient_id=? AND session_date BETWEEN ? AND ? AND status IN ('Agendada','Desmarcou','Desmarquei')").all(pid, win.from, today);
    const take = (date, statuses) => { const i = pOpen.findIndex(x => x.date === date && statuses.includes(x.status)); return i < 0 ? null : pOpen.splice(i, 1)[0]; };
    const fee = isNew ? 0 : (db.prepare('SELECT fee FROM patients WHERE id=?').get(pid).fee || 0);
    const valorPadrao = (() => { const c = {}; for (const x of sh.billed) c[x.value] = (c[x.value] || 0) + 1; return Number(Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || 0); })();
    // sessão cobrada na planilha e só "Agendada" no programa: aproveita a sessão existente (mantém o horário)
    const sessAdopt = [], sessIns = [];
    for (const x of sOps.ins) { const ag = take(x.date, ['Agendada']); (ag ? sessAdopt.push({ id: ag.id, ...x }) : sessIns.push(x)); }
    // sobras do programa (cobradas e ausentes na planilha): viram Desmarcou/Desmarquei se a planilha tem a data com valor zero; senão são removidas
    const zeroPool = sh.zeros.filter(z => z.kind !== 'nao' && z.kind !== 'outro').map(z => ({ ...z, used: false }));
    const sessConvert = [], sessDelete = [];
    if (removerExtras) for (const x of sOps.del) { const z = zeroPool.find(q => !q.used && q.date === x.date); if (z) { z.used = true; sessConvert.push({ ...x, para: z.kind }); } else sessDelete.push(x); }
    // histórico de valor zero
    const histIns = [], histUpd = [];
    for (const z of zeroPool) {
      if (z.used) continue;
      const same = take(z.date, [z.kind]); if (same) continue; // já existe igual
      const other = take(z.date, ['Desmarcou', 'Desmarquei', 'Agendada']);
      if (other) histUpd.push({ id: other.id, date: z.date, para: z.kind });
      else histIns.push({ date: z.date, status: z.kind, value: fee || valorPadrao, obs: z.obs || '' });
    }
    const payDelete = removerExtras ? pOps.del : [];
    const before = round2(pSess.reduce((a, x) => a + x.value, 0) - pPay.reduce((a, x) => a + x.value, 0));
    const after = round2(before + sOps.ins.reduce((a, x) => a + x.value, 0) + sOps.upd.reduce((a, x) => a + x.to - x.from, 0) - [...sessConvert, ...sessDelete].reduce((a, x) => a + x.value, 0)
      - pOps.ins.reduce((a, x) => a + x.value, 0) - pOps.upd.reduce((a, x) => a + x.to - x.from, 0) + payDelete.reduce((a, x) => a + x.value, 0));
    const agendadasPassadas = pOpen.filter(x => x.status === 'Agendada').map(x => x.date); // sessões passadas que continuam 'Agendada' (sem registro na planilha)
    const ref = summaryBalance !== undefined ? summaryBalance : sheetSaldo;
    const ops = { sessIns, sessAdopt, sessUpd: sOps.upd, sessConv: sessConvert, sessDel: sessDelete, histIns, histUpd, payIns: pOps.ins, payUpd: pOps.upd, payDel: payDelete };
    const changes = Object.values(ops).reduce((a, l) => a + l.length, 0);
    totals.sessoesIncluir += sOps.ins.length; totals.valorIncluir += sOps.ins.reduce((a, x) => a + x.value, 0); totals.historicoIncluir += histIns.length + histUpd.length;
    totals.sessoesCorrigir += ops.sessUpd.length; totals.sessoesRemover += ops.sessConv.length + ops.sessDel.length; totals.valorRemover += [...ops.sessConv, ...ops.sessDel].reduce((a, x) => a + x.value, 0);
    totals.pagIncluir += ops.payIns.length; totals.valorPagIncluir += ops.payIns.reduce((a, x) => a + x.value, 0); totals.pagCorrigir += ops.payUpd.length; totals.pagRemover += ops.payDel.length; totals.valorPagRemover += ops.payDel.reduce((a, x) => a + x.value, 0);
    pacientes.push({ aba: sh.sheet, oculta: sh.hidden, pacienteId: pid, novo: isNew, nome: isNew ? sh.sheet : byId.get(pid).name, como: how, sessoesPlanilha: sh.billed.length, pagamentosPlanilha: sh.pays.length,
      saldoPlanilha: round2(ref), saldoAntes: before, saldoDepois: after, confere: Math.abs(after - ref) < 0.01, mudancas: changes, ops,
      valorPadrao, semObservacao: sh.zeros.filter(z => z.vazio).length, agendadasPassadas });
  }
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  const naoNaPlanilha = dbPatients.filter(p => !pacientes.some(x => x.pacienteId === p.id)).map(p => ({ id: p.id, nome: p.name }));
  return { janela: win, totais: totals, pacientes, semCorrespondencia, problemas, naoNaPlanilha, abasIgnoradas: parsed.skippedSheets,
    opcoes: { removerExtras, zeroSemObservacao: settings.zeroSemObservacao || 'nao' }, zeroSemObservacao: parsedZeroEmpty(sheets), pacientesDoPrograma: dbPatients.map(p => ({ id: p.id, nome: p.name, ativo: !!p.active })),
    resumo: { abas: parsed.patients.length, sessoes: sheets.reduce((a, s) => a + s.billed.length, 0), valorSessoes: round2(sheets.reduce((a, s) => a + s.billed.reduce((b, x) => b + x.value, 0), 0)), pagamentos: sheets.reduce((a, s) => a + s.pays.length, 0), valorPagamentos: round2(sheets.reduce((a, s) => a + s.pays.reduce((b, x) => b + x.value, 0), 0)) } };
}

// Aplica o plano numa única transação. `insertSession` vem do servidor.
function applyPlan(db, plan, now = new Date().toISOString()) {
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const r = { historicoIncluido: 0, sessoesIncluidas: 0, sessoesCorrigidas: 0, sessoesConvertidas: 0, sessoesRemovidas: 0, pagamentosIncluidos: 0, pagamentosCorrigidos: 0, pagamentosRemovidos: 0, pacientesCriados: 0 };
  db.exec('BEGIN');
  try {
    for (const p of plan.pacientes) {
      let pid = p.pacienteId;
      if (p.novo) { pid = Number(run('INSERT INTO patients (name, fee, active, notes) VALUES (?,?,?,?)', p.nome, p.valorPadrao || 0, p.oculta ? 0 : 1, 'Criado pela importação da planilha').lastInsertRowid); p.pacienteId = pid; r.pacientesCriados++; }
      for (const x of p.ops.sessIns) { run('INSERT INTO sessions (patient_id,session_date,session_time,status,value,notes,slot_removed,created_at) VALUES (?,?,NULL,?,?,?,0,?)', pid, x.date, x.status, x.value, x.obs || null, now); r.sessoesIncluidas++; }
      for (const x of p.ops.sessAdopt) { run('UPDATE sessions SET status=?, value=?, slot_removed=0, billable_override=NULL, notes=COALESCE(NULLIF(?,\'\'),notes) WHERE id=?', x.status, x.value, x.obs || '', x.id); r.sessoesIncluidas++; }
      for (const x of p.ops.histIns) { run('INSERT INTO sessions (patient_id,session_date,session_time,status,value,notes,slot_removed,billable_override,created_at) VALUES (?,?,NULL,?,?,?,0,0,?)', pid, x.date, x.status, x.value, x.obs || null, now); r.historicoIncluido++; }
      for (const x of p.ops.histUpd) { run('UPDATE sessions SET status=?, billable_override=0, slot_removed=0 WHERE id=?', x.para, x.id); r.historicoIncluido++; }
      for (const x of p.ops.sessUpd) { run('UPDATE sessions SET value=? WHERE id=?', x.to, x.id); r.sessoesCorrigidas++; }
      for (const x of p.ops.sessConv) { run('UPDATE sessions SET status=?, billable_override=0 WHERE id=?', x.para, x.id); r.sessoesConvertidas++; }
      for (const x of p.ops.sessDel) { run('DELETE FROM sessions WHERE id=?', x.id); r.sessoesRemovidas++; }
      for (const x of p.ops.payIns) { run('INSERT INTO payments (patient_id,payment_date,amount,notes) VALUES (?,?,?,?)', pid, x.date, x.value, x.obs || null); r.pagamentosIncluidos++; }
      for (const x of p.ops.payUpd) { run('UPDATE payments SET amount=? WHERE id=?', x.to, x.id); r.pagamentosCorrigidos++; }
      for (const x of p.ops.payDel) { run('DELETE FROM payments WHERE id=?', x.id); r.pagamentosRemovidos++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // conferência: saldo real no banco x saldo esperado da planilha
  const conferencia = plan.pacientes.map(p => {
    const d = db.prepare("SELECT COALESCE((SELECT SUM(value) FROM sessions WHERE patient_id=? AND status IN ('Realizada','Faltou')),0) - COALESCE((SELECT SUM(amount) FROM payments WHERE patient_id=?),0) AS saldo").get(p.pacienteId, p.pacienteId).saldo;
    return { aba: p.aba, nome: p.nome, saldoPrograma: round2(d), saldoPlanilha: p.saldoPlanilha, confere: Math.abs(d - p.saldoPlanilha) < 0.01 };
  });
  return { ...r, conferencia };
}

module.exports = { parseWorkbook, parsePatientSheet, classify, norm, buildPlan, applyPlan, reconcile };
