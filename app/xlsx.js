// Leitor mínimo de .xlsx (sem dependências): zip + XML. Lê valores em cache (não calcula fórmulas).
const zlib = require('zlib');

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Arquivo não é um .xlsx válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Arquivo .xlsx corrompido');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commLen;
  }
  return name => {
    const f = files.get(name); if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const raw = buf.subarray(start, start + f.csize);
    return (f.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 200 * 1024 * 1024 })).toString('utf8');
  };
}

const unesc = s => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]);
const attr = (tag, name) => { const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"')); return m ? unesc(m[1]) : null; };
const colNum = c => c.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);

function isDateFormat(id, codes) {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
  const code = codes.get(id); if (!code) return false;
  return /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
}

function serialToIso(serial, date1904) {
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// Retorna [{name, hidden, cells: Map('A3' -> {v, t}), maxRow}] onde t = 'n' | 's' | 'd' (data ISO) | 'b' | 'e'
function readXlsx(buf) {
  const get = readZip(buf);
  const wb = get('xl/workbook.xml'); if (!wb) throw new Error('Arquivo não é uma planilha do Excel (.xlsx)');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(wb);
  const rels = new Map(); for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const strings = []; for (const m of (get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) strings.push(unesc([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const styles = get('xl/styles.xml') || '';
  const codes = new Map(); for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) codes.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
  const xfBlock = (styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const dateStyle = [...xfBlock.matchAll(/<xf\b[^>]*>/g)].map(m => isDateFormat(Number(attr(m[0], 'numFmtId') || 0), codes));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')); if (!target) continue;
    const xml = get('xl/' + target.replace(/^\/?(xl\/)?/, '')); if (!xml) continue;
    const cells = new Map(); let maxRow = 0;
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r'), t = attr(c[1], 't'), s = Number(attr(c[1], 's') || 0), body = c[2] || '';
      const vm = body.match(/<v>([\s\S]*?)<\/v>/); let cell = null;
      if (t === 'inlineStr') cell = { v: unesc([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')), t: 's' };
      else if (!vm) continue;
      else if (t === 's') cell = { v: strings[Number(vm[1])] ?? '', t: 's' };
      else if (t === 'str') cell = { v: unesc(vm[1]), t: 's' };
      else if (t === 'b') cell = { v: vm[1] === '1', t: 'b' };
      else if (t === 'e') cell = { v: unesc(vm[1]), t: 'e' };
      else { const num = Number(vm[1]); cell = Number.isFinite(num) ? (dateStyle[s] ? { v: serialToIso(num, date1904), t: 'd' } : { v: num, t: 'n' }) : null; }
      if (!cell || cell.v === '') continue;
      cells.set(ref, cell); maxRow = Math.max(maxRow, Number(ref.replace(/\D/g, '')));
    }
    sheets.push({ name: attr(m[0], 'name'), hidden: (attr(m[0], 'state') || 'visible') !== 'visible', cells, maxRow });
  }
  return sheets;
}

module.exports = { readXlsx, colNum };
