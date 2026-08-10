// Extração de texto de PDF e DOCX — 100% client-side, sem dependências externas.
// O arquivo NUNCA é enviado: só o texto extraído vai para a API de análise.
(function () {
  "use strict";

  // ── PDF ─────────────────────────────────────────────────────────
  // Extrator leve: encontra streams FlateDecode, infla com DecompressionStream
  // e extrai os operadores de texto (Tj/TJ). Cobre a maioria dos PDFs gerados
  // por Word/Google Docs/exportadores. PDF escaneado (imagem) → texto vazio.

  const CP1252 = (function () {
    // Mapeia bytes 0x80-0x9F para Unicode (WinAnsi) — comum em PDFs.
    const hi = "\u20AC\uFFFD\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\uFFFD\u017D\uFFFD\uFFFD\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\uFFFD\u017E\u0178";
    const map = {};
    for (let i = 0; i < 32; i++) map[0x80 + i] = hi[i] !== "\uFFFD" ? hi[i] : String.fromCharCode(0x80 + i);
    return map;
  })();

  function inflate(bytes) {
    return new Promise((resolve, reject) => {
      try {
        const ds = new DecompressionStream("deflate");
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        new Response(stream).arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject);
      } catch (e) { reject(e); }
    });
  }

  function decodePdfString(raw) {
    // raw é o conteúdo entre parênteses ou <...>, sem delimitadores.
    let out = "";
    if (raw.startsWith("<")) {
      const hex = raw.slice(1, -1).replace(/\s+/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const b = parseInt(hex.slice(i, i + 2), 16);
        out += b >= 0x20 && b < 0x80 ? String.fromCharCode(b) : (CP1252[b] || "\uFFFD");
      }
      return out;
    }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "\\") {
        const n = raw[i + 1];
        if (n === "n") { out += "\n"; i++; }
        else if (n === "r") { out += "\r"; i++; }
        else if (n === "t") { out += "\t"; i++; }
        else if (n === "b") { out += "\b"; i++; }
        else if (n === "f") { out += "\f"; i++; }
        else if (n === "(" || n === ")" || n === "\\") { out += n; i++; }
        else if (n >= "0" && n <= "7") {
          const oct = raw.slice(i + 1, i + 4);
          out += String.fromCharCode(parseInt(oct, 8));
          i += oct.length;
        } else { out += n; i++; }
      } else if (c === "\r" || c === "\n") {
        // ignora quebras dentro do literal
      } else {
        const b = c.charCodeAt(0);
        out += b >= 0x20 && b < 0x80 ? c : (CP1252[b] || "\uFFFD");
      }
    }
    return out;
  }

  function extractTextFromStream(streamBytes) {
    // Operadores de texto: (str) Tj  e  [(a)(b)] TJ
    const text = new TextDecoder("latin1").decode(streamBytes);
    let out = "";
    let i = 0;
    const len = text.length;
    while (i < len) {
      const c = text[i];
      if (c === "(") {
        // literal com escapes — copia até o fechamento não escapado
        let j = i + 1, depth = 1, lit = "";
        while (j < len && depth > 0) {
          if (text[j] === "\\") { lit += text[j] + (text[j + 1] || ""); j += 2; continue; }
          if (text[j] === "(") depth++;
          if (text[j] === ")") { depth--; if (depth === 0) break; }
          lit += text[j];
          j++;
        }
        out += decodePdfString(lit);
        i = j + 1;
      } else if (c === "<") {
        let j = i + 1;
        while (j < len && text[j] !== ">") j++;
        // hex string: só conta se seguido de operador de texto
        const after = text.slice(j + 1, j + 4).trim();
        if (/^(Tj|TJ)/.test(after)) {
          out += decodePdfString(text.slice(i, j + 1));
        }
        i = j + 1;
      } else if (/[TdTD]/.test(c) && /^[TdTD]\*?/.test(text.slice(i, i + 3))) {
        // Td / TD / T* → nova linha
        if (c === "T" && (text[i + 1] === "d" || text[i + 1] === "D" || text[i + 1] === "*")) {
          out += "\n";
        }
        i++;
      } else {
        i++;
      }
    }
    // normaliza: junta linhas curtas demais (fragmentos da mesma linha)
    return out;
  }

  async function extractPdfText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const results = [];
    const decoder = new TextDecoder("latin1");
    const pdf = decoder.decode(bytes);
    // acha todos os streams
    const re = /stream\r?\n/g;
    let m;
    const streamStarts = [];
    while ((m = re.exec(pdf)) !== null) streamStarts.push(m.index + m[0].length);
    for (const start of streamStarts) {
      // o stream termina em "endstream" — o byte antes é \n (e possivelmente \r)
      let end = pdf.indexOf("endstream", start);
      if (end === -1) continue;
      let dataEnd = end;
      if (bytes[dataEnd - 1] === 10) dataEnd--;        // \n
      if (bytes[dataEnd - 1] === 13) dataEnd--;        // \r
      const slice = bytes.slice(start, dataEnd);
      // tenta inflar (FlateDecode); se falhar, usa cru
      let inflated;
      try { inflated = await inflate(slice); }
      catch { continue; }
      // Filtro de lixo binário: fontes embutidas/imagens inflam para binário
      // (alta proporção de bytes não-ASCII). Streams de conteúdo são ~ASCII.
      let highBytes = 0;
      const sample = Math.min(inflated.length, 4096);
      for (let b = 0; b < sample; b++) if (inflated[b] > 127) highBytes++;
      if (sample > 0 && highBytes / sample > 0.25) continue;
      const content = extractTextFromStream(inflated);
      if (content.trim().length > 0) results.push(content);
    }
    const joined = results.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return joined;
  }

  // Checagem de legibilidade: rejeita "texto" que na verdade é lixo do PDF
  // (definições de objeto, fontes decodificadas por acaso etc.).
  function isReadable(text) {
    if (!text || text.length < 40) return false;
    // linhas com internals do PDF não são conteúdo real
    const cleaned = text.split("\n")
      .filter(line => !/\/Type|\/Font|\/Length|\/Filter|endobj|^%PDF|xref|stream$|^\/[A-Za-z]/.test(line))
      .join("\n");
    if (cleaned.trim().length < 40) return false;
    const letters = (cleaned.match(/[a-zA-Z0-9À-ÿ]/g) || []).length;
    return letters / cleaned.length > 0.6;
  }

  // ── PDF (motor completo — pdf.js) ───────────────────────────────
  // Segunda camada: se o extrator leve falhar ou devolver lixo, carrega o
  // pdf.js (self-hosted, mesmo motor do Firefox) e extrai com ele. Só baixa
  // os ~1MB quando um PDF realmente precisa. Sem CDN: nada para antivírus bloquear.
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        const pdfjs = await import("/vendor/pdfjs/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        return pdfjs;
      })();
    }
    return pdfjsPromise;
  }

  async function extractPdfTextFull(arrayBuffer) {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
    const doc = await loadingTask.promise;
    const lines = [];
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        let lastY = null;
        let line = [];
        for (const item of tc.items) {
          const s = item.str || "";
          if (!s) continue;
          const y = item.transform ? item.transform[5] : 0;
          if (lastY !== null && Math.abs(y - lastY) > 2) {
            if (line.length) lines.push(line.join(" "));
            line = [];
          }
          line.push(s);
          lastY = y;
        }
        if (line.length) lines.push(line.join(" "));
      }
    } finally {
      // No build legacy, o cleanup é no loadingTask (doc.destroy não existe).
      await loadingTask.destroy().catch(() => {});
    }
    return lines.join("\n");
  }

  // ── DOCX ────────────────────────────────────────────────────────
  function extractDocxText(arrayBuffer) {
    const zip = fflate.unzipSync(new Uint8Array(arrayBuffer));
    const xml = new TextDecoder().decode(zip["word/document.xml"]);
    // parágrafos → linhas; tabs → \t
    const body = xml.replace(/<w:p[ >]/g, "\n<w:p>").replace(/<w:tab\/>/g, "\t");
    const text = body.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── Dispatch ────────────────────────────────────────────────────
  window.extractFileText = async function (file) {
    const name = (file.name || "").toLowerCase();
    const buf = await file.arrayBuffer();
    let text;
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      // 1) extrator leve (rápido, sem download extra)
      text = await extractPdfText(buf);
      // 2) se o resultado não for legível, tenta o motor completo (pdf.js)
      if (!isReadable(text)) {
        try {
          text = await extractPdfTextFull(buf);
        } catch {
          text = "";
        }
      }
    } else if (name.endsWith(".docx") || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      text = extractDocxText(buf);
    } else {
      throw new Error(window.t ? window.t("extract.unsupported") : "Formato não suportado. Envie PDF ou DOCX.");
    }
    if (!isReadable(text)) {
      throw new Error(window.t ? window.t("extract.fail") : "Não conseguimos extrair o texto deste arquivo (pode ser escaneado ou ter um formato complexo). Cole o texto do currículo abaixo.");
    }
    return text;
  };
})();
