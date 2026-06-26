import xlsx from 'xlsx';
import mammoth from 'mammoth';

const MAX_CHARS = 20000; // cap extracted text per document

function clamp(text) {
  const t = (text || '').trim();
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + '\n[...truncated...]' : t;
}

// Extract plain text from an uploaded file (base64). Supports PDF, Excel, Word,
// CSV/TSV, and plain text. Never throws — returns a note on failure.
export async function extractText({ name = 'file', media_type = '', data }) {
  const buf = Buffer.from(data, 'base64');
  const ext = (name.split('.').pop() || '').toLowerCase();
  const mt = media_type.toLowerCase();
  try {
    if (ext === 'pdf' || mt.includes('pdf')) {
      // Import the lib file directly to avoid pdf-parse's debug-on-require path.
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const r = await pdfParse(buf);
      return clamp(r.text);
    }
    if (['xlsx', 'xls', 'xlsm'].includes(ext) || mt.includes('sheet') || mt.includes('excel')) {
      const wb = xlsx.read(buf, { type: 'buffer' });
      return clamp(
        wb.SheetNames.map((n) => `# Sheet: ${n}\n${xlsx.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n')
      );
    }
    if (ext === 'docx' || mt.includes('wordprocessingml') || mt.includes('msword')) {
      const r = await mammoth.extractRawText({ buffer: buf });
      return clamp(r.value);
    }
    // csv / tsv / txt / md / json / etc.
    return clamp(buf.toString('utf8'));
  } catch (e) {
    return `[Could not extract "${name}": ${e.message}]`;
  }
}

// Is this an image we should send via vision (vs. extract as text)?
export function isImage(media_type = '', name = '') {
  return /^image\//.test(media_type) || /\.(png|jpe?g|gif|webp)$/i.test(name);
}
