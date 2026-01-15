import React, { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
// Import the worker using Vite's ?url syntax to get the resolved URL
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Set up the worker for pdf.js using the imported worker URL
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface TokenPosition {
  wordIndex: number;
  paragraphIndex: number;
}

interface ParsedParagraph {
  raw: string;
  words: string[];
}

const TITLE_PATTERN = "(?:Mr|Mrs|Ms|Miss|Dr|Prof|Professor|Governor|Mayor|Senator|Representative|Congressman|Congresswoman|King|Queen|Prince|Princess|Duke|Duchess|Sir|Madam|Madame|Lord|Lady|President|Vice\\s+President|Secretary|General|Admiral|Colonel|Major|Captain|Lieutenant|Sergeant|Chief|Judge|Justice|Ambassador|Minister|Chancellor|Premier|Prime\\s+Minister)\\.?\\s+";

function normalizeLineEndings(raw: string): string {
  // Pasted text can contain CRLF (\r\n) or CR-only (\r). Normalize so our parsing is consistent.
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const DEBUG = false;
const DEBUG_TEXT_PARSE = false;

function debugLog(...args: unknown[]): void {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(...args);
}

function normalizeForParsing(raw: string): string {
  // Make copy/paste + cross-site punctuation more consistent.
  return normalizeLineEndings(raw)
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":");
}

function parseUrlOnlyInput(raw: string): string | null {
  const trimmed = normalizeForParsing(raw).trim();
  if (!trimmed) return null;

  // If there's any whitespace, it's not "URL-only".
  if (/\s/.test(trimmed)) return null;

  // Remove common wrappers from some apps (e.g., "<https://...>")
  const unwrapped = trimmed.replace(/^<(.+)>$/, "$1").trim();

  try {
    const u = new URL(unwrapped);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function splitTranscriptIntoSpeakerParagraphs(text: string): string[] {
  const cleaned = normalizeForParsing(text);

  // Split by speaker marker positions instead of relying on newlines.
  // This matches the robustness of the URL parser (DOM textContent often collapses line breaks),
  // and it also fixes pasted transcripts where speaker lines are separated from their content.
  //
  // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
  const speakerMarker = new RegExp(
    `((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\)\\s*:\\s*)`,
    "g"
  );

  const matches = Array.from(cleaned.matchAll(speakerMarker)).filter((m) => m.index !== undefined) as Array<
    RegExpMatchArray & { index: number }
  >;

  if (DEBUG_TEXT_PARSE) {
    debugLog("[Text Parse] splitTranscriptIntoSpeakerParagraphs", {
      textLength: cleaned.length,
      markerCount: matches.length,
      markerSample: matches.slice(0, 5).map((m) => ({ at: m.index, marker: (m[0] || "").trim() }))
    });
  }

  // Fallback: no speaker markers found, treat as plain text paragraphs.
  if (matches.length === 0) {
    return cleaned
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  const getSpeakerKeyFromMarker = (markerText: string): string | null => {
    const trimmed = markerText.trim();
    const m = trimmed.match(
      new RegExp(
        `^(?:${TITLE_PATTERN})?((?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3})|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`
      )
    );
    return m ? m[1].trim() : null;
  };

  const cleanContinuationText = (t: string): string => {
    // If a paragraph is interrupted by "Same Speaker (mm:ss): …", remove the ellipsis marker.
    return t
      .replace(/^[\u2026…]+/g, "") // unicode ellipsis
      .replace(/^\.{3,}/g, "") // "..."
      .trim();
  };

  const paragraphs: string[] = [];
  const push = (rawPara: string) => {
    const trimmed = rawPara.trim();
    if (trimmed) paragraphs.push(trimmed);
  };

  // Build paragraphs while tracking the active speaker, so repeated markers from the same
  // speaker do NOT create new paragraphs (they get merged as continuation).
  let currentRaw = "";
  let activeSpeakerKey: string | null = null;

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i < matches.length - 1 ? matches[i + 1].index : cleaned.length;

    const markerText = matches[i][0] || "";
    const speakerKey = getSpeakerKeyFromMarker(markerText);

    const segment = cleaned.slice(start, end).trim();
    if (!segment) continue;

    const afterMarker = segment.slice(markerText.length).trimStart();

    if (speakerKey && activeSpeakerKey && speakerKey.toLowerCase() === activeSpeakerKey.toLowerCase()) {
      const continuation = cleanContinuationText(afterMarker);
      if (continuation) currentRaw = (currentRaw ? `${currentRaw} ${continuation}` : continuation).trim();
      continue;
    }

    if (currentRaw) push(currentRaw);
    activeSpeakerKey = speakerKey;
    currentRaw = afterMarker ? `${markerText.trim()} ${afterMarker}`.trim() : markerText.trim();
  }

  if (currentRaw) push(currentRaw);

  return paragraphs;
}

function mergeTranscriptParagraphsFromPlainParas(paras: string[]): string[] {
  // If transcript detection fails (often due to copy/paste quirks), we can still recover by
  // merging "Speaker line" paragraphs with the text that follows until the next speaker line.
  // This specifically fixes cases where a speaker header is separated by blank lines from their speech.
  const speakerHeader = new RegExp(
    `^(${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\)\\s*:\\s*`,
    ""
  );
  const speakerHeaderNoTimestamp = new RegExp(
    `^(${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,3}|[Ss]peaker\\s+[0-9]+)\\s*:\\s*`,
    ""
  );

  const noTimestampHeaderCount = paras.reduce((acc, p) => {
    const t = p?.trim() || "";
    return acc + (speakerHeaderNoTimestamp.test(t) ? 1 : 0);
  }, 0);

  const isSpeakerStart = (p: string): boolean => {
    if (speakerHeader.test(p)) return true;
    // Avoid treating ordinary headings like "Table of Contents:" as a "speaker" unless it repeats.
    if (noTimestampHeaderCount >= 3 && speakerHeaderNoTimestamp.test(p)) return true;
    return false;
  };

  const merged: string[] = [];
  for (let i = 0; i < paras.length; i++) {
    const current = paras[i]?.trim();
    if (!current) continue;

    if (!isSpeakerStart(current)) {
      merged.push(current);
      continue;
    }

    // Start of a speaker block: append following paragraphs until next speaker.
    let combined = current;
    let j = i + 1;
    while (j < paras.length) {
      const next = paras[j]?.trim();
      if (!next) {
        j += 1;
        continue;
      }
      if (isSpeakerStart(next)) break;
      combined = `${combined} ${next}`.trim();
      j += 1;
    }

    merged.push(combined);
    i = j - 1;
  }

  if (DEBUG_TEXT_PARSE) {
    debugLog("[Text Parse] mergeTranscriptParagraphsFromPlainParas", {
      before: paras.length,
      after: merged.length,
      noTimestampHeaderCount,
      firstBefore: paras[0]?.slice(0, 160),
      firstAfter: merged[0]?.slice(0, 160)
    });
  }

  return merged;
}

function findPivotIndex(word: string): number {
  const len = word.length;
  if (len % 2 === 0) {
    return len / 2 - 1 || 0;
  } else {
    return (len - 1) / 2 || 0;
  }
}

function findPivotIndexIgnoringSpaces(text: string): number {
  // For multi-word frames (e.g., "Jane Doe"), choose pivot by counting letters
  // excluding spaces, then map back to the original string index so we can render
  // the pivot character in-place.
  if (!text) return 0;
  if (!text.includes(" ")) return findPivotIndex(text);

  const nonSpaceToOriginalIndex: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== " ") nonSpaceToOriginalIndex.push(i);
  }

  if (nonSpaceToOriginalIndex.length === 0) return 0;
  const pivotInNonSpace = findPivotIndex("x".repeat(nonSpaceToOriginalIndex.length));
  return nonSpaceToOriginalIndex[Math.min(Math.max(pivotInNonSpace, 0), nonSpaceToOriginalIndex.length - 1)];
}

function normalizeText(raw: string): ParsedParagraph[] {
  const cleaned = normalizeForParsing(raw);

  // Detect transcript markers in a way that's resilient to copy/paste quirks.
  // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
  const transcriptMarker = new RegExp(
    `((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\)\\s*:\\s*)`,
    "g"
  );
  const transcriptMarkerMatches = Array.from(cleaned.matchAll(transcriptMarker));

  // Also support transcript formats where timestamps are missing but there are multiple speaker labels.
  // We require a few matches to avoid false positives like "Chapter 1:" in regular text.
  const speakerOnlyMarker = new RegExp(
    `(^|\\n)\\s*((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,3}|[Ss]peaker\\s+[0-9]+))\\s*:\\s*`,
    "gm"
  );
  const speakerOnlyMatches = Array.from(cleaned.matchAll(speakerOnlyMarker));

  const hasTranscriptFormat = transcriptMarkerMatches.length > 0 || speakerOnlyMatches.length >= 3;

  if (DEBUG_TEXT_PARSE) {
    debugLog("[Text Parse] normalizeText", {
      textLength: cleaned.length,
      transcriptMarkerCount: transcriptMarkerMatches.length,
      transcriptMarkerSample: transcriptMarkerMatches.slice(0, 5).map((m) => (m[0] || "").trim()),
      speakerOnlyMarkerCount: speakerOnlyMatches.length,
      speakerOnlyMarkerSample: speakerOnlyMatches.slice(0, 5).map((m) => (m[2] || "").trim()),
      hasTranscriptFormat
    });
  }
  
  if (hasTranscriptFormat) {
    const paragraphs: ParsedParagraph[] = [];

    const pushParagraph = (p: string) => {
      const cleanedPara = cleanTranscriptParagraph(p);
      if (!cleanedPara) return;
      const words = splitTranscriptWords(cleanedPara);
      if (words.length > 0) paragraphs.push({ raw: cleanedPara, words });
    };

    const rawTranscriptParagraphs = splitTranscriptIntoSpeakerParagraphs(cleaned);
    rawTranscriptParagraphs.forEach(pushParagraph);

    if (DEBUG_TEXT_PARSE) {
      debugLog("[Text Parse] transcript paragraphs built", {
        paragraphCount: paragraphs.length,
        firstRaw: paragraphs[0]?.raw?.slice(0, 220),
        secondRaw: paragraphs[1]?.raw?.slice(0, 220)
      });
    }
    
    return paragraphs;
  }
  
  const paras = cleaned
    .split(/\n{2,}|\r{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (!paras.length) return [];

  // Even for non-transcript content, this is a safe no-op unless there are repeated speaker headers.
  // For transcript pastes where markers weren't detected, this is the main recovery path.
  const mergedParas = mergeTranscriptParagraphsFromPlainParas(paras);

  return mergedParas.map((p) => {
    const words = p
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .split(/\s+/)
      .filter(Boolean);

    return { raw: p, words };
  });
}

function deduplicateSpeakerName(speakerName: string): string {
  const words = speakerName.trim().split(/\s+/);
  const seen = new Set<string>();
  const deduplicated: string[] = [];
  
  for (const word of words) {
    const wordLower = word.toLowerCase();
    if (!seen.has(wordLower)) {
      seen.add(wordLower);
      deduplicated.push(word);
    }
  }
  
  return deduplicated.join(" ");
}

function deduplicateRepeatedSpeakerNames(text: string): string {
  debugLog("[Dedupe] Starting deduplication", { textLength: text.length, textPreview: text.substring(0, 300) });
  
  // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
  const speakerNamePattern = `(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)`;
  const speakerLinePattern = new RegExp(`(${speakerNamePattern})\\s*:`, "g");
  
  let result = text;
  let previousResult = "";
  let iterations = 0;
  const maxIterations = 10;
  
  while (result !== previousResult && iterations < maxIterations) {
    previousResult = result;
    iterations++;
    
    const beforeIteration = result;
    
    result = result.replace(speakerLinePattern, (match, speakerName, offset) => {
      const cleanName = deduplicateSpeakerName(speakerName);
      const beforeMatch = result.substring(Math.max(0, offset - 500), offset);
      const cleanNameLower = cleanName.toLowerCase();
      const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      const repeatedFullNamePattern = new RegExp(`(${escapedName})(?:\\s+\\1)+\\s*:`, "g");
      if (repeatedFullNamePattern.test(beforeMatch + match)) {
        debugLog("[Dedupe] Found repeated full name", { 
          original: match, 
          cleaned: cleanName + " :",
          beforeMatch: beforeMatch.substring(Math.max(0, beforeMatch.length - 100))
        });
        return cleanName + " :";
      }
      
      return cleanName + " :";
    });
    
    const repeatedPattern = new RegExp(`(${speakerNamePattern})\\s+\\1(?:\\s+\\1)*\\s*:`, "g");
    result = result.replace(repeatedPattern, (match, name) => {
      const cleaned = deduplicateSpeakerName(name) + " :";
      if (match !== cleaned) {
        debugLog("[Dedupe] Found repeated pattern", { original: match, cleaned });
      }
      return cleaned;
    });
    
    if (result !== beforeIteration) {
      debugLog("[Dedupe] Iteration changed result", { 
        iteration: iterations,
        changed: true,
        resultPreview: result.substring(0, 300)
      });
    }
  }
  
  debugLog("[Dedupe] Deduplication complete", { 
    iterations,
    originalLength: text.length,
    resultLength: result.length,
    resultPreview: result.substring(0, 300)
  });
  
  return result;
}

function cleanTranscriptParagraph(text: string): string {
  let cleaned = text.trim();
  
  cleaned = cleaned.replace(/\([0-9]{1,2}:[0-9]{2}\)\s*/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ");
  
  cleaned = deduplicateRepeatedSpeakerNames(cleaned);
  
  cleaned = cleaned.replace(/Topics?:[A-Za-z\s]*$/i, "");
  cleaned = cleaned.replace(/Topics?:\s*No\s+items\s+found.*$/i, "");
  cleaned = cleaned.replace(/Hungry\s+For\s+More\?.*$/i, "");
  cleaned = cleaned.replace(/Luckily\s+for\s+you.*$/i, "");
  cleaned = cleaned.replace(/Subscribe\s+to\s+our\s+blog.*$/i, "");
  cleaned = cleaned.replace(/Thank\s+You\s+for\s+Subscribing!.*$/i, "");
  cleaned = cleaned.replace(/A\s+confirmation\s+email.*$/i, "");
  // Remove inaudible markers, but DO NOT drop the rest of the paragraph.
  // Example: "[inaudible 00:00:50] (00:50) Hi, everyone." -> "(00:50) Hi, everyone."
  cleaned = cleaned.replace(/\[inaudible[^\]]*\]/gi, " ");
  cleaned = cleaned.replace(/Transcripts\s+Home.*$/i, "");
  cleaned = cleaned.replace(/Read\s+the\s+transcript\s+here.*$/i, "");
  cleaned = cleaned.replace(/.*\s+\|\s+Rev.*$/i, "");
  cleaned = cleaned.replace(/Help\s+Center\s+Developers.*$/i, "");
  cleaned = cleaned.replace(/Contact\s+Support.*$/i, "");
  cleaned = cleaned.replace(/Human-Verified.*$/i, "");
  cleaned = cleaned.replace(/AI\s+Platform\s+Features.*$/i, "");
  cleaned = cleaned.replace(/Premium\s+Tools.*$/i, "");
  cleaned = cleaned.replace(/Industries.*$/i, "");
  cleaned = cleaned.replace(/Resources.*$/i, "");
  cleaned = cleaned.replace(/Blog\s+Home.*$/i, "");
  cleaned = cleaned.replace(/Copyright\s+Disclaimer.*$/i, "");
  cleaned = cleaned.replace(/Under\s+Title\s+17.*$/i, "");
  cleaned = cleaned.replace(/fair\s+use.*$/i, "");
  
  // Re-collapse whitespace after removals
  cleaned = cleaned.replace(/\s+/g, " ");
  
  cleaned = cleaned.replace(/&amp;/g, "&");
  cleaned = cleaned.replace(/&#x27;/g, "'");
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&lt;/g, "<");
  cleaned = cleaned.replace(/&gt;/g, ">");
  
  return cleaned.trim();
}

function extractSpeakerName(speakerLine: string): { fullName: string; fullNameWithoutTimestamp: string; shortNames: string[] } | null {
  // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
  const fullPatternWithTimestamp = new RegExp(`^((${TITLE_PATTERN})?([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+))\\s+\\([0-9]{1,2}:[0-9]{2}\\):`);
  const fullPatternWithoutTimestamp = new RegExp(`^((${TITLE_PATTERN})?([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+))\\s*:`);
  
  let speakerMatch = speakerLine.match(fullPatternWithTimestamp);
  let hasTimestamp = true;
  
  if (!speakerMatch) {
    speakerMatch = speakerLine.match(fullPatternWithoutTimestamp);
    hasTimestamp = false;
  }
  
  if (!speakerMatch) return null;
  
  const fullSpeakerLine = speakerMatch[1].trim();
  const entireMatch = speakerMatch[0];
  
  const titleWithCapture = new RegExp(`^(${TITLE_PATTERN})`);
  const titleMatch = entireMatch.match(titleWithCapture);
  const titlePart = titleMatch ? titleMatch[1].trim() : "";
  
  const namePattern = new RegExp(`(?:${TITLE_PATTERN})?([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)`);
  const nameOnlyMatch = entireMatch.match(namePattern);
  const namePart = nameOnlyMatch ? nameOnlyMatch[1].trim() : "";
  
  if (/^speaker\b/i.test(namePart)) {
    const fullNameWithoutTimestamp = hasTimestamp 
      ? fullSpeakerLine.replace(new RegExp("\\s+\\([0-9]{1,2}:[0-9]{2}\\):\\s*$"), "").trim()
      : fullSpeakerLine.replace(/:\s*$/, "").trim();
    return { 
      fullName: fullSpeakerLine, 
      fullNameWithoutTimestamp: fullNameWithoutTimestamp,
      shortNames: [namePart.replace(/^speaker/i, "Speaker")] 
    };
  }
  
  const nameWords = namePart.split(/\s+/).filter(Boolean);
  if (nameWords.length === 0) return null;
  
  const fullName = fullSpeakerLine;
  // Store only the name part (without title) in fullNameWithoutTimestamp
  const fullNameWithoutTimestamp = namePart;
  const shortNames: string[] = [];
  
  if (nameWords.length >= 2) {
    const firstName = nameWords[0];
    const lastName = nameWords[nameWords.length - 1];
    shortNames.push(firstName);
    shortNames.push(lastName);
    shortNames.push(`${firstName} ${lastName}`);
  } else {
    shortNames.push(nameWords[0]);
  }
  
  return { fullName, fullNameWithoutTimestamp, shortNames };
}

function splitTranscriptWords(text: string): string[] {
  let normalized = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  
  debugLog("[Word Split] splitTranscriptWords called", { 
    textPreview: normalized.substring(0, 200),
    textLength: normalized.length 
  });
  
  const speakerMatchWithTimestamp = normalized.match(
    new RegExp(
      `^((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\)\\s*:\\s*)(.*)$`,
      "i"
    )
  );
  const speakerMatchWithoutTimestamp = normalized.match(
    new RegExp(
      `^((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|Speaker\\s+[0-9]+)\\s*:\\s*)(.*)$`,
      "i"
    )
  );
  
  const speakerMatch = speakerMatchWithTimestamp || speakerMatchWithoutTimestamp;
  
  if (speakerMatch) {
    let fullSpeakerLine = speakerMatch[1].trim();
    // Because TITLE_PATTERN is a CAPTURING group inside speakerMatch[1], the actual content is
    // always the *last* capture group, not index 2.
    const contentPart = speakerMatch[speakerMatch.length - 1]?.trim() || "";
    
    debugLog("[Word Split] Found speaker line", { 
      fullSpeakerLine,
      contentPreview: contentPart.substring(0, 50)
    });
    
    fullSpeakerLine = deduplicateRepeatedSpeakerNames(fullSpeakerLine);
    const cleanSpeakerName = deduplicateSpeakerName(fullSpeakerLine.replace(/:\s*$/, "").trim());
    
    debugLog("[Word Split] After deduplication", { 
      original: speakerMatch[1].trim(),
      deduplicated: cleanSpeakerName
    });
    
    const titleMatch = cleanSpeakerName.match(new RegExp(`^(${TITLE_PATTERN})`, "i"));
    const titlePart = titleMatch ? titleMatch[1].trim() : "";
    
    // IMPORTANT: put Speaker N first, otherwise the "[A-Z][a-z]+" branch will match only "Speaker"
    // and you'll lose the number.
    const namePattern = new RegExp(`(?:${TITLE_PATTERN})?(Speaker\\s+[0-9]+|[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3})`, "i");
    const nameMatch = cleanSpeakerName.match(namePattern);
    const namePart = nameMatch ? nameMatch[1].trim() : "";
    
    const words: string[] = [];
    
    if (titlePart && namePart) {
      words.push(titlePart);
      words.push(namePart + ":");
      debugLog("[Word Split] Split into title and name", { titlePart, namePart: namePart + ":" });
    } else if (namePart) {
      words.push(namePart + ":");
      debugLog("[Word Split] Split into name only", { namePart: namePart + ":" });
    } else {
      words.push(cleanSpeakerName + ":");
      debugLog("[Word Split] Using full speaker line", { fullSpeakerLine: cleanSpeakerName + ":" });
    }
    
    if (contentPart) {
      const contentWords = contentPart.split(/\s+/).filter(Boolean);
      words.push(...contentWords);
      debugLog("[Word Split] Added content words", { contentWordCount: contentWords.length });
    }
    
    debugLog("[Word Split] Final words array", { 
      wordCount: words.length,
      firstWords: words.slice(0, 5)
    });
    
    return words;
  }
  
  return normalized.split(/\s+/).filter(Boolean);
}

function flattenWords(paragraphs: ParsedParagraph[]): string[] {
  return paragraphs.flatMap((p) => p.words);
}

function findParagraphForWord(
  paragraphs: ParsedParagraph[],
  globalWordIndex: number
): TokenPosition {
  let offset = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const p = paragraphs[i];
    if (globalWordIndex < offset + p.words.length) {
      return { wordIndex: globalWordIndex - offset, paragraphIndex: i };
    }
    offset += p.words.length;
  }
  return { wordIndex: 0, paragraphIndex: 0 };
}

const App: React.FC = () => {
  const [rawText, setRawText] = useState("");
  const [parsedParagraphs, setParsedParagraphs] = useState<ParsedParagraph[]>(
    []
  );
  const [words, setWords] = useState<string[]>([]);

  const [wpm, setWpm] = useState(350);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showParagraph, setShowParagraph] = useState(false);
  const [autoContinueParagraphs, setAutoContinueParagraphs] = useState(true);
  const [hasLoadedContent, setHasLoadedContent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  
  const [fontFamily, setFontFamily] = useState("system-ui");
  const [letterSpacing, setLetterSpacing] = useState(5);
  const [pivotColor, setPivotColor] = useState("#ff4e4e");
  const [speakerNames, setSpeakerNames] = useState<Map<string, string>>(new Map());

  const letterSpacingToEm = (value: number): number => {
    return value * 0.015 - 0.05;
  };

  const fontOptions = [
    { value: "system-ui", label: "System UI", example: "The quick brown" },
    { value: "Georgia, serif", label: "Georgia", example: "The quick brown" },
    { value: "'Times New Roman', Times, serif", label: "Times New Roman", example: "The quick brown" },
    { value: "Arial, Helvetica, sans-serif", label: "Arial", example: "The quick brown" },
    { value: "'Courier New', Courier, monospace", label: "Courier New", example: "The quick brown" },
    { value: "Verdana, Geneva, sans-serif", label: "Verdana", example: "The quick brown" },
    { value: "'Trebuchet MS', sans-serif", label: "Trebuchet MS", example: "The quick brown" },
    { value: "'Comic Sans MS', cursive", label: "Comic Sans MS", example: "The quick brown" },
    { value: "'Roboto', sans-serif", label: "Roboto", example: "The quick brown" },
    { value: "'Open Sans', sans-serif", label: "Open Sans", example: "The quick brown" },
  ];

  const fontGridRef = useRef<HTMLDivElement | null>(null);
  const [fontGridCols, setFontGridCols] = useState<number>(5);

  const computeFontGridCols = (containerWidth: number, itemCount: number): number => {
    // For Font Family specifically, we only want:
    // - 5 columns (5x2) on wider widths
    // - 2 columns (2x5) on narrower widths
    // (given the current 10 options)
    const gapPx = 10; // keep in sync with `.font-grid { gap }`
    const minTilePxFor5 = 96; // labels can wrap; keep tiles reasonably sized
    const widthFor5Cols = 5 * minTilePxFor5 + 4 * gapPx;

    if (itemCount % 5 === 0 && containerWidth >= widthFor5Cols) return 5;
    if (itemCount % 2 === 0) return 2;

    // Fallback for unexpected item counts.
    return Math.min(itemCount, 5);
  };

  useEffect(() => {
    if (!showSettings) return;
    const el = fontGridRef.current;
    if (!el) return;
    const itemCount = fontOptions.length;

    const update = () => {
      const nextCols = computeFontGridCols(el.clientWidth, itemCount);
      setFontGridCols((prev) => (prev === nextCols ? prev : nextCols));
    };

    const rafId = window.requestAnimationFrame(() => update());

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [showSettings, fontOptions.length]);

  const timerRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const leftPartRef = useRef<HTMLSpanElement>(null);
  const pivotRef = useRef<HTMLSpanElement>(null);
  const rightPartRef = useRef<HTMLSpanElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wordDisplayRef = useRef<HTMLDivElement>(null);
  const [pivotOffset, setPivotOffset] = useState(0);
  const [layoutTick, setLayoutTick] = useState(0);
  const [wordFontPxOverride, setWordFontPxOverride] = useState<number | null>(null);
  const baseWordFontPxRef = useRef<number>(0);

  const hasContent = words.length > 0;

  const titleWords = [
    "Mr", "Mrs", "Ms", "Miss", "Dr", "Prof", "Professor",
    "Governor", "Mayor", "Senator", "Representative", "Congressman", "Congresswoman",
    "King", "Queen", "Prince", "Princess", "Duke", "Duchess", "Sir", "Madam", "Madame",
    "Lord", "Lady", "President", "Vice President", "Secretary", "General", "Admiral",
    "Colonel", "Major", "Captain", "Lieutenant", "Sergeant", "Chief", "Judge", "Justice",
    "Ambassador", "Minister", "Chancellor", "Premier", "Prime Minister"
  ];

  const isTitleWord = (word: string): boolean => {
    if (!word) return false;
    const normalized = word.replace(/\./g, "").trim().toLowerCase();
    return titleWords.some((t) => t.toLowerCase() === normalized);
  };

  const normalizeNameWord = (word: string): string => {
    // Trim common punctuation so "Doe:" matches "Doe"
    return word
      .replace(/^[^A-Za-z0-9'-]+/, "")
      .replace(/[^A-Za-z0-9'-]+$/, "")
      .trim();
  };

  const getReaderFrameAtIndex = (globalIndex: number): { display: string; advance: number } => {
    const rawWord = words[globalIndex] ?? "";
    if (!rawWord || !parsedParagraphs.length) return { display: rawWord, advance: 1 };

    const pos = findParagraphForWord(parsedParagraphs, globalIndex);
    const paragraph = parsedParagraphs[pos.paragraphIndex];
    const idx = pos.wordIndex;
    const w1 = paragraph.words[idx] ?? "";
    const w2 = paragraph.words[idx + 1] ?? "";

    // Merge known proper names (first + last) into a single reader frame.
    // This affects only the reader window; paragraph context stays as-is.
    if (w1 && w2) {
      const n1 = normalizeNameWord(w1);
      const n2 = normalizeNameWord(w2);

      if (n1 && n2 && !isTitleWord(n1) && !isTitleWord(n2)) {
        const combinedKey = `${n1} ${n2}`;
        if (speakerNames.has(combinedKey)) {
          return { display: `${w1} ${w2}`, advance: 2 };
        }
      }
    }

    return { display: w1 || rawWord, advance: 1 };
  };

  const getPrevReaderIndex = (globalIndex: number): number => {
    // Step back by one token, then snap to the start of a merged-name frame if needed.
    // This ensures rewind never lands on the trailing token of a merged name.
    const candidate = Math.max(globalIndex - 1, 0);
    if (candidate <= 0) return candidate;

    // If candidate is the 2nd token of a merged-name frame that starts at candidate-1,
    // snap back to candidate-1 so the reader displays the whole name.
    const prevFrame = getReaderFrameAtIndex(candidate - 1);
    if (prevFrame.advance === 2) return candidate - 1;

    return candidate;
  };

  const getDisplayWord = (word: string, context?: string, wordIndex?: number, allWords?: string[]): string => {
    if (!word) return word;
    
    const trimmedWord = word.trim();
    if (!trimmedWord) return word;
    
    const originalWord = trimmedWord;
    let displayWord = trimmedWord;
    
    // Check if this is part of a speaker line (before the colon)
    // We need to find where the colon is to know if we're in the speaker line part
    let isPartOfSpeakerLine = false;
    if (context && wordIndex !== undefined && allWords) {
      // Find the colon in the words array (word that ends with ":")
      const colonIndex = allWords.findIndex(w => w.trim().endsWith(":"));
      if (colonIndex >= 0 && wordIndex <= colonIndex && wordIndex < 5) {
        // Check if the context starts with a speaker pattern
        isPartOfSpeakerLine = context.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|Speaker\\s+[0-9]+)\\s*:`, "i")) !== null;
      }
    }
    
    // Only apply speaker name expansion if we're in a speaker line (before the colon)
    if (isPartOfSpeakerLine && wordIndex !== undefined && allWords) {
      const prevWord = wordIndex > 0 ? allWords[wordIndex - 1]?.trim() || "" : "";
      const nextWord = wordIndex < allWords.length - 1 ? allWords[wordIndex + 1]?.trim() || "" : "";
      
      // Handle "Speaker X" pattern - only expand "Speaker" if next word is a number
      if (trimmedWord.toLowerCase() === "speaker" && nextWord && /^\d+$/.test(nextWord)) {
        // This is "Speaker" followed by a number - expand to "Speaker X"
        const speakerNum = nextWord;
        const fullSpeakerName = speakerNames.get(`Speaker ${speakerNum}`) || `Speaker ${speakerNum}`;
        displayWord = fullSpeakerName;
        debugLog("[Display Word] Speaker pattern match", { 
          originalWord: trimmedWord,
          nextWord: speakerNum,
          displayWord
        });
        return displayWord;
      }
      
      // Don't expand if this is a number that follows "Speaker" - it's already handled above
      if (/^\d+$/.test(trimmedWord) && prevWord && prevWord.toLowerCase() === "speaker") {
        // This number is already part of the "Speaker X" expansion
        return trimmedWord;
      }
      
      // Don't expand "Speaker" if it's not followed by a number
      if (trimmedWord.toLowerCase() === "speaker" && (!nextWord || !/^\d+$/.test(nextWord))) {
        return trimmedWord;
      }
      
      // Check if previous word or current word is a title - titles should stay separate
      const prevWordIsTitle = isTitleWord(prevWord);
      const currentWordIsTitle = isTitleWord(trimmedWord.replace(/:/g, ""));
      
      // Check for two-word combinations (e.g., "Jane Doe") - but NOT if prev word is a title
      if (wordIndex > 0 && !prevWordIsTitle && !currentWordIsTitle) {
        const combined = `${prevWord} ${trimmedWord}`;
        const combinedFullName = speakerNames.get(combined.replace(/:/g, "").trim());
        if (combinedFullName) {
          const prevDisplay = getDisplayWord(prevWord, context, wordIndex - 1, allWords);
          if (prevDisplay !== combinedFullName) {
            displayWord = combinedFullName;
            debugLog("[Display Word] Combined word match", { 
              prevWord, 
              currentWord: trimmedWord, 
              combined, 
              displayWord 
            });
            return displayWord;
          }
        }
      }
      
      // Check for single word matches (only in speaker lines) - but NOT if it's a title
      if (displayWord === trimmedWord && speakerNames.size > 0 && !prevWordIsTitle && !currentWordIsTitle) {
        const wordWithoutColon = trimmedWord.replace(/:/g, "").trim();
        const fullName = speakerNames.get(wordWithoutColon);
        if (fullName && trimmedWord !== fullName && trimmedWord !== fullName + ":") {
          displayWord = fullName + (trimmedWord.endsWith(":") ? ":" : "");
          debugLog("[Display Word] Single word match in speaker line", { 
            originalWord: trimmedWord, 
            displayWord,
            wordIndex
          });
        }
      }
    }
    
    if (displayWord !== originalWord) {
      debugLog("[Display Word] Word replaced", { 
        original: originalWord, 
        display: displayWord,
        wordIndex,
        contextPreview: context?.substring(0, 100)
      });
    }
    
    return displayWord;
  };

  const currentWord = useMemo(
    () => (hasContent ? words[currentIndex] : ""),
    [hasContent, words, currentIndex]
  );

  const currentWordDisplay = useMemo(() => {
    if (!hasContent || !currentWord) return "";
    return getReaderFrameAtIndex(currentIndex).display;
  }, [currentWord, speakerNames, parsedParagraphs, currentIndex, hasContent, words]);

  const pivotIndex = useMemo(
    () => (currentWordDisplay ? findPivotIndexIgnoringSpaces(currentWordDisplay) : 0),
    [currentWordDisplay]
  );

  const pivotParts = useMemo(() => {
    if (!currentWordDisplay) return { left: "", pivot: "", right: "" };
    const idx = Math.min(Math.max(pivotIndex, 0), currentWordDisplay.length - 1);
    return {
      left: currentWordDisplay.slice(0, idx),
      pivot: currentWordDisplay.charAt(idx),
      right: currentWordDisplay.slice(idx + 1)
    };
  }, [currentWordDisplay, pivotIndex]);

  const currentParagraphInfo = useMemo(() => {
    if (!parsedParagraphs.length || !hasContent) return null;
    const pos = findParagraphForWord(parsedParagraphs, currentIndex);
    const paragraph = parsedParagraphs[pos.paragraphIndex];
    // Keep paragraph context as-is (cleaned/junk-removed), no name merging or replacements.
    const beforeWords = paragraph.words.slice(0, pos.wordIndex);
    const activeWord = paragraph.words[pos.wordIndex] ?? "";
    const afterWords = paragraph.words.slice(pos.wordIndex + 1);
    return {
      paragraphIndex: pos.paragraphIndex,
      before: beforeWords.join(" "),
      active: activeWord,
      after: afterWords.join(" ")
    };
  }, [parsedParagraphs, hasContent, currentIndex]);

  const paragraphStartOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const p of parsedParagraphs) {
      offsets.push(offset);
      offset += p.words.length;
    }
    return offsets;
  }, [parsedParagraphs]);

  const intervalMs = useMemo(() => {
    if (wpm <= 0) return 0;
    return (60_000 / wpm) | 0;
  }, [wpm]);

  useEffect(() => {
    if (!isPlaying || !hasContent || intervalMs <= 0) {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    lastTickRef.current = performance.now();
    timerRef.current = window.setInterval(() => {
      setCurrentIndex((prev) => {
        if (prev >= words.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        const advance = getReaderFrameAtIndex(prev).advance;

        if (!autoContinueParagraphs && parsedParagraphs.length) {
          const pos = findParagraphForWord(parsedParagraphs, prev);
          const start = paragraphStartOffsets[pos.paragraphIndex] ?? 0;
          const end = start + parsedParagraphs[pos.paragraphIndex].words.length - 1;
          // Pause after the last word/frame of the paragraph has been shown.
          if (prev + advance - 1 >= end && prev < words.length - 1) {
            setIsPlaying(false);
            return prev;
          }
        }

        return Math.min(prev + advance, words.length - 1);
      });
    }, intervalMs);

    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [
    isPlaying,
    hasContent,
    intervalMs,
    words.length,
    parsedParagraphs,
    speakerNames,
    words,
    autoContinueParagraphs,
    paragraphStartOffsets
  ]);

  useEffect(() => {
    if (!hasContent || !leftPartRef.current || !pivotRef.current || !rightPartRef.current || !wordDisplayRef.current) {
      setPivotOffset(0);
      setWordFontPxOverride(null);
      return;
    }

    const leftWidth = leftPartRef.current.offsetWidth;
    const pivotWidth = pivotRef.current.offsetWidth;
    const rightWidth = rightPartRef.current.offsetWidth;

    const pivotCenterX = leftWidth + pivotWidth / 2;
    const containerWidth = wordDisplayRef.current.clientWidth;
    const desiredCenterX = containerWidth / 2;

    // The word line is centered by flex layout, so its left edge starts at:
    // (containerWidth - wordWidth) / 2. We must include that in the pivot position.
    const wordWidth = leftWidth + pivotWidth + rightWidth;
    const wordLineStartX = (containerWidth - wordWidth) / 2;
    const currentPivotX = wordLineStartX + pivotCenterX;

    // Keep the pivot anchored to the center of the Reader window, even for long words.
    const offset = desiredCenterX - currentPivotX;
    setPivotOffset(offset);

    // Auto font-size reduction for long words (min 22px) based on available width.
    // Most words should keep the default CSS font size (clamp).
    const availableWidth = Math.max(0, containerWidth - 24); // small padding for safety

    if (!baseWordFontPxRef.current || wordFontPxOverride === null) {
      const computed = window.getComputedStyle(wordDisplayRef.current).fontSize;
      const parsed = Number.parseFloat(computed);
      if (Number.isFinite(parsed) && parsed > 0) baseWordFontPxRef.current = parsed;
    }

    const basePx = baseWordFontPxRef.current || 0;
    if (!basePx || wordWidth <= availableWidth) {
      if (wordFontPxOverride !== null) setWordFontPxOverride(null);
      return;
    }

    const scaled = Math.max(22, basePx * (availableWidth / wordWidth));
    const next = Math.min(basePx, scaled);
    if (wordFontPxOverride === null || Math.abs(wordFontPxOverride - next) > 0.5) {
      setWordFontPxOverride(next);
    }
  }, [currentWordDisplay, pivotParts, hasContent, letterSpacing, fontFamily, layoutTick, wordFontPxOverride]);

  useEffect(() => {
    const onResize = () => {
      setWordFontPxOverride(null);
      setLayoutTick((t) => t + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (isPlaying && hasContent && intervalMs > 0) {
      setIsPlaying(false);
    }
  }, [intervalMs]);

  const resetFromText = (text: string) => {
    const normalizedInput = normalizeForParsing(text);
    const nameMap = new Map<string, string>();
    const stopKeys = new Set([
      "the","a","an","if","and","or","but","to","of","in","on","for","with","at","from","by","as","this","that","these","those"
    ]);
    
    debugLog("[Speaker Names] Extracting from original text", { textLength: normalizedInput.length });
    
    // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
    const speakerLinePatternWithTimestamp = new RegExp(
      `((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\\)\\s*:\\s*)`,
      "g"
    );
    const allSpeakerMatches = normalizedInput.matchAll(speakerLinePatternWithTimestamp);
    
    for (const match of allSpeakerMatches) {
      const speakerLine = match[1].trim();
      debugLog("[Speaker Names] Found speaker line in original text", { speakerLine });
      
      const speakerInfo = extractSpeakerName(speakerLine);
      if (speakerInfo) {
        debugLog("[Speaker Names] Extracted speaker info", {
          fullName: speakerInfo.fullName,
          fullNameWithoutTimestamp: speakerInfo.fullNameWithoutTimestamp,
          shortNames: speakerInfo.shortNames
        });
        speakerInfo.shortNames.forEach(shortName => {
          const key = shortName.trim();
          const keyLower = key.toLowerCase();
          if (!key) return;
          if (stopKeys.has(keyLower)) return;
          const existingFullName = nameMap.get(shortName);
          if (!existingFullName || speakerInfo.fullNameWithoutTimestamp.length > existingFullName.length) {
            nameMap.set(shortName, speakerInfo.fullNameWithoutTimestamp);
          }
        });
        nameMap.set(speakerInfo.fullName, speakerInfo.fullNameWithoutTimestamp);
        nameMap.set(speakerInfo.fullNameWithoutTimestamp, speakerInfo.fullNameWithoutTimestamp);
        if (speakerInfo.fullName.includes("Speaker")) {
          const speakerNumMatch = speakerInfo.fullName.match(/Speaker\s+(\d+)/i);
          if (speakerNumMatch) {
            const num = speakerNumMatch[1];
            nameMap.set(num, speakerInfo.fullNameWithoutTimestamp);
          }
        }
      }
    }
    
    const normalized = normalizeText(normalizedInput);
    
    debugLog("[Speaker Names] Also checking cleaned paragraphs", { paragraphCount: normalized.length });
    
    normalized.forEach((paragraph, index) => {
      const rawText = paragraph.raw;
      // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
      const speakerPattern2 = new RegExp(`^((${TITLE_PATTERN})?([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+))\\s*:`);
      
      const speakerMatch = rawText.match(speakerPattern2);
      
      if (speakerMatch && index < 10) {
        debugLog("[Speaker Names] Found speaker in cleaned text", { 
          index,
          match: speakerMatch[0],
          rawPreview: rawText.substring(0, 100)
        });
        const speakerInfo = extractSpeakerName(rawText);
        if (speakerInfo) {
          debugLog("[Speaker Names] Extracted from cleaned text", {
            fullName: speakerInfo.fullName,
            fullNameWithoutTimestamp: speakerInfo.fullNameWithoutTimestamp,
            shortNames: speakerInfo.shortNames
          });
          speakerInfo.shortNames.forEach(shortName => {
            const key = shortName.trim();
            const keyLower = key.toLowerCase();
            if (!key) return;
            if (stopKeys.has(keyLower)) return;
            const existingFullName = nameMap.get(shortName);
            if (!existingFullName || speakerInfo.fullNameWithoutTimestamp.length > existingFullName.length) {
              nameMap.set(shortName, speakerInfo.fullNameWithoutTimestamp);
            }
          });
          nameMap.set(speakerInfo.fullName, speakerInfo.fullNameWithoutTimestamp);
          nameMap.set(speakerInfo.fullNameWithoutTimestamp, speakerInfo.fullNameWithoutTimestamp);
          if (speakerInfo.fullName.includes("Speaker")) {
            const speakerNumMatch = speakerInfo.fullName.match(/Speaker\s+(\d+)/i);
            if (speakerNumMatch) {
              const num = speakerNumMatch[1];
              nameMap.set(num, speakerInfo.fullNameWithoutTimestamp);
            }
          }
        }
      }
    });
    
    debugLog("[Speaker Names] Final extracted speaker names", {
      nameMapSize: nameMap.size,
      names: Array.from(nameMap.entries())
    });
    
    setSpeakerNames(nameMap);
    const allWords = flattenWords(normalized);
    setParsedParagraphs(normalized);
    setWords(allWords);
    setCurrentIndex(0);
    setIsPlaying(false);
    setHasLoadedContent(true);
  };

  const handleNewInput = () => {
    setRawText("");
    setParsedParagraphs([]);
    setWords([]);
    setCurrentIndex(0);
    setIsPlaying(false);
    setHasLoadedContent(false);
    setIsLoadingPdf(false);
    setPdfError(null);
    setIsLoadingUrl(false);
    setUrlError(null);
    setSpeakerNames(new Map());
  };

  const handlePlayPause = () => {
    if (!hasContent) return;
    // If we are paused at the end of a paragraph, advance once before resuming so we don't
    // immediately pause again on the same last word.
    if (!isPlaying && !autoContinueParagraphs && parsedParagraphs.length) {
      const pos = findParagraphForWord(parsedParagraphs, currentIndex);
      const start = paragraphStartOffsets[pos.paragraphIndex] ?? 0;
      const end = start + parsedParagraphs[pos.paragraphIndex].words.length - 1;
      const advance = getReaderFrameAtIndex(currentIndex).advance;
      if (currentIndex + advance - 1 >= end && currentIndex < words.length - 1) {
        setCurrentIndex(Math.min(currentIndex + advance, words.length - 1));
      }
    }

    setIsPlaying((prev) => {
      const next = !prev;
      return next;
    });
  };

  const handleRestart = () => {
    if (!hasContent) return;
    setCurrentIndex(0);
  };

  const handleStep = (direction: -1 | 1) => {
    if (!hasContent) return;
    setCurrentIndex((prev) => {
      if (direction === -1) {
        return Math.min(Math.max(getPrevReaderIndex(prev), 0), words.length - 1);
      }
      const advance = getReaderFrameAtIndex(prev).advance;
      return Math.min(Math.max(prev + advance, 0), words.length - 1);
    });
  };

  const handleParagraphJump = (delta: -1 | 1) => {
    if (!parsedParagraphs.length || !hasContent) return;
    const pos = findParagraphForWord(parsedParagraphs, currentIndex);
    const nextParagraphIndex = Math.min(
      Math.max(pos.paragraphIndex + delta, 0),
      parsedParagraphs.length - 1
    );

    let offset = 0;
    for (let i = 0; i < nextParagraphIndex; i += 1) {
      offset += parsedParagraphs[i].words.length;
    }
    setCurrentIndex(offset);
  };

  const handleRawTextBlur = () => {
    if (!rawText.trim()) {
      setParsedParagraphs([]);
      setWords([]);
      setCurrentIndex(0);
      setIsPlaying(false);
      return;
    }
    const urlOnly = parseUrlOnlyInput(rawText);
    if (urlOnly) {
      setRawText(urlOnly);
      if (urlError) setUrlError(null);
      if (!isLoadingUrl) void handleUrlSubmit(urlOnly);
      return;
    }
    resetFromText(rawText);
  };

  const handleRawTextPaste = () => {
    setTimeout(() => {
      const currentText = textareaRef.current?.value || rawText;
      if (!currentText.trim()) {
        setParsedParagraphs([]);
        setWords([]);
        setCurrentIndex(0);
        setIsPlaying(false);
        return;
      }
      const urlOnly = parseUrlOnlyInput(currentText);
      if (urlOnly) {
        setRawText(urlOnly);
        if (urlError) setUrlError(null);
        if (!isLoadingUrl) void handleUrlSubmit(urlOnly);
        return;
      }
      resetFromText(currentText);
    }, 0);
  };

  const isJunkText = (text: string): boolean => {
    const trimmed = text.trim();
    
    if (trimmed.length < 3) return true;
    
    if (trimmed.match(/\([0-9]{1,2}:[0-9]{2}\):/) || 
        trimmed.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"))) {
      return false;
    }
    
    const junkPatterns = [
      /^copyright\s+disclaimer/i,
      /^share\s+this\s+post/i,
      /^thank\s+you\s+for\s+subscribing/i,
      /^thank\s+you\s+for\s+subscribing!/i,
      /^a\s+confirmation\s+email\s+is\s+on\s+its?\s+way/i,
      /^confirmation\s+email/i,
      /^hungry\s+for\s+more/i,
      /^hungry\s+for\s+more\?/i,
      /^subscribe\s+to\s+our\s+blog/i,
      /^subscribe\s+to\s+our\s+blog\s+today/i,
      /^luckily\s+for\s+you/i,
      /^we\s+deliver/i,
      /^keep\s+reading/i,
      /^read\s+trending\s+articles/i,
      /^help\s+center/i,
      /^contact\s+support/i,
      /^contact\s+support\s*\|/i,
      /^log\s+in$/i,
      /^get\s+started$/i,
      /^request\s+a\s+demo$/i,
      /^product\s+back\s+to\s+menu/i,
      /^industries\s+back\s+to\s+menu/i,
      /^resources\s+back\s+to\s+menu/i,
      /^about\s+rev$/i,
      /^pricing$/i,
      /^legal\s+security\s+terms/i,
      /^privacy\s+policy/i,
      /^sitemap$/i,
      /^reviews$/i,
      /^©\s*rev\.com/i,
      /^topics?:$/i,
      /^topics?:[A-Za-z\s]*$/i,
      /^topics?:\s*no\s+items\s+found/i,
      /^transcripts\s+home/i,
      /^transcripts\s+home\s+news/i,
      /^read\s+the\s+transcript\s+here/i,
      /^linkedin\s*$/i,
      /^facebook\s*$/i,
      /^x\s+logo\s*$/i,
      /^pinterest\s*$/i,
      /^reddit\s+logo\s*$/i,
      /^email\s*$/i,
      /^services\s*$/i,
      /^integrations\s*$/i,
      /^blog\s*$/i,
      /^blog\s+home/i,
      /^developers\s*$/i,
      /^careers\s*$/i,
      /^freelancers\s*$/i,
      /^press\s*$/i,
      /^support\s*$/i,
      /^youtube\s*$/i,
      /^instagram\s*$/i,
      /^spotify\s*$/i,
      /^apple\s*$/i,
      /^the\s+rev\s+logo\s+icon\.\s*$/i,
      /^under\s+title\s+17/i,
      /^fair\s+use/i,
      /^fair\s+use\s+is\s+permitted/i,
      /^allowance\s+is\s+made/i,
      /^copyright\s+statute/i,
      /^might\s+otherwise\s+be\s+infringing/i,
      /^rev's\s+logo$/i,
      /^human-verified/i,
      /^human-verified\s+&/i,
      /^human\s+transcription\s+expert/i,
      /^ai\s+platform\s+features$/i,
      /^premium\s+tools/i,
      /^premium\s+tools\.\s+premium\s+perks/i,
      /^multi-file\s+analysis$/i,
      /^subscribe\s+to\s+the\s+rev\s+blog/i,
      /^sign\s+up\s+to\s+get/i,
      /^content\s+delivered\s+straight/i,
      /^\[inaudible/i,
      /^.*\s+\|\s+rev$/i,
      /^help\s+center\s+developers\s+security/i,
      /^human\s+transcription\s+expert\s+human\s+transcription/i,
      /^human\s+captions/i,
      /^court\s+reporting\s+self-service/i,
      /^global\s+subtitles/i,
      /^view\s+all\s+pay-per-minute\s+services/i,
      /^transcription,\s+captions/i,
      /^ai\s+transcription/i,
      /^ai\s+notetaker/i,
      /^ai\s+captions/i,
      /^rev\s+mobile\s+app/i,
      /^view\s+all\s+ai\s+features/i,
      /^save\s+on\s+human\s+transcription/i,
      /^spot\s+inconsistencies/i,
      /^industries\s+legal/i,
      /^criminal\s+prosecution/i,
      /^eliminate\s+evidence\s+backlogs/i,
      /^criminal\s+defense/i,
      /^cut\s+hours\s+of\s+review/i,
      /^investigators/i,
      /^turn\s+piles\s+of\s+evidence/i,
      /^civil\s+law/i,
      /^build\s+stronger\s+cases/i,
      /^court\s+reporting\s+agencies/i,
      /^a\s+trusted\s+partner/i,
      /^smartdepo/i,
      /^ai\s+summaries/i,
      /^resources\s+blog/i,
      /^expert\s+insights/i,
      /^latest\s+news\s+about\s+rev/i,
      /^reports\s+&\s+guides/i,
      /^whitepapers/i,
      /^learning\s+center/i,
      /^guides\s+and\s+tutorials/i,
      /^transcript\s+library/i,
      /^free\s+transcripts/i,
      /^case\s+studies/i,
      /^discover\s+how\s+rev/i,
      /^trusted\s+feedback/i,
      /^the\s+rough\s+draft/i,
      /^where\s+journalists/i,
      /^partners/i,
      /^discover\s+our\s+bar\s+association/i,
      /^we're\s+hiring/i,
      /^ambitious\s+team\s+members/i,
      /^how\s+law\s+enforcement/i,
      /^court\s+hearing\s+types/i,
      /^state\s+bar\s+of\s+texas/i,
      /^legal\s+professionals\s+are\s+burned\s+out/i,
      /^transcription\s+closed\s+captions/i,
      /^accessibility\s+technology/i,
      /^thank\s+you!\s+your\s+submission/i,
      /^oops!\s+something\s+went\s+wrong/i,
      /^2024\s+election/i,
      /^ai\s+&\s+speech\s+recognition/i,
      /^artificial\s+intelligence/i,
      /^automated\s+transcription/i,
      /^congressional\s+testimony/i,
      /^customer\s+features/i,
      /^historical\s+speeches/i,
      /^how-to\s+guides/i,
      /^rev\s+spotlight/i,
      /^speech\s+to\s+text\s+technology/i,
      /^surveys\s+and\s+data/i,
      /^video\s+editing/i,
      /^transcripts\s+home\s+news$/i,
      /^keep\s+reading$/i,
      /^ny\s+state\s+of\s+the\s+state/i,
      /^supreme\s+court\s+hearing/i,
      /^nurse\s+strike/i,
      /^u\.n\.\s+humanitarian/i,
      /^subscribe\s+to\s+the\s+rev\s+blog/i,
      /^sign\s+up\s+to\s+get/i,
      /^the\s+rev\s+logo/i
    ];
    
    if (junkPatterns.some(pattern => pattern.test(trimmed))) {
      return true;
    }
    
    if (trimmed.match(/^topics?:[A-Za-z\s]+$/i)) {
      return true;
    }
    
    if (trimmed.match(/^transcripts\s+home\s+news/i)) {
      return true;
    }
    
    if (trimmed.includes("&amp;") || trimmed.includes("&#x27;") || trimmed.includes("&#39;")) {
      if (!trimmed.match(/\([0-9]{1,2}:[0-9]{2}\):/) && !trimmed.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"))) {
        return true;
      }
    }
    
    if (trimmed.match(/^\d+\(\d{3}\)\s+\d{3}-\d{4}/)) {
      return true;
    }
    
    if (trimmed.match(/^view\s+all/i) && trimmed.length < 50) {
      return true;
    }
    
    if (trimmed.match(/^share\s+this\s+post\s+topics?:/i)) {
      return true;
    }
    
    if (trimmed.match(/^topics?:\s*no\s+items\s+found\.\s*hungry\s+for\s+more/i)) {
      return true;
    }
    
    if (trimmed.match(/^keep\s+reading/i) && trimmed.length < 100) {
      return true;
    }
    
    if (trimmed.length < 3) {
      return true;
    }
    
    if (trimmed.length < 10 && !trimmed.match(/\([0-9:]+\)/) && !trimmed.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"))) {
      const hasPunctuation = /[.!?]/.test(trimmed);
      const hasCapitalLetter = /^[A-Z]/.test(trimmed);
      if (!hasPunctuation && !hasCapitalLetter) {
        return true;
      }
    }
    
    return false;
  };

  const isTranscriptLine = (text: string): boolean => {
    const trimmed = text.trim();
    const transcriptPatterns = [
      new RegExp(`^${TITLE_PATTERN}(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3})\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"),
      /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s+\([0-9]{1,2}:[0-9]{2}\):/,
      /^[A-Z][a-z]+\s+\([0-9]{1,2}:[0-9]{2}\):/,
      /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s*\([0-9]{1,2}:[0-9]{2}\):/,
      /^Speaker\s+[0-9]+\s+\([0-9]{1,2}:[0-9]{2}\):/i
    ];
    return transcriptPatterns.some(pattern => pattern.test(trimmed));
  };

  const splitTranscriptBySpeakers = (text: string): string[] => {
    debugLog("[URL Parse] splitTranscriptBySpeakers called", { textLength: text.length });
    const paragraphs: string[] = [];

    // Split by speaker marker positions instead of relying on newlines.
    // Some pages collapse line breaks in textContent, causing speaker lines to appear mid-line.
    // IMPORTANT: avoid /i here; [A-Z] becomes meaningless and words like "the"/"if" start matching.
    const speakerMarker = new RegExp(
      `((${TITLE_PATTERN})?(?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}|[Ss]peaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):\\s*)`,
      "g"
    );

    const matches = Array.from(text.matchAll(speakerMarker)).filter((m) => m.index !== undefined) as Array<
      RegExpMatchArray & { index: number }
    >;

    const pushClean = (rawPara: string) => {
      const cleaned = cleanTranscriptParagraph(rawPara);
      if (cleaned && cleaned.length > 0) paragraphs.push(cleaned);
    };

    const getSpeakerKeyFromMarker = (markerText: string): string | null => {
      const trimmed = markerText.trim();
      const m = trimmed.match(
        new RegExp(
          `^(?:${TITLE_PATTERN})?((?:[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3})|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`,
          "i"
        )
      );
      return m ? m[1].trim() : null;
    };

    const cleanContinuationText = (t: string): string => {
      // If a paragraph is interrupted by "Same Speaker (mm:ss): …", remove the ellipsis marker.
      return t
        .replace(/^[\u2026…]+/g, "") // unicode ellipsis
        .replace(/^\.{3,}/g, "")    // "..."
        .trim();
    };

    if (matches.length === 0) {
      // Fallback: no speaker markers found, treat as plain text.
      const cleaned = cleanTranscriptParagraph(text);
      return cleaned ? [cleaned] : [];
    }

    // Anything before the first speaker marker should be its own paragraph(s), if non-junk.
    const prelude = text.slice(0, matches[0].index).trim();
    if (prelude && !isJunkText(prelude)) {
      // Preserve existing paragraph breaks if present; otherwise keep as a single paragraph.
      const preParas = prelude.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      if (preParas.length) preParas.forEach(pushClean);
      else pushClean(prelude);
    }

    // Build paragraphs while tracking the active speaker, so repeated markers from the same
    // speaker do NOT create new paragraphs (they get merged as continuation).
    let currentRaw = "";
    let activeSpeakerKey: string | null = null;

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i < matches.length - 1 ? matches[i + 1].index : text.length;

      const markerText = matches[i][0] || "";
      const speakerKey = getSpeakerKeyFromMarker(markerText);

      const segment = text.slice(start, end).trim();
      if (!segment) continue;
      if (isJunkText(segment)) continue;

      const afterMarker = segment.slice(markerText.length).trimStart();

      if (speakerKey && activeSpeakerKey && speakerKey.toLowerCase() === activeSpeakerKey.toLowerCase()) {
        // Same speaker as current paragraph: strip the repeated marker and append continuation.
        const continuation = cleanContinuationText(afterMarker);
        if (continuation) {
          currentRaw = (currentRaw ? `${currentRaw} ${continuation}` : continuation).trim();
        }
        continue;
      }

      // New speaker (or unknown): flush previous paragraph and start a new one.
      if (currentRaw) pushClean(currentRaw);
      activeSpeakerKey = speakerKey;
      currentRaw = afterMarker ? `${markerText.trim()} ${afterMarker}`.trim() : markerText.trim();
    }

    if (currentRaw) pushClean(currentRaw);

    debugLog("[URL Parse] Paragraphs collected from transcript split", {
      paragraphCount: paragraphs.length,
    });
    
    const filtered = paragraphs.filter(p => {
      const trimmed = p.trim();
      if (trimmed.length === 0) return false;
      const hasTranscriptMarker = trimmed.match(/\([0-9]{1,2}:[0-9]{2}\):/) || 
                                  trimmed.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"));
      if (hasTranscriptMarker) {
        return true;
      }
      if (isJunkText(trimmed)) {
        return false;
      }
      return trimmed.length > 5;
    });
    
    debugLog("[URL Parse] Transcript paragraphs filtered", { 
      originalCount: paragraphs.length,
      filteredCount: filtered.length 
    });
    
    return filtered;
  };

  const parseHtmlToText = (html: string): string => {
      debugLog("[URL Parse] parseHtmlToText called", { 
        htmlLength: html.length,
        htmlFirstChars: html.substring(0, 200)
      });
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const bodyText = doc.body?.textContent || "";
      const bodyTimestamps = bodyText.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
      debugLog("[URL Parse] HTML parsed into DOM", { 
        bodyTextLength: bodyText.length,
        bodyTextPreview: bodyText.substring(0, 300),
        hasBody: !!doc.body,
        title: doc.title || "no title",
        bodyTimestampCount: bodyTimestamps ? bodyTimestamps.length : 0,
        bodyTimestampsSample: bodyTimestamps ? bodyTimestamps.slice(0, 10) : []
      });
      
      const elementsToRemove = doc.querySelectorAll(
        "script, style, noscript, iframe, embed, object, svg, canvas, " +
        "nav, header, footer, aside, " +
        ".nav, .navigation, .menu, .sidebar, .sidebar-content, " +
        ".advertisement, .ads, .ad, [class*='ad-'], [id*='ad-'], " +
        ".social, .share, .comments, .comment-section, " +
        ".cookie, .cookie-banner, .newsletter, .subscribe, " +
        ".footer, .header, .site-header, .site-footer, " +
        "[class*='footer'], [class*='header'], [id*='footer'], [id*='header'], " +
        ".breadcrumb, .breadcrumbs, .related, .related-posts, " +
        ".tags, .categories, .meta, .post-meta, " +
        "form, button, input, select, textarea, " +
        "[class*='product'], [class*='industries'], [class*='resources'], " +
        "[class*='help-center'], [class*='contact'], [class*='login'], " +
        "[class*='get-started'], [class*='request-demo'], " +
        "[class*='human-verified'], [class*='ai-platform'], " +
        "[class*='premium-tools'], [class*='multi-file'], " +
        "[class*='transcripts-home'], " +
        "a[href*='#'], a[href*='javascript']"
      );
      debugLog("[URL Parse] Elements to remove identified", { 
        count: elementsToRemove.length 
      });
      
      const timestampsBeforeRemoval = doc.body?.textContent?.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
      debugLog("[URL Parse] Timestamps before removing elements", {
        count: timestampsBeforeRemoval ? timestampsBeforeRemoval.length : 0,
        sample: timestampsBeforeRemoval ? timestampsBeforeRemoval.slice(0, 10) : []
      });
      
      elementsToRemove.forEach((el) => {
        const elText = el.textContent || "";
        const elTimestamps = elText.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
        const hasTranscriptContent = elTimestamps && elTimestamps.length >= 2;
        const hasMainContentId = el.id === "main-content" || el.id === "transcript-content" || el.id === "content";
        
        if (hasTranscriptContent || hasMainContentId) {
          debugLog("[URL Parse] PRESERVING element with transcript content", {
            tagName: el.tagName,
            className: el.className || "none",
            id: el.id || "none",
            timestampCount: elTimestamps ? elTimestamps.length : 0,
            timestamps: elTimestamps ? elTimestamps.slice(0, 5) : [],
            textPreview: elText.substring(0, 300),
            reason: hasTranscriptContent ? "has transcript timestamps" : "has main content ID"
          });
          return;
        }
        
        if (elTimestamps && elTimestamps.length > 0) {
          debugLog("[URL Parse] Removing element with timestamps (but < 2, so likely not transcript)", {
            tagName: el.tagName,
            className: el.className || "none",
            id: el.id || "none",
            timestampCount: elTimestamps.length,
            timestamps: elTimestamps.slice(0, 5),
            textPreview: elText.substring(0, 200)
          });
        }
        el.remove();
      });
      
      const timestampsAfterRemoval = doc.body?.textContent?.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
      debugLog("[URL Parse] Timestamps after removing elements", {
        count: timestampsAfterRemoval ? timestampsAfterRemoval.length : 0,
        sample: timestampsAfterRemoval ? timestampsAfterRemoval.slice(0, 10) : []
      });
      
      const textNodesToClean = doc.createTreeWalker(
        doc.body,
        NodeFilter.SHOW_TEXT,
        null
      );
      
      const textNodes: Text[] = [];
      let node;
      while (node = textNodesToClean.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodes.push(node as Text);
        }
      }
      
      textNodes.forEach(textNode => {
        let text = textNode.textContent || "";
        if (text.includes("&amp;") || text.includes("&#x27;") || text.includes("&#39;")) {
          text = text.replace(/&amp;/g, "&");
          text = text.replace(/&#x27;/g, "'");
          text = text.replace(/&#39;/g, "'");
          text = text.replace(/&quot;/g, '"');
          textNode.textContent = text;
        }
      });
      
      let transcriptContainer: Element | null = null;
      
      const transcriptSelectors = [
        "#main-content",
        "#transcript-content",
        "#content",
        "[class*='transcript']",
        "[id*='transcript']",
        "[class*='content']",
        "article",
        "main",
        "[role='main']",
        ".article",
        ".post",
        ".entry",
        ".story"
      ];
      
      debugLog("[URL Parse] Searching for transcript container");
      debugLog("[URL Parse] Body text sample (first 2000 chars):", bodyText.substring(0, 2000));
      debugLog("[URL Parse] Body text sample (last 2000 chars):", bodyText.substring(Math.max(0, bodyText.length - 2000)));
      
      for (const selector of transcriptSelectors) {
        const found = doc.querySelector(selector);
        if (found) {
          const text = found.textContent || "";
          const firstLine = text.split('\n')[0]?.trim() || "";
          const hasTranscriptLine = isTranscriptLine(firstLine);
          const hasTranscriptPattern = text.match(new RegExp(`(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+\\s+)\\([0-9]{1,2}:[0-9]{2}\\):`, "i"));
          const hasTimestamp = text.match(/\([0-9]{1,2}:[0-9]{2}\):/);
          const timestampMatches = text.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
          
          debugLog("[URL Parse] Checking selector", { 
            selector, 
            found: !!found,
            textLength: text.length,
            textPreview: text.substring(0, 500),
            firstLine: firstLine,
            hasTranscriptLine,
            hasTranscriptPattern: !!hasTranscriptPattern,
            hasTimestamp: !!hasTimestamp,
            timestampMatches: timestampMatches,
            timestampCount: timestampMatches ? timestampMatches.length : 0,
            elementTagName: found.tagName,
            elementClassName: found.className,
            elementId: found.id
          });
          
          if (hasTranscriptLine || hasTranscriptPattern || hasTimestamp) {
            transcriptContainer = found;
            debugLog("[URL Parse] Transcript container found", { 
              selector,
              textLength: text.length,
              timestampCount: timestampMatches ? timestampMatches.length : 0
            });
            break;
          }
        } else {
          debugLog("[URL Parse] Selector not found", { selector });
        }
      }
      
      if (!transcriptContainer) {
        transcriptContainer = doc.body;
        const currentBodyText = doc.body?.textContent || "";
        const currentBodyTimestamps = currentBodyText.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
        debugLog("[URL Parse] No transcript container found, using body", {
          originalBodyTextLength: bodyText.length,
          currentBodyTextLength: currentBodyText.length,
          bodyTextSample: currentBodyText.substring(0, 1000),
          allTimestampsInBody: currentBodyTimestamps,
          timestampCount: currentBodyTimestamps ? currentBodyTimestamps.length : 0,
          bodyChildren: Array.from(doc.body?.children || []).map(child => ({
            tagName: child.tagName,
            className: child.className || "none",
            id: child.id || "none",
            textLength: child.textContent?.length || 0,
            hasTimestamps: !!(child.textContent?.match(/\([0-9]{1,2}:[0-9]{2}\):/g))
          }))
        });
      }
      
      const allElements = transcriptContainer.querySelectorAll("*");
      for (const el of allElements) {
        const text = el.textContent?.trim() || "";
        if (text && (
          text.match(/^transcripts\s+home\s+news/i) ||
          text.match(/^ny\s+universal\s+childcare\s+announcement\s+ny\s+universal/i) ||
          text.match(/^help\s+center\s+developers\s+security/i) ||
          text.match(/^contact\s+support/i) ||
          (text.match(/^human-verified/i) && !text.match(/\([0-9]{1,2}:[0-9]{2}\):/)) ||
          (text.match(/^ai\s+platform\s+features$/i) && !text.match(/\([0-9]{1,2}:[0-9]{2}\):/))
        )) {
          if (!text.match(/\([0-9]{1,2}:[0-9]{2}\):/)) {
            el.remove();
          }
        }
      }
      
      const fullText = transcriptContainer.textContent || "";
      const allTimestamps = fullText.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
      const speakerPatternMatches = fullText.match(new RegExp(`(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+\\s+)\\([0-9]{1,2}:[0-9]{2}\\):`, "gi"));
      
      debugLog("[URL Parse] Full text extracted from container", { 
        fullTextLength: fullText.length,
        fullTextPreview: fullText.substring(0, 2000),
        fullTextFirstChars: fullText.substring(0, 500),
        fullTextLastChars: fullText.substring(Math.max(0, fullText.length - 500)),
        lineCount: fullText.split('\n').length,
        allTimestamps: allTimestamps,
        timestampCount: allTimestamps ? allTimestamps.length : 0,
        timestampLocations: allTimestamps ? allTimestamps.map(ts => {
          const index = fullText.indexOf(ts);
          return {
            timestamp: ts,
            index: index,
            context: fullText.substring(Math.max(0, index - 50), Math.min(fullText.length, index + 100))
          };
        }).slice(0, 5) : [],
        speakerPatternMatches: speakerPatternMatches,
        speakerPatternCount: speakerPatternMatches ? speakerPatternMatches.length : 0,
        containerTagName: transcriptContainer.tagName,
        containerClassName: transcriptContainer.className || "none",
        containerId: transcriptContainer.id || "none",
        containerChildrenCount: transcriptContainer.children.length,
        containerInnerHTMLLength: transcriptContainer.innerHTML?.length || 0
      });
      
      const transcriptLineMatches = fullText.match(new RegExp(`(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+\\s+)\\([0-9]{1,2}:[0-9]{2}\\):`, "gi"));
      const hasTranscriptFormat = transcriptLineMatches && transcriptLineMatches.length >= 2;
      
      const allTimestampMatches = fullText.match(/\([0-9]{1,2}:[0-9]{2}\):/g);
      const hasMultipleTimestamps = allTimestampMatches && allTimestampMatches.length >= 3;
      
      debugLog("[URL Parse] Transcript format detection", {
        transcriptLineMatchesCount: transcriptLineMatches?.length || 0,
        transcriptLineMatchesPreview: transcriptLineMatches?.slice(0, 5) || [],
        hasTranscriptFormat,
        allTimestampMatchesCount: allTimestampMatches?.length || 0,
        allTimestampMatchesPreview: allTimestampMatches?.slice(0, 10) || [],
        hasMultipleTimestamps,
        fullTextSample: fullText.substring(0, 1000)
      });
      
      if (hasTranscriptFormat || hasMultipleTimestamps) {
        debugLog("[URL Parse] Processing as transcript format");
        const transcriptParagraphs = splitTranscriptBySpeakers(fullText);
        debugLog("[URL Parse] Transcript paragraphs split", { 
          paragraphCount: transcriptParagraphs.length 
        });
        if (transcriptParagraphs.length > 0) {
          let result = transcriptParagraphs.join("\n\n");
          result = deduplicateRepeatedSpeakerNames(result);
          debugLog("[URL Parse] Returning transcript paragraphs", { 
            resultLength: result.length 
          });
          return result;
        }
      }
      
      const hasAnyTranscriptLine = fullText.match(/\([0-9]{1,2}:[0-9]{2}\):/);
      debugLog("[URL Parse] Checking for any transcript line", { 
        hasAnyTranscriptLine: !!hasAnyTranscriptLine 
      });
      if (hasAnyTranscriptLine) {
        debugLog("[URL Parse] Processing as transcript with single timestamp");
        const transcriptParagraphs = splitTranscriptBySpeakers(fullText);
        debugLog("[URL Parse] Transcript paragraphs split (single timestamp)", { 
          paragraphCount: transcriptParagraphs.length 
        });
        if (transcriptParagraphs.length > 0) {
          let result = transcriptParagraphs.join("\n\n");
          result = deduplicateRepeatedSpeakerNames(result);
          debugLog("[URL Parse] Returning transcript paragraphs (single timestamp)", { 
            resultLength: result.length 
          });
          return result;
        }
      }
      
      const paragraphs: string[] = [];
      const processedTexts = new Set<string>();
      
      const collectParagraphs = (el: Element, depth: number = 0) => {
        const children = Array.from(el.children);
        
        if (children.length === 0) {
          const text = el.textContent?.trim() || "";
          if (text && text.length > 5) {
            const hasTranscriptMarker = text.match(/\([0-9]{1,2}:[0-9]{2}\):/) || 
                                       text.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"));
            if (hasTranscriptMarker || !isJunkText(text)) {
              if (!processedTexts.has(text)) {
                processedTexts.add(text);
                paragraphs.push(text);
                if (hasTranscriptMarker) {
                  debugLog("[URL Parse] Found paragraph with transcript marker", {
                    depth,
                    textLength: text.length,
                    textPreview: text.substring(0, 200),
                    tagName: el.tagName,
                    className: el.className || "none"
                  });
                }
              }
            }
          }
          return;
        }
        
        for (const child of children) {
          const tagName = child.tagName.toUpperCase();
          const text = child.textContent?.trim() || "";
          
          if (tagName === "P" || (tagName === "DIV" && text.length > 20)) {
            if (text) {
              const hasTranscriptMarker = text.match(/\([0-9]{1,2}:[0-9]{2}\):/) || 
                                         text.match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+)\\s+\\([0-9]{1,2}:[0-9]{2}\\):`, "i"));
              if (hasTranscriptMarker || !isJunkText(text)) {
                if (!processedTexts.has(text)) {
                  processedTexts.add(text);
                  paragraphs.push(text);
                  if (hasTranscriptMarker && depth < 3) {
                    debugLog("[URL Parse] Found paragraph with transcript marker (P/DIV)", {
                      depth,
                      tagName,
                      textLength: text.length,
                      textPreview: text.substring(0, 200),
                      className: (child as Element).className || "none"
                    });
                  }
                }
              }
            }
          } else {
            collectParagraphs(child, depth + 1);
          }
        }
      };
      
      debugLog("[URL Parse] Starting paragraph collection from container", {
        containerTagName: transcriptContainer.tagName,
        containerTextLength: transcriptContainer.textContent?.length || 0,
        containerChildrenCount: transcriptContainer.children.length
      });
      
      collectParagraphs(transcriptContainer);
      debugLog("[URL Parse] Paragraphs collected", { 
        paragraphCount: paragraphs.length,
        paragraphsPreview: paragraphs.slice(0, 10).map((p, i) => ({
          index: i,
          length: p.length,
          preview: p.substring(0, 150),
          firstChars: p.substring(0, 100),
          hasTimestamp: !!p.match(/\([0-9]{1,2}:[0-9]{2}\):/),
          timestampCount: (p.match(/\([0-9]{1,2}:[0-9]{2}\):/g) || []).length
        })),
        allParagraphLengths: paragraphs.map(p => p.length),
        paragraphsWithTimestamps: paragraphs.filter(p => p.match(/\([0-9]{1,2}:[0-9]{2}\):/)).length
      });
      
      if (paragraphs.length === 0) {
        debugLog("[URL Parse] No paragraphs found, returning full text", {
          fullTextLength: fullText.length,
          fullTextPreview: fullText.substring(0, 500)
        });
        return fullText.trim();
      }
      
      let transcriptStartIndex = -1;
      for (let i = 0; i < paragraphs.length; i++) {
        if (isTranscriptLine(paragraphs[i]) || 
            paragraphs[i].match(new RegExp(`^(?:${TITLE_PATTERN})?(?:[A-Z][a-z]+\\s+|Speaker\\s+[0-9]+\\s+)\\([0-9]{1,2}:[0-9]{2}\\):`, "i"))) {
          transcriptStartIndex = i;
          debugLog("[URL Parse] Transcript start found (method 1)", { index: i });
          break;
        }
      }
      
      if (transcriptStartIndex === -1) {
        for (let i = 0; i < paragraphs.length; i++) {
          if (paragraphs[i].match(/\([0-9]{1,2}:[0-9]{2}\):/)) {
            transcriptStartIndex = i;
            debugLog("[URL Parse] Transcript start found (method 2)", { index: i });
            break;
          }
        }
      }
      
      if (transcriptStartIndex === -1) {
        transcriptStartIndex = 0;
        debugLog("[URL Parse] No transcript start found, using index 0");
      }
      
      const transcriptParagraphs = paragraphs.slice(transcriptStartIndex)
        .filter(p => {
          const trimmed = p.trim();
          if (trimmed.length === 0) return false;
          if (trimmed.match(/\([0-9]{1,2}:[0-9]{2}\):/)) {
            return true;
          }
          return !isJunkText(trimmed);
        })
        .map(p => p.trim())
        .filter((p, index, arr) => {
          if (index === 0) return true;
          const prev = arr[index - 1];
          if (p === prev) return false;
          if (p.length < 20 && prev.includes(p)) return false;
          if (prev.length < 20 && p.includes(prev)) return false;
          return true;
        });
      
      debugLog("[URL Parse] Transcript paragraphs filtered", { 
        transcriptParagraphsCount: transcriptParagraphs.length,
        transcriptStartIndex
      });
      
      if (transcriptParagraphs.length === 0) {
        debugLog("[URL Parse] No transcript paragraphs after filtering, returning full text");
        return fullText.trim();
      }
      
      const result = transcriptParagraphs.join("\n\n");
      debugLog("[URL Parse] Returning final result", { resultLength: result.length });
      return result;
    } catch (error) {
      console.error("[URL Parse] HTML parsing error:", error);
      debugLog("[URL Parse] Using fallback text extraction");
      const fallback = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      debugLog("[URL Parse] Fallback text extracted", { fallbackLength: fallback.length });
      return fallback;
    }
  };

  const fetchWithProxy = async (url: string, proxyIndex: number = 0): Promise<Response> => {
    const proxyServices = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
    
    debugLog("[URL Parse] fetchWithProxy called", { 
      url, 
      proxyIndex, 
      totalProxies: proxyServices.length,
      proxyService: proxyServices[proxyIndex]?.substring(0, 50) + "..."
    });
    
    if (proxyIndex >= proxyServices.length) {
      debugLog("[URL Parse] All proxy services exhausted", { 
        attemptedProxies: proxyServices.length 
      });
      throw new Error("All proxy services failed");
    }
    
    const proxyUrl = proxyServices[proxyIndex];
    debugLog("[URL Parse] Attempting proxy fetch", { 
      proxyIndex, 
      proxyUrl: proxyUrl.substring(0, 100) + "...",
      targetUrl: url
    });
    const res = await fetch(proxyUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    
    const proxyContentType = res.headers.get("content-type");
    debugLog("[URL Parse] Proxy fetch response", { 
      proxyIndex, 
      status: res.status, 
      statusText: res.statusText,
      ok: res.ok,
      contentType: proxyContentType || "unknown",
      headers: Object.fromEntries(res.headers.entries())
    });
    
    if (!res.ok && proxyIndex < proxyServices.length - 1) {
      debugLog("[URL Parse] Proxy fetch failed, trying next proxy", { 
        currentProxyIndex: proxyIndex,
        nextProxyIndex: proxyIndex + 1 
      });
      return fetchWithProxy(url, proxyIndex + 1);
    }
    
    return res;
  };

  const handleUrlSubmit = async (overrideUrl?: string) => {
    const candidateUrl = (overrideUrl ?? rawText).trim();
    debugLog("=== [URL Parse] handleUrlSubmit called ===", { rawText: candidateUrl });
    
    if (!candidateUrl) {
      debugLog("[URL Parse] No URL provided, skipping submission");
      return;
    }
    
    const url = candidateUrl;
    debugLog("[URL Parse] Starting URL submission", { url, urlLength: url.length });
    
    if (!url.match(/^https?:\/\//i)) {
      debugLog("[URL Parse] Invalid URL format", { url, urlLength: url.length });
      setUrlError("Please enter a valid URL starting with http:// or https://");
      return;
    }
    
    setIsLoadingUrl(true);
    setUrlError(null);
    setHasLoadedContent(false);
    
    try {
      let res: Response;
      let usedProxy = false;
      
      debugLog("[URL Parse] Attempting direct fetch", { url, urlLength: url.length });
      try {
        res = await fetch(url, {
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
        const contentType = res.headers.get("content-type");
        debugLog("[URL Parse] Direct fetch successful", { 
          status: res.status, 
          statusText: res.statusText,
          contentType: contentType || "unknown",
          ok: res.ok,
          headers: Object.fromEntries(res.headers.entries())
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorString = String(err);
        const isCorsError = err instanceof TypeError && 
          (errorMessage.includes("Failed to fetch") || 
           errorMessage.includes("network") ||
           errorMessage.includes("CORS") ||
           errorString.includes("CORS") ||
           errorString.includes("Access-Control"));
        
        debugLog("[URL Parse] Direct fetch failed", { 
          error: errorMessage,
          errorString: errorString,
          errorType: err?.constructor?.name || typeof err,
          isCorsError,
          errorName: err instanceof Error ? err.name : "Unknown"
        });
        if (err instanceof Error) {
          debugLog("[URL Parse] Error stack:", err.stack);
        }
        
        if (isCorsError) {
          debugLog("[URL Parse] CORS error detected, retrying with proxy");
          usedProxy = true;
          res = await fetchWithProxy(url);
          const proxyContentType = res.headers.get("content-type");
          debugLog("[URL Parse] Proxy fetch successful", { 
            status: res.status,
            statusText: res.statusText,
            contentType: proxyContentType || "unknown",
            ok: res.ok,
            usedProxy: true
          });
        } else {
          debugLog("[URL Parse] Non-CORS error, rethrowing", { error: errorMessage });
          throw err;
        }
      }
      
      if (!res.ok) {
        debugLog("[URL Parse] HTTP error response", { 
          status: res.status, 
          statusText: res.statusText 
        });
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const contentType = res.headers.get("content-type") || "";
      const isHtml = contentType.includes("text/html");
      debugLog("[URL Parse] Response content type determined", { 
        contentType, 
        isHtml,
        contentLength: res.headers.get("content-length")
      });
      
      const html = await res.text();
      debugLog("[URL Parse] Response text received", { 
        htmlLength: html.length,
        htmlPreview: html.substring(0, 200),
        htmlFirstChars: html.substring(0, 100),
        htmlLastChars: html.substring(Math.max(0, html.length - 100))
      });
      
      if (isHtml) {
        debugLog("[URL Parse] Parsing HTML content");
        const extractedText = parseHtmlToText(html);
        debugLog("[URL Parse] HTML parsing complete", { 
          extractedTextLength: extractedText.length,
          extractedTextPreview: extractedText.substring(0, 300),
          extractedTextFirstChars: extractedText.substring(0, 150),
          extractedTextLastChars: extractedText.substring(Math.max(0, extractedText.length - 150)),
          wordCount: extractedText.split(/\s+/).filter(w => w.length > 0).length
        });
        
        if (!extractedText.trim()) {
          debugLog("[URL Parse] No text content extracted from HTML");
          setUrlError("No readable text content found on this page. The page may require JavaScript to load content.");
          setIsLoadingUrl(false);
          return;
        }
        
        const wordCount = extractedText.split(/\s+/).filter(w => w.length > 0).length;
        debugLog("[URL Parse] Setting extracted text and resetting reader", { 
          extractedTextLength: extractedText.length,
          wordCount: wordCount,
          extractedTextPreview: extractedText.substring(0, 400),
          paragraphCount: extractedText.split(/\n\n/).length
        });
        setRawText(extractedText);
        resetFromText(extractedText);
        setHasLoadedContent(true);
      } else {
        debugLog("[URL Parse] Non-HTML content, using as plain text", { 
          htmlLength: html.length 
        });
        if (!html.trim()) {
          debugLog("[URL Parse] Empty text content");
          setUrlError("No text content found at this URL.");
          setIsLoadingUrl(false);
          return;
        }
        setRawText(html);
        resetFromText(html);
        setHasLoadedContent(true);
        debugLog("[URL Parse] Plain text content loaded", { 
          textLength: html.length,
          wordCount: html.split(/\s+/).length
        });
      }
      
      setIsLoadingUrl(false);
      debugLog("[URL Parse] URL submission completed successfully");
    } catch (err) {
      console.error("[URL Parse] ===== ERROR CAUGHT IN OUTER CATCH =====", err);
      debugLog("[URL Parse] Error details", {
        error: err,
        errorType: err?.constructor?.name,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorString: String(err),
        errorStack: err instanceof Error ? err.stack : undefined
      });
      
      const error = err instanceof Error ? err : new Error(String(err));
      
      let errorMessage: string;
      if (error.message.includes("All proxy services failed")) {
        errorMessage = "Failed to fetch URL: All proxy services are unavailable. The URL may be blocked or inaccessible.";
      } else if (error instanceof TypeError && error.message.includes("Failed to fetch")) {
        errorMessage = "Network error: Unable to connect. Please check your internet connection and try again.";
      } else {
        errorMessage = `Failed to fetch URL: ${error.message}. The URL may be inaccessible or blocked.`;
      }
      
      debugLog("[URL Parse] Error handling complete", { 
        errorMessage,
        errorType: error.constructor.name,
        errorMessageDetail: error.message
      });
      
      setUrlError(errorMessage);
      setIsLoadingUrl(false);
      setHasLoadedContent(false);
    }
  };

  const handlePdfFile = async (file: File | null) => {
    if (!file) return;
    
    setIsLoadingPdf(true);
    setPdfError(null);
    setHasLoadedContent(false);
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      
      const numPages = pdf.numPages;
      const textParts: string[] = [];
      
      // Extract text from all pages
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(" ");
        textParts.push(pageText);
      }
      
      const fullText = textParts.join("\n\n");
      
      if (!fullText.trim()) {
        setPdfError("No text content found in PDF. The PDF may be image-based or encrypted.");
        setIsLoadingPdf(false);
        return;
      }
      
      setRawText(fullText);
      resetFromText(fullText);
      setHasLoadedContent(true);
      setIsLoadingPdf(false);
    } catch (error) {
      console.error("Failed to parse PDF:", error);
      setPdfError(
        error instanceof Error 
          ? `Failed to parse PDF: ${error.message}` 
          : "Failed to parse PDF. The file may be corrupted or encrypted."
      );
      setIsLoadingPdf(false);
      setHasLoadedContent(false);
    }
  };

  const handleFileChange: React.ChangeEventHandler<HTMLInputElement> = async (
    e
  ) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      await handlePdfFile(file);
    } else if (file.type.startsWith("text/")) {
      const text = await file.text();
      setRawText(text);
      resetFromText(text);
    } else {
      const text = await file.text().catch(() => "");
      if (text) {
        setRawText(text);
        resetFromText(text);
      }
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="app-title">Speed Reader</div>
            <div className="app-subtitle">
              One word at a time, with a red pivot letter to keep your eyes anchored.
            </div>
          </div>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            style={{ marginTop: "4px" }}
          >
            ⚙️ Settings
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <button
            className="settings-backdrop"
            type="button"
            aria-label="Close settings"
            onClick={() => setShowSettings(false)}
          />
          <section
            className="card settings-panel"
            style={
              {
                ["--settings-controls-columns" as never]:
                  fontGridCols <= 2
                    ? "minmax(0, 1fr) minmax(0, 1fr)"
                    : "fit-content(360px) fit-content(520px)"
              } as React.CSSProperties
            }
          >
            <div className="card-header">
              <div className="card-title">Settings</div>
              <button
                className="btn btn-ghost btn-icon"
                type="button"
                onClick={() => setShowSettings(false)}
              >
                ✕
              </button>
            </div>

            <div className="settings-content">
              <div className="setting-group">
                <label className="setting-label">Font Family</label>
                <div
                  className="font-grid"
                  ref={fontGridRef}
                  style={{
                    ["--font-cols" as never]: fontGridCols,
                    ["--font-preview-size" as never]:
                      fontGridCols >= 5 ? "0.9rem" : fontGridCols >= 4 ? "0.98rem" : "1.05rem"
                  } as React.CSSProperties}
                >
                  {fontOptions.map((font) => (
                    <button
                      key={font.value}
                      type="button"
                      className={`font-option ${fontFamily === font.value ? "active" : ""}`}
                      onClick={() => setFontFamily(font.value)}
                    >
                      <div className="font-preview" style={{ fontFamily: font.value }}>
                        {font.label}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-controls-grid">
                <div className="setting-group settings-spacing">
                  <label className="setting-label">Letter Spacing: {letterSpacing}</label>
                  <div className="setting-slider-group">
                    <input
                      className="slider range-input"
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={letterSpacing}
                      onChange={(e) => setLetterSpacing(Number(e.target.value))}
                    />
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => setLetterSpacing(5)}
                      style={{ fontSize: "0.8rem", padding: "4px 8px" }}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="setting-group settings-pivot">
                  <label className="setting-label">Pivot Letter Color</label>
                  <div className="setting-color-group">
                    <input
                      className="setting-color-input"
                      type="color"
                      value={pivotColor}
                      onChange={(e) => setPivotColor(e.target.value)}
                      aria-label="Pivot letter color"
                    />
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => setPivotColor("#ff4e4e")}
                      style={{ fontSize: "0.8rem", padding: "4px 8px" }}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="setting-group settings-pause">
                  <label className="setting-label">Auto continue paragraphs</label>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={autoContinueParagraphs}
                      onChange={(e) => setAutoContinueParagraphs(e.target.checked)}
                    />
                    <span className="toggle-text">Go to next paragraph automatically.</span>
                  </label>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      <main className="layout">
        <div className="reader-stage">
          <section className="card reader-card">
            <div className="card-header">
              <div className="card-title">Reader</div>
              <div className="card-badges">
                <div className="card-badge">
                  {hasContent ? `${currentIndex + 1} / ${words.length} words` : "Idle"}
                </div>
                {hasContent && parsedParagraphs.length ? (
                  <div className="card-badge">
                    Paragraph {currentParagraphInfo ? currentParagraphInfo.paragraphIndex + 1 : 1} of{" "}
                    {parsedParagraphs.length}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="reader-screen">
              <div
                ref={wordDisplayRef}
                className="word-display"
                style={{
                  fontFamily: fontFamily,
                  letterSpacing: `${letterSpacingToEm(letterSpacing)}em`,
                  fontSize: wordFontPxOverride ? `${wordFontPxOverride}px` : undefined
                }}
              >
                {hasContent ? (
                  <div
                    className="word-line"
                    style={{ transform: `translateX(${pivotOffset}px)` }}
                  >
                    <span ref={leftPartRef} className="word-left">{pivotParts.left}</span>
                    <span
                      ref={pivotRef}
                      className="pivot-letter"
                      style={{ color: pivotColor }}
                    >
                      {pivotParts.pivot}
                    </span>
                    <span ref={rightPartRef} className="word-right">{pivotParts.right}</span>
                  </div>
                ) : (
                  <div className="reader-input">
                    {(() => {
                      const isLoading = isLoadingUrl || isLoadingPdf;
                      const errorMessage = urlError || pdfError;
                      const showError = !!errorMessage && !isLoading;

                      return (
                        <>
                          {isLoading ? (
                            <div className="input-loading" aria-label="Loading">
                              <div className="spinner" />
                            </div>
                          ) : null}

                          {showError ? (
                            <div className="input-error">
                              {errorMessage}
                            </div>
                          ) : null}

                          <textarea
                            ref={textareaRef}
                            className="text-input reader-textarea"
                            placeholder="Paste text or a URL (by itself)…"
                            value={rawText}
                            onChange={(e) => setRawText(e.target.value)}
                            onBlur={handleRawTextBlur}
                            onPaste={handleRawTextPaste}
                            disabled={isLoading}
                          />

                          <div className="input-footer reader-input-footer">
                            <span className="input-hint">Paste text, paste a URL, or open a file.</span>
                            <label className="file-input">
                              <input
                                type="file"
                                accept=".txt,application/pdf"
                                onChange={handleFileChange}
                                disabled={isLoading}
                              />
                            </label>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              <div className="pivot-guide" />

              {hasContent ? (
              <div className="controls-row">
                <div className="wpm-group">
                  <button
                    className="btn btn-icon btn-ghost"
                    onClick={() => handleStep(-1)}
                    disabled={!hasContent || currentIndex === 0}
                    type="button"
                  >
                    ‹
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handlePlayPause}
                    disabled={!hasContent}
                    type="button"
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    className="btn btn-icon btn-ghost"
                    onClick={() => handleStep(1)}
                    disabled={!hasContent || currentIndex >= words.length - 1}
                    type="button"
                  >
                    ›
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={handleRestart}
                    disabled={!hasContent}
                    type="button"
                  >
                    Restart
                  </button>
                </div>

                <div className="wpm-group">
                  <span className="wpm-value">{wpm} wpm</span>
                  <input
                    className="slider range-input"
                    type="range"
                    min={150}
                    max={900}
                    step={10}
                    value={wpm}
                    onChange={(e) => setWpm(Number(e.target.value))}
                  />
                </div>
              </div>
              ) : null}

              {hasContent ? (
              <div className="controls-row">
                <div className="wpm-group">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => handleParagraphJump(-1)}
                    disabled={!hasContent}
                  >
                    ↑ Paragraph
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => handleParagraphJump(1)}
                    disabled={!hasContent}
                  >
                    ↓ Paragraph
                  </button>
                </div>
                <div className="wpm-group">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setShowParagraph((s) => !s)}
                    disabled={!hasContent}
                  >
                    {showParagraph ? "Hide context" : "Show paragraph"}
                  </button>
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={handleNewInput}
                  >
                    New input
                  </button>
                </div>
              </div>
              ) : null}

              {showParagraph && currentParagraphInfo && (
                <div className="reader-context">
                  <div className="paragraph-context">
                    <span>{currentParagraphInfo.before} </span>
                    <strong>{currentParagraphInfo.active}</strong>
                    <span> {currentParagraphInfo.after}</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};

export default App;

