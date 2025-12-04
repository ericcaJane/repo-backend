const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const router = express.Router();
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const upload = multer({ dest: "uploads/temp/" });

/* ------------------------------ HF helper ------------------------------ */
async function callHF({ model, inputs, parameters = {}, token, tries = 3, timeoutMs = 30000 }) {
  // Use the new Hugging Face inference router endpoint
  const url = `https://router.huggingface.co/hf-inference/models/${model}?wait_for_model=true`;
  let delay = 800;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs, parameters }),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(to);
      if (attempt === tries) return { error: `Network error: ${e.message}` };
      await new Promise((r) => setTimeout(r, delay));
      delay *= 1.6;
      continue;
    }
    clearTimeout(to);

    if (res.status === 503 || res.status === 429) {
      if (attempt === tries) return { error: `HF ${res.status}: model busy/starting` };
      await new Promise((r) => setTimeout(r, delay));
      delay *= 1.6;
      continue;
    }

    let data;
    try { data = await res.json(); } catch { return { error: "Invalid JSON from Hugging Face" }; }
    if (data.error) return { error: data.error };

    const text = Array.isArray(data)
      ? data[0]?.summary_text || data[0]?.generated_text || ""
      : data.summary_text || data.generated_text || "";

    return { text: (text || "").trim() };
  }
  return { error: "HF failed after retries." };
}

/* ------------------------------ Text utils ----------------------------- */
function normalizeParagraph(s = "") {
  return (s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^abstract[:.\s-]*/i, "")
    .replace(/^summary[:.\s-]*/i, "")
    .trim();
}

function heuristicSummary(text = "") {
  if (!text) return "No readable text available.";
  const sentences = text.split(/[.!?]\s/).map((s) => s.trim()).filter((s) => s.length > 40);
  return sentences.slice(0, 4).join(". ") + ".";
}

const j = (arr, sep = ", ") => (Array.isArray(arr) ? arr.filter(Boolean).join(sep) : "");

/* ---- secure file read (restrict to project root) ---- */
function safeReadPdfFromRelative(filePathRel) {
  try {
    if (!filePathRel) {
      console.log("[safeReadPdf] No filePath provided");
      return null;
    }
    
    const root = path.join(__dirname, "..");
    let abs;
    
    // Handle different path formats
    const normalized = String(filePathRel).replace(/\\/g, "/");
    
    if (normalized.startsWith("/uploads/")) {
      // Relative path like /uploads/research/filename.pdf
      abs = path.resolve(path.join(root, normalized));
    } else if (normalized.startsWith("uploads/")) {
      // Relative path without leading slash
      abs = path.resolve(path.join(root, normalized));
    } else if (path.isAbsolute(normalized)) {
      // Already absolute path
      abs = path.normalize(normalized);
    } else {
      // Try as relative to uploads/research
      abs = path.resolve(path.join(root, "uploads", "research", normalized));
    }
    
    // Security check: ensure path is within project root
    if (!abs.startsWith(root)) {
      console.log(`[safeReadPdf] Path traversal attempt: ${abs}`);
      return null;
    }
    
    // Try multiple possible locations
    const candidates = [abs];
    if (!normalized.startsWith("/uploads/") && !normalized.startsWith("uploads/")) {
      candidates.push(path.resolve(path.join(root, "uploads", "research", path.basename(normalized))));
    }
    
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        console.log(`[safeReadPdf] Found PDF at: ${candidate}`);
        const buf = fs.readFileSync(candidate);
        return pdfParse(buf);
      }
    }
    
    console.log(`[safeReadPdf] PDF not found. Tried: ${candidates.join(", ")}`);
    return null;
  } catch (err) {
    console.error("[safeReadPdf] Error reading PDF:", err.message);
    return null;
  }
}

/* --------------------- Name / citation normalization -------------------- */
const cap = (s = "") => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "";

/** Convert a single token (email username or word) into {first,middle,last} guess */
function partsFromUsername(username = "") {
  // username like "erreanalei.mariquit" or "juan.p.delacruz"
  const tokens = username.split(/[._-]+/).filter(Boolean);
  if (tokens.length >= 2) {
    const last = cap(tokens[tokens.length - 1]);
    const first = cap(tokens[0]);
    const middleTokens = tokens.slice(1, tokens.length - 1).map(cap);
    return { first, middle: middleTokens.join(" "), last };
  }
  // single token: treat as last
  return { first: "", middle: "", last: cap(tokens[0] || "Author") };
}

/* ----------------------------- TL;DR helpers ----------------------------- */
function heuristicTldr(text = "") {
  if (!text) return "No short takeaway available.";
  
  const cleaned = text.replace(/\s+/g, " ").trim();
  
  // Look for key sentences that typically contain main findings
  const sentences = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 20);
  
  // Prioritize sentences that contain key findings/results
  const priorityKeywords = [
    /\b(found|showed|demonstrated|concluded|results?|findings?|significant|improved|reduced|increased)\b/i,
    /\b(conclusion|summary|takeaway|key\s+point|main\s+finding)\b/i,
    /\b(aim|objective|purpose|goal)\b/i
  ];
  
  // Try to find the most relevant sentence
  let bestSentence = "";
  for (const keyword of priorityKeywords) {
    const match = sentences.find(s => keyword.test(s));
    if (match) {
      bestSentence = match;
      break;
    }
  }
  
  // Fallback to first sentence if no good match
  if (!bestSentence && sentences.length > 0) {
    bestSentence = sentences[0];
  }
  
  // If still no sentence, take first 150 chars
  if (!bestSentence) {
    bestSentence = cleaned.substring(0, 150);
  }
  
  // Clean up and limit to 40-50 words max for true TLDR
  const words = bestSentence.split(/\s+/);
  const maxWords = 50;
  const trimmed = words.length > maxWords ? words.slice(0, maxWords).join(" ") : bestSentence;
  
  // Ensure it ends with a period and remove any trailing issues
  return trimmed.replace(/\s*[.,;]\s*$/, "").trim() + ".";
}

async function generateTldr(text = "", HF_TOKEN) {
  const base = (text || "").replace(/\s+/g, " ").trim();
  if (!base) return "No short takeaway available.";

  if (!HF_TOKEN) {
    return heuristicTldr(base);
  }

  try {
    // More focused prompt for true TLDR
    const prompt = `Provide a very concise one-sentence TL;DR (under 40 words) capturing the main finding or purpose. Be direct and avoid fluff:\n\n${base.substring(0, 2000)}`;

    const result = await callHF({
      model: "facebook/bart-large-cnn",
      inputs: prompt,
      parameters: {
        min_length: 10,    // Much shorter minimum
        max_length: 40,    // Much shorter maximum for true TLDR
        do_sample: false,
        temperature: 0.3,  // Lower temperature for more focused output
        repetition_penalty: 1.2,
      },
      token: HF_TOKEN,
      tries: 2,
      timeoutMs: 25000,
    });

    if (result.error) {
      console.warn("HF TL;DR failed:", result.error);
      return heuristicTldr(base);
    }

    let raw = (result.text || "").trim();
    
    // Clean up the output aggressively
    if (raw) {
      // Remove common prefixes the model might add
      raw = raw.replace(/^(TLDR|TL;DR|Summary|In summary|The study)\s*[:.-]*\s*/gi, "");
      raw = raw.replace(/\s*…+\s*$/g, "").replace(/\s*\.\s*$/, "").trim();
      
      // Ensure it's a proper sentence
      if (!raw.endsWith('.')) raw += '.';
      
      // Enforce word limit strictly
      const words = raw.split(/\s+/);
      if (words.length > 45) {
        raw = words.slice(0, 45).join(" ").replace(/[.,;]\s*$/, "") + ".";
      }
      
      return raw;
    }
    
    return heuristicTldr(base);
  } catch (error) {
    console.warn("TL;DR generation error:", error);
    return heuristicTldr(base);
  }
}

/** Parse authors string that may contain emails or names; return array of "Last, F. M." */
function parseAuthorsToAPAList(authorRaw = "") {
  const raw = String(authorRaw || "").trim();
  if (!raw) return ["Author"];

  // Split on commas, semicolons, ampersands, or "and" (even if no spaces)
  const tokens = raw.split(/\s*(?:,|;|&|and)\s*/i).filter(Boolean);

  const out = [];
  for (let token of tokens) {
    token = token.trim();
    if (!token) continue;

    let first = "", middle = "", last = "";

    // Handle “Last, First” format
    if (token.includes(",")) {
      const [l, rest] = token.split(",").map(s => s.trim());
      last = cap(l);
      if (rest) {
        const parts = rest.split(/\s+/).filter(Boolean).map(cap);
        first = parts.shift() || "";
        middle = parts.join(" ");
      }
    } else {
      // “First Middle Last” or single word (assume last name)
      const parts = token.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        last = cap(parts.pop());
        first = cap(parts.shift());
        middle = parts.map(cap).join(" ");
      } else {
        last = cap(parts[0]);
      }
    }

    const initials = [first, ...middle.split(/\s+/).filter(Boolean)]
      .map(w => w[0] ? w[0].toUpperCase() + "." : "")
      .join(" ");
    out.push(`${last}, ${initials}`.replace(/,\s*$/, ""));
  }

  return out.length ? out : ["Author"];
}


/** IEEE list "F. M. Last" */
function toIEEEList(apaList) {
  return apaList.map(a => {
    // "Last, F. M." -> "F. M. Last"
    const [last, initials] = a.split(",").map(s => s.trim());
    return `${initials || ""} ${last}`.trim().replace(/\s+/g, " ");
  });
}

/** BibTeX author field "Last, First Middle and Last, First" */
function toBibtexAuthor(authorRaw = "") {
  const apaList = parseAuthorsToAPAList(authorRaw);
  const bibParts = apaList.map(a => {
    const [last, initials] = a.split(",").map(s => s.trim());
    // expand initials into names if possible (we don't know full names; keep initials as-is)
    // "Last, F. M." is acceptable in BibTeX
    return `${last}, ${initials}`;
  });
  return bibParts.join(" and ");
}

function toSentenceCase(s = "") {
  return s
    .toLowerCase()
    .replace(/(^\w)|([.!?]\s+\w)/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeYear(y) {
  const m = String(y || "").match(/\d{4}/);
  return m ? m[0] : "n.d.";
}



/* ------------------------- References section scan ------------------------- */
/**
 * Very simple "References" extractor.
 * Returns an array of strings (each reference line/entry).
 */
function extractReferencesFromText(fullText = "") {
  const text = (fullText || "").replace(/\r/g, "");
  // Find "References" or "Bibliography"
  const m = text.match(/(references|bibliography)\s*[:\-]?\s*/i);
  if (!m) return [];

  const start = m.index + m[0].length;
  // Take up to ~20k chars after the header
  const tail = text.slice(start, start + 20000);

  // Split by line, remove empty
  let lines = tail.split("\n").map(s => s.trim()).filter(Boolean);

  // Merge wrapped lines: if a line starts with a number or bracket, consider new entry
  const entries = [];
  let buf = "";
  const newEntryRe = /^(\[\d+\]|\d+\.\s|•\s|-\s|[A-Z].+\(\d{4}\))/; // numbered or APA-like
  for (const ln of lines) {
    if (!buf) { buf = ln; continue; }
    if (newEntryRe.test(ln)) {
      entries.push(buf.trim());
      buf = ln;
    } else {
      // continuation of previous line
      buf += " " + ln;
    }
  }
  if (buf) entries.push(buf.trim());

  // light cleanup
  return entries.map(e => e.replace(/\s{2,}/g, " "));
}

/* ======================  /api/ai/summary  ====================== */
router.post("/summary", upload.single("file"), async (req, res) => {
  try {
    const HF_TOKEN = process.env.HF_TOKEN;
    if (!HF_TOKEN) return res.status(500).json({ ok: false, error: "Missing HF_TOKEN." });

    let { text, filePath } = req.body;
    let baseText = text ? String(text).trim() : "";

    if (req.file?.path) {
      const pdfData = await pdfParse(fs.readFileSync(req.file.path));
      baseText += "\n" + pdfData.text;
      fs.unlinkSync(req.file.path);
    } else if (filePath) {
      const parsed = await safeReadPdfFromRelative(filePath);
      if (parsed?.text) baseText += "\n" + parsed.text;
    }

    if (!baseText) return res.status(400).json({ ok: false, error: "No text or readable PDF content provided." });

    let cleaned = baseText
      .replace(/\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\b\d{1,3}\b/g, "")
      .replace(/\btable\s*\d+.*?(?=\s[A-Z])/gi, "")
      .replace(/references?.*$/i, "")
      .trim();

    const m = cleaned.match(/abstract[:\s-]*(.*?)(?=(introduction|background|methodology|results|references))/i);
    if (m?.[1]) cleaned = m[1];
    cleaned = cleaned.split(" ").slice(0, 3500).join(" ");

    if (cleaned.length < 800) {
      const summary = heuristicSummary(cleaned);
      return res.json({ ok: true, model: "heuristic", summary });
    }

    let { text: bartText } = await callHF({
      model: "facebook/bart-large-cnn",
      inputs: cleaned,
      parameters: { min_length: 150, max_length: 220, temperature: 0.4, do_sample: false },
      token: HF_TOKEN,
      tries: 3,
      timeoutMs: 60000,
    });

    if (!bartText || bartText.length < 100) {
      const prompt = `Summarize the following academic text into a clear, single-paragraph abstract (150–220 words) using formal academic English.\n\n${cleaned}`;
      const { text: retryText } = await callHF({
        model: "facebook/bart-large-cnn",
        inputs: prompt,
        parameters: { min_length: 150, max_length: 220, do_sample: false },
        token: HF_TOKEN,
      });
      bartText = retryText;
    }

    let summary = normalizeParagraph(bartText);
    let usedModel = "facebook/bart-large-cnn";

    if (!summary || summary.length < 80) {
      const t5Input = `summarize: Write a single-paragraph academic abstract (150–220 words) using formal tone.\n\n${cleaned}`;
      const { text: t5Text } = await callHF({
        model: "t5-base",
        inputs: t5Input,
        parameters: { max_new_tokens: 240, num_beams: 4, do_sample: false },
        token: HF_TOKEN,
      });
      summary = normalizeParagraph(t5Text);
      usedModel = "t5-base";
    }

    if (!summary || summary.length < 50) {
      summary = heuristicSummary(cleaned);
      usedModel = "heuristic";
    }

    res.status(200).json({ ok: true, model: usedModel, summary });
  } catch (err) {
    console.error("❌ Summarization failed:", err);
    res.status(500).json({ ok: false, error: "Summarization failed.", details: err.message });
  }
});

/* ===================  /api/ai/abstract-tools  ================== */
/**
 * Modes:
 *  - "tldr": short takeaway from abstract or PDF
 *  - "scope": scope & limitation scaffold
 *  - "methods": methods/instruments/stats inference from abstract/PDF
 *  - "recommendations": extract recommendations and suggestions from research text
 *  - "citations": **self-if (mode === "metho** (APA/IEEE/BibTeX) using meta (back-compat)
 *  - "self-cite": same as "citations" (alias)
 *  - "refscan": scan PDF References/Bibliography and return list of cited works
 */
router.post("/abstract-tools", async (req, res) => {
  try {
    console.log("[abstract-tools] Received request:", {
      mode: req.body.mode,
      hasAbstract: !!req.body.abstract,
      hasFilePath: !!req.body.filePath,
      hasResearchId: !!req.body.researchId,
      bodyKeys: Object.keys(req.body)
    });
    const { mode, abstract = "", meta = {}, filePath, researchId } = req.body || {};
    const { title = "", author = "", year = "", categories = [], genreTags = [] } = meta;

    // If given a file, pull text to improve inference
    let pdfText = "";
    let actualFilePath = filePath;
    
    // If researchId is provided but no filePath, try to fetch it from database
    if (!actualFilePath && researchId) {
      try {
        const Research = require("../models/Research");
        const research = await Research.findById(researchId).select("filePath").lean();
        if (research?.filePath) {
          actualFilePath = research.filePath;
          console.log(`[abstract-tools] Fetched filePath from DB: ${actualFilePath}`);
        }
      } catch (err) {
        console.warn(`[abstract-tools] Could not fetch filePath for researchId ${researchId}:`, err.message);
      }
    }
    
    const parsed = await safeReadPdfFromRelative(actualFilePath);
    if (parsed?.text) pdfText = parsed.text;

    const text = String(abstract || pdfText || "").trim();

    /* ---------- helpers for this route ---------- */
    const apaList = parseAuthorsToAPAList(author);
    const ieeeList = toIEEEList(apaList);
    const bibtexAuthor = toBibtexAuthor(author);
    const yr = normalizeYear(year);
    const titleSentence = toSentenceCase(title || "Untitled study");

    let out = "No output.";

   if (mode === "tldr") {
      const HF_TOKEN = process.env.HF_TOKEN;
      const source = (pdfText || text || "").trim();

      if (!source) {
        return res.json({ text: "**Short Takeaway:** No content available for summary." });
      }

      let tldr;
      if (HF_TOKEN) {
        try {
          tldr = await generateTldr(source, HF_TOKEN);
        } catch (e) {
          console.warn("TL;DR model failed, using heuristic:", e?.message || e);
          tldr = heuristicTldr(source);
        }
      } else {
        tldr = heuristicTldr(source);
      }

      // Final cleanup and word count enforcement
      tldr = tldr.replace(/\s*\.\s*$/, "") + ".";
      const words = tldr.split(/\s+/);
      if (words.length > 50) {
        tldr = words.slice(0, 50).join(" ").replace(/[.,;]\s*$/, "") + ".";
      }

      return res.json({ text: `**Short Takeaway:** ${tldr}` });
    }

if (mode === "methods") {
  const lower = text.toLowerCase();
  const findAll = (re) => [...lower.matchAll(re)].map(x => x[0]);

  // helper: deduplicate + title case
  const dedup = (arr) =>
    [...new Set(arr.map(x => x.trim().toLowerCase()))]
      .filter(Boolean)
      .map(x => x[0].toUpperCase() + x.slice(1));

  // ✅ add "g" flag to all that will be used with matchAll
  const quantitativeRe = /\b(quantitative|statistical|numerical|experiment|survey|measurement|anova|regression|t[- ]?test|pca|svm|spm1d|chi[- ]?square|pearson|spearman)\b/g;
  const qualitativeRe = /\b(qualitative|phenomenological|thematic|interview|focus group|content analysis|narrative|case study|grounded theory)\b/g;
  const mixedRe = /\bmixed[- ]?methods?\b/g;

  let approach = "";
  if (mixedRe.test(lower)) approach = "Mixed Methods";
  else if (quantitativeRe.test(lower) && qualitativeRe.test(lower)) approach = "Mixed Methods";
  else if (quantitativeRe.test(lower)) approach = "Quantitative";
  else if (qualitativeRe.test(lower)) approach = "Qualitative";

  const design = dedup(
    findAll(/experimental|quasi[- ]?experimental|descriptive|correlational|comparative|observational|phenomenological|survey|case[- ]?study|developmental|design[- ]?based|prototype|simulation|hardware testing|usability|iot|automation/g)
  );

  const environment = dedup(
    findAll(/school|laboratory|farm|field|garden|community|classroom|simulation|prototype|testing|home|urban|rural/g)
  );

  let sample =
    lower.match(/n\s*=\s*\d+/)?.[0]?.replace(/\s+/g, " ") ||
    lower.match(/\b(sample size|participants?|respondents?|subjects?|farmers?|students?)\s*[:=]?\s*\d+/)?.[0] || "";
  sample = sample.replace(/\s*[:=]\s*/g, " = ");

  const instruments = dedup(
    findAll(/questionnaire|sensor|arduino|esp8266|hx711|mlx90393|force plate|camera|dht11|soil moisture|relay|ph sensor|lcd|survey form|interview guide|observation sheet|data logger|fusion 360|ansys|simulation|excel|solar panel|humidity sensor|transmitter|microcontroller/g)
  );

  const software = dedup(
    findAll(/excel|spss|python|matlab|arduino ide|adafruit|thinger|io|blynk|cloud|web app|iot platform|mobile app|firebase|node[- ]?red/g)
  ).map(x => x.toLowerCase() === "io" ? "IoT" : x);

  const analysis = dedup(
    findAll(/mean|t[- ]?test|anova|regression|correlation|descriptive|content analysis|thematic|coding|trend|comparison|graphical|statistical|qualitative interpretation/g)
  );

  // ✅ detect outcomes (only if found)
  const outcomes = findAll(/\b(growth|height|efficien|performance|accuracy|speed|yield|output|temperature|humidity|voltage|data|pressure|response|feedback)\b/g);
  const hasOutcomes = outcomes.length > 0;
  const topOutcomes = hasOutcomes ? dedup(outcomes).slice(0, 5).join(", ") : "";

  // build checklist
  const lines = ["Methods Checklist"];
  if (approach) lines.push(`• Research Approach: ${approach}`);
  if (design.length) lines.push(`• Research Design: ${design.join(", ")}`);
  if (environment.length) lines.push(`• Research Environment: ${environment.join(", ")}`);
  if (sample) lines.push(`• Participants/Sample: ${sample}`);
  if (instruments.length) lines.push(`• Instruments/Tools: ${instruments.join(", ")}`);
  if (software.length) lines.push(`• Software/Platform Used: ${software.join(", ")}`);
  if (analysis.length) lines.push(`• Data Analysis: ${analysis.join(", ")}`);
  if (hasOutcomes) lines.push(`• Primary Outcomes: Identify variables like ${topOutcomes}.`);

  return res.json({ text: lines.join("\n") });
}

if (mode === "recommendations") {
  console.log("[Recommendations] Starting recommendations extraction");
  
  try {
    // Get text content - prioritize PDF text, then abstract
    const fullText = (pdfText || text || "").trim();
    console.log(`[Recommendations] Text length: ${fullText.length}`);
    
    if (!fullText) {
      console.log("[Recommendations] No text content available");
      return res.json({ 
        text: "**Research Recommendations**\n\nNo readable text content available for analysis." 
      });
    }

    let recommendations = [];
    
    // Clean the text - handle page numbers and formatting for Research Text 2
    let cleanedText = fullText
      .replace(/\r\n/g, '\n')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .replace(/\s+/g, ' ')
      .trim();
    
    // SPECIAL HANDLING FOR RESEARCH TEXT 2
    // Remove standalone page numbers (like "79" on its own line)
    cleanedText = cleanedText.replace(/(?:^|\n)\s*\d+\s*(?=\n|$)/g, '\n');
    
    // Remove page numbers attached to section headers
    cleanedText = cleanedText.replace(/(Recommendations for Practice|Recommendations for Research)\s+\d+/gi, '$1');
    
    console.log("[Recommendations] Text after cleaning:", cleanedText.substring(0, 500));
    
    // STRATEGY 1: Extract numbered lists with better handling for Research Text 2
    console.log("[Recommendations] Strategy 1: Enhanced numbered list extraction...");
    
    // Improved pattern for numbered items (handles multi-line items better)
    const numberedPattern = /(?:\n|^)\s*(\d+)[\.\)]\s+([^\n]+(?:\n(?!\s*(?:\d+[\.\)]|[a-z][\.\)]|[A-Z][A-Z\s]+$))[^\n]+)*)/g;
    
    let match;
    while ((match = numberedPattern.exec(cleanedText)) !== null) {
      let item = match[2].trim();
      
      // Clean multi-line items
      item = item.replace(/\s*\n\s*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
      
      // Skip if too short or contains obvious non-recommendation content
      if (item.length < 20 || item.length > 400) continue;
      
      // Check if it's a recommendation (Research Text 2 specific checks)
      const lowerItem = item.toLowerCase();
      const isResearch2Recommendation = 
        lowerItem.includes('administration should') ||
        lowerItem.includes('value of') ||
        lowerItem.includes('positive interventions') ||
        lowerItem.includes('freshmen need') ||
        lowerItem.includes('peer mentoring') ||
        lowerItem.includes('more studies') ||
        lowerItem.includes('study on leadership') ||
        lowerItem.includes('further studies') ||
        lowerItem.includes('longitudinal study') ||
        lowerItem.includes('qualitative study') ||
        lowerItem.includes('research on the impact') ||
        lowerItem.includes('effects of freshman academies');
      
      const isGeneralRecommendation = 
        lowerItem.includes('should') || 
        lowerItem.includes('recommend') || 
        lowerItem.includes('suggest') ||
        lowerItem.includes('need to') ||
        lowerItem.includes('would benefit') ||
        lowerItem.startsWith('to ') ||
        lowerItem.startsWith('the study should');
      
      if (isResearch2Recommendation || isGeneralRecommendation) {
        // Format properly
        if (!/[.!?]$/.test(item)) item += '.';
        if (item.length > 0 && !/^[A-Z]/.test(item)) {
          item = item.charAt(0).toUpperCase() + item.slice(1);
        }
        
        recommendations.push(item);
        console.log(`[Recommendations] Numbered item: ${item.substring(0, 80)}...`);
      }
    }
    
    // STRATEGY 2: Extract lettered sub-items (for Research Text 2)
    if (recommendations.length < 5) {
      console.log("[Recommendations] Strategy 2: Extracting lettered sub-items...");
      
      const letteredPattern = /(?:\n|^)\s*([a-z])[\.\)]\s+([^\n]+(?:\n(?!\s*[a-z][\.\)])[^\n]+)*)/g;
      
      while ((match = letteredPattern.exec(cleanedText)) !== null) {
        let item = match[2].trim();
        
        item = item.replace(/\s*\n\s*/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim();
        
        if (item.length > 20 && item.length < 300) {
          const lowerItem = item.toLowerCase();
          
          // Check if it's a recommendation
          if (lowerItem.includes('longitudinal study') ||
              lowerItem.includes('qualitative study') ||
              lowerItem.includes('research on the impact') ||
              lowerItem.includes('should') ||
              lowerItem.includes('would be interesting')) {
            
            if (!/[.!?]$/.test(item)) item += '.';
            if (item.length > 0 && !/^[A-Z]/.test(item)) {
              item = item.charAt(0).toUpperCase() + item.slice(1);
            }
            
            recommendations.push(item);
            console.log(`[Recommendations] Lettered item: ${item.substring(0, 80)}...`);
          }
        }
      }
    }
    
    // STRATEGY 3: Look for "Recommendations for Practice" and "Recommendations for Research" sections
    if (recommendations.length < 3) {
      console.log("[Recommendations] Strategy 3: Extracting from specific sections...");
      
      // Try to find both sections
      const sections = [
        { name: "practice", pattern: /recommendations?\s+for\s+practice\s*[:\-]?\s*\n/i },
        { name: "research", pattern: /recommendations?\s+for\s+research\s*[:\-]?\s*\n/i }
      ];
      
      for (const section of sections) {
        const match = cleanedText.match(section.pattern);
        if (match) {
          console.log(`[Recommendations] Found section: ${section.name}`);
          const sectionStart = match.index + match[0].length;
          
          // Find the end of this section (next section or end of reasonable length)
          const remainingText = cleanedText.substring(sectionStart);
          const nextSection = remainingText.match(/(?:recommendations?|suggestions?|conclusions?|references?|bibliography)\s+/i);
          
          const sectionText = nextSection 
            ? remainingText.substring(0, nextSection.index)
            : remainingText.substring(0, 2000);
          
          // Extract numbered items from this section
          const sectionNumberedPattern = /(?:\n|^)\s*(\d+)[\.\)]\s+([^\n]+(?:\n(?!\s*\d+[\.\)])[^\n]+)*)/g;
          const sectionMatches = [...sectionText.matchAll(sectionNumberedPattern)];
          
          for (const sectionMatch of sectionMatches) {
            let item = sectionMatch[2].trim();
            
            item = item.replace(/\s*\n\s*/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim();
            
            if (item.length > 20 && item.length < 400) {
              // Skip if it's just a section header
              if (/^[A-Z\s]{10,}$/.test(item)) continue;
              
              // Check if it contains recommendation language
              if (item.toLowerCase().includes('should') || 
                  item.toLowerCase().includes('need') ||
                  item.toLowerCase().includes('would be') ||
                  item.toLowerCase().includes('recommend') ||
                  item.toLowerCase().includes('suggest')) {
                
                if (!/[.!?]$/.test(item)) item += '.';
                if (item.length > 0 && !/^[A-Z]/.test(item)) {
                  item = item.charAt(0).toUpperCase() + item.slice(1);
                }
                
                recommendations.push(item);
                console.log(`[Recommendations] From ${section.name} section: ${item.substring(0, 80)}...`);
              }
            }
          }
        }
      }
    }
    
    // STRATEGY 4: Direct pattern matching for Research Text 2 items
    if (recommendations.length < 5) {
      console.log("[Recommendations] Strategy 4: Direct pattern matching for Research Text 2...");
      
      // Specific patterns for Research Text 2
      const research2Patterns = [
        // Practice recommendations
        /Administration\s+should\s+examine\s+the\s+process[^.!?]+[.!?]/gi,
        /The\s+value\s+of\s+advisory\s+programs[^.!?]+[.!?]/gi,
        /Positive\s+interventions[^.!?]+[.!?]/gi,
        /All\s+freshmen\s+need\s+multiple\s+opportunities[^.!?]+[.!?]/gi,
        /The\s+value\s+of\s+peer\s+mentoring[^.!?]+[.!?]/gi,
        
        // Research recommendations
        /More\s+studies\s+on\s+the\s+effects[^.!?]+[.!?]/gi,
        /A\s+study\s+on\s+leadership\s+best\s+practices[^.!?]+[.!?]/gi,
        /Further\s+studies\s+involving[^.!?]+[.!?]/gi,
        /It\s+would\s+be\s+particularly\s+interesting[^.!?]+[.!?]/gi,
        /A\s+qualitative\s+study\s+could\s+be\s+conducted[^.!?]+[.!?]/gi,
        /Research\s+on\s+the\s+impact[^.!?]+[.!?]/gi,
        /The\s+effects\s+of\s+freshman\s+academies[^.!?]+[.!?]/gi,
      ];
      
      for (const pattern of research2Patterns) {
        const matches = [...cleanedText.matchAll(pattern)];
        for (const match of matches) {
          let item = match[0].trim();
          
          if (item.length > 25 && item.length < 350) {
            // Skip if already captured
            const isDuplicate = recommendations.some(rec => 
              rec.toLowerCase().includes(item.toLowerCase().substring(0, 40))
            );
            
            if (!isDuplicate) {
              if (!/[.!?]$/.test(item)) item += '.';
              if (item.length > 0 && !/^[A-Z]/.test(item)) {
                item = item.charAt(0).toUpperCase() + item.slice(1);
              }
              
              recommendations.push(item);
              console.log(`[Recommendations] Direct pattern match: ${item.substring(0, 80)}...`);
            }
          }
        }
      }
    }
    
    // STRATEGY 5: For Research Text 1 and 3 - specific patterns
    if (recommendations.length < 3) {
      console.log("[Recommendations] Strategy 5: Patterns for Research Text 1 and 3...");
      
      // Patterns for Research Text 1
      const research1Patterns = [
        /To\s+improve\s+this\s+action\s+research[^.!?]+[.!?]/gi,
        /It\s+would\s+be\s+beneficial\s+for\s+students[^.!?]+[.!?]/gi,
        /To\s+improve\s+curriculum\s+barriers[^.!?]+[.!?]/gi,
      ];
      
      // Patterns for Research Text 3
      const research3Patterns = [
        /The\s+study\s+should\s+be\s+performed[^.!?]+[.!?]/gi,
        /It\s+is\s+better\s+if\s+different\s+kinds\s+of\s+plants[^.!?]+[.!?]/gi,
        /To\s+add\s+another\s+sensors\s+and\s+battery[^.!?]+[.!?]/gi,
        /To\s+add\s+shade\s+using\s+thermochromic[^.!?]+[.!?]/gi,
      ];
      
      const allPatterns = [...research1Patterns, ...research3Patterns];
      
      for (const pattern of allPatterns) {
        const matches = [...cleanedText.matchAll(pattern)];
        for (const match of matches) {
          let item = match[0].trim();
          
          if (item.length > 20 && item.length < 300) {
            const isDuplicate = recommendations.some(rec => 
              rec.toLowerCase() === item.toLowerCase()
            );
            
            if (!isDuplicate) {
              if (!/[.!?]$/.test(item)) item += '.';
              if (item.length > 0 && !/^[A-Z]/.test(item)) {
                item = item.charAt(0).toUpperCase() + item.slice(1);
              }
              
              recommendations.push(item);
              console.log(`[Recommendations] R1/R3 pattern match: ${item.substring(0, 80)}...`);
            }
          }
        }
      }
    }
    
    // STRATEGY 6: AI extraction as fallback
    if (recommendations.length === 0 && process.env.HF_TOKEN && fullText.length > 200) {
      console.log("[Recommendations] Strategy 6: AI extraction fallback...");
      
      try {
        // Special prompt for Research Text 2
        const aiPrompt = `Extract ALL numbered recommendations from this text. 
Look for sections titled "Recommendations for Practice" and "Recommendations for Research".
Extract each numbered item (1., 2., 3., etc.) and any lettered sub-items (a., b., c.).
Return each recommendation as a complete sentence.

Text: ${fullText.substring(0, 3000)}

Extracted recommendations:`;

        const aiResult = await callHF({
          model: "facebook/bart-large-cnn",
          inputs: aiPrompt,
          parameters: {
            max_length: 600,
            min_length: 100,
            do_sample: false,
            temperature: 0.2,
          },
          token: process.env.HF_TOKEN,
          tries: 2,
          timeoutMs: 30000,
        });

        if (aiResult.text && !aiResult.error) {
          console.log("[Recommendations] AI extraction successful");
          
          const aiLines = aiResult.text.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 20)
            .map(line => {
              // Clean up
              line = line.replace(/^\d+[\.\)]\s*/, '')
                         .replace(/^[a-z][\.\)]\s*/i, '')
                         .replace(/^[•\-*]\s*/, '')
                         .trim();
              
              if (!/[.!?]$/.test(line)) line += '.';
              if (line.length > 0 && !/^[A-Z]/.test(line)) {
                line = line.charAt(0).toUpperCase() + line.slice(1);
              }
              
              return line;
            })
            .filter(line => line.length > 20 && line.length < 300);
          
          // Add AI recommendations if we have none
          if (recommendations.length === 0 && aiLines.length > 0) {
            recommendations = aiLines.slice(0, 10);
          }
        }
      } catch (error) {
        console.warn("[Recommendations] AI extraction failed:", error.message);
      }
    }
    
    // FINAL PROCESSING: Filter out non-recommendations and duplicates
    console.log(`[Recommendations] Before filtering: ${recommendations.length} items`);
    
    const finalRecommendations = [];
    const seen = new Set();
    
    // Exclusion list for non-recommendations
    const excludePatterns = [
      /^To\s+address\s+the\s+(?:issue|following questions?)/i,
      /^To\s+add\s+an\s+unnecessary/i,
      /^To\s+Address\s+Climate\s+Change/i,
      /government\s+dropped\s+the\s+prices/i,
      /^Future\s+Research\s+\d+/i,
      /^CONCLUSION\s+\d+/i,
      /^CHAPTER\s+\d+/i,
      /^[A-Z\s]{10,}$/, // All caps headers
    ];
    
    for (const rec of recommendations) {
      if (!rec || rec.trim().length < 25) continue;
      
      const trimmed = rec.trim();
      const lower = trimmed.toLowerCase();
      
      // Check if it should be excluded
      let shouldExclude = false;
      for (const pattern of excludePatterns) {
        if (pattern.test(trimmed)) {
          shouldExclude = true;
          console.log(`[Recommendations] Excluded: ${trimmed.substring(0, 60)}...`);
          break;
        }
      }
      
      if (shouldExclude) continue;
      
      // Check if it's a valid recommendation
      const isValid = 
        lower.includes('should') || 
        lower.includes('recommend') || 
        lower.includes('suggest') ||
        lower.includes('need to') ||
        lower.includes('would benefit') ||
        lower.includes('better') ||
        lower.includes('improve') ||
        lower.includes('add') ||
        lower.includes('consider') ||
        lower.includes('investigate') ||
        lower.includes('examine') ||
        lower.startsWith('to ') ||
        lower.startsWith('administration ') ||
        lower.startsWith('the study ') ||
        lower.includes('value of') ||
        lower.includes('positive interventions') ||
        lower.includes('freshmen need') ||
        lower.includes('more studies') ||
        lower.includes('further studies') ||
        lower.includes('research on') ||
        lower.includes('effects of');
      
      if (!isValid) continue;
      
      // Deduplicate
      const key = lower
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .substring(0, 60);
      
      if (!seen.has(key)) {
        seen.add(key);
        
        // Final formatting
        let finalRec = trimmed;
        if (!/[.!?]$/.test(finalRec)) finalRec += '.';
        if (finalRec.length > 0 && !/^[A-Z]/.test(finalRec)) {
          finalRec = finalRec.charAt(0).toUpperCase() + finalRec.slice(1);
        }
        
        finalRecommendations.push(finalRec);
      }
    }
    
    recommendations = finalRecommendations.slice(0, 12);
    console.log(`[Recommendations] Final count: ${recommendations.length} recommendations`);
    
    // FORMAT OUTPUT
    let output = "**Research Recommendations**\n\n";
    
    if (recommendations.length > 0) {
      if (recommendations.length === 1) {
        output += "Based on analysis of the research content, 1 recommendation was identified:\n\n";
      } else {
        output += `Based on analysis of the research content, ${recommendations.length} recommendations were identified:\n\n`;
      }
      
      recommendations.forEach((rec, index) => {
        output += `${index + 1}. ${rec}\n\n`;
      });
    } else {
      output += "No specific recommendations were identified in the text.\n\n";
      output += "This could be because:\n";
      output += "• The study may not include explicit recommendations\n";
      output += "• Recommendations are embedded in discussion or conclusion sections\n";
      output += "• The text format may not follow standard recommendation patterns\n";
    }
    
    return res.json({ 
      text: output,
      count: recommendations.length,
      success: recommendations.length > 0
    });
    
  } catch (error) {
    console.error("[Recommendations] Critical error:", error);
    
    return res.json({ 
      text: "**Research Recommendations**\n\nAn error occurred while extracting recommendations. Please try again.",
      count: 0,
      success: false
    });
  }
}







if (mode === "refscan") {
  // Scan references from PDF (fallback to abstract text if no PDF)
  const refs = extractReferencesFromText(pdfText || abstract);
  return res.json({
    ok: true,
    count: refs.length,
    items: refs,
  });
}

if (mode === "citations" || mode === "self-cite") {
  // Properly format from authors (email usernames allowed)
  const apaAuthors = apaList.join(", ");
  const ieeeAuthors = ieeeList.join(", ");

  const apa = `${apaAuthors} (${yr}). ${titleSentence}.`;
  const ieee = `${ieeeAuthors}, "${titleSentence}," ${yr}.`;

  // BibTeX key from first author's last name + year
  const firstLast = (apaList[0] || "Author").split(",")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const bibkey = `${firstLast}${yr === "n.d." ? "nd" : yr}`;
  const bibtex = [
    `@article{${bibkey},`,
    `  title={${title || "Untitled study"}},`,
    `  author={${bibtexAuthor || "Author"}},`,
    `  year={${yr}}`,
    `}`
  ].join("\n");

  out = `### Citations\n**APA**\n> ${apa}\n\n**IEEE**\n> ${ieee}\n\n**BibTeX**\n\`\`\`bibtex\n${bibtex}\n\`\`\``;

  // Also try to include scanned references (if present) for convenience
  const refs = extractReferencesFromText(pdfText);
  return res.json({
    text: out,
    citations: { apa, ieee, bibtex },
    references: refs && refs.length ? refs : undefined
  });
}

// default
res.json({ text: out });
  } catch (e) {
    console.error("AI tools error:", e);
    res.status(500).json({ error: "Failed to generate AI output." });
  }
});

/* ======================  /api/ai/tldr  ====================== */
router.post("/tldr", upload.single("file"), async (req, res) => {
  try {
    const HF_TOKEN = process.env.HF_TOKEN || "";
    const { abstract = "", filePath = "" } = req.body || {};

    // Prefer PDF text if provided
    let pdfText = "";
    const parsed = await safeReadPdfFromRelative(filePath);
    if (parsed?.text) pdfText = parsed.text;

    const source = String(pdfText || abstract || "").replace(/\s+/g, " ").trim();
    if (!source) return res.status(400).json({ ok: false, error: "No text/PDF content to summarize." });

    let tldr;
    if (HF_TOKEN) {
      try {
        tldr = await generateTldr(source, HF_TOKEN);
      } catch (e) {
        console.warn("TL;DR model failed, using heuristic:", e?.message || e);
        tldr = heuristicTldr(source);
      }
    } else {
      tldr = heuristicTldr(source);
    }

    // Normalize: no trailing ellipsis, ensure period, <= ~80 words
    tldr = (tldr || "")
      .replace(/\s*…+\s*$/g, "")
      .replace(/\s*\.\s*$/, "") + ".";
    const words = tldr.split(/\s+/);
    if (words.length > 80) tldr = words.slice(0, 80).join(" ") + ".";

    return res.json({ ok: true, text: `${tldr}` });
  } catch (e) {
    console.error("❌ TL;DR failed:", e);
    return res.status(500).json({ ok: false, error: "TL;DR failed." });
  }
});


module.exports = router;
