import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen, ChevronLeft, ChevronRight, FileImage, FolderOpen,
  Languages, Pause, Play, ScanText, Sparkles, Square, Volume2, VolumeX, UploadCloud, X,
} from "lucide-react";
import "./reader.css";

type ComicPage = { name: string; url: string; source: "image" | "pdf" | "cbz"; pageNo?: number };
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any> };
declare global { interface Window { Tesseract?: any; pdfjsLib?: any; JSZip?: any } }

const CDN = {
  tesseract: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
  pdfjs: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  jszip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
};

const OCR_LANGS = [
  { code: "mya", ocr: "mya+eng", label: "မြန်မာ" },
  { code: "eng", ocr: "eng", label: "English" },
  { code: "jpn", ocr: "jpn+jpn_vert", label: "日本語 (Manga)" },
  { code: "kor", ocr: "kor", label: "한국어 (Manhwa)" },
  { code: "chi_sim", ocr: "chi_sim", label: "中文 (Manhua)" },
];

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", avif: "image/avif",
};

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const found = document.querySelector(`script[data-reader-src="${src}"]`) as HTMLScriptElement | null;
    if (found) {
      if (found.dataset.loaded === "yes") resolve();
      else {
        found.addEventListener("load", () => resolve(), { once: true });
        found.addEventListener("error", () => reject(new Error("Library failed to load")), { once: true });
      }
      return;
    }
    const script = document.createElement("script");
    script.src = src; script.async = true; script.dataset.readerSrc = src;
    script.onload = () => { script.dataset.loaded = "yes"; resolve(); };
    script.onerror = () => reject(new Error("Library failed to load"));
    document.head.appendChild(script);
  });
}

const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Burmese OCR often inserts spaces between letters; remove those and tidy blank lines. */
function cleanBurmese(raw: string) {
  return raw
    .replace(/([က-႟])[ \t]+(?=[က-႟])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split text into short chunks so speech synthesis does not stall on long input. */
function toChunks(text: string, max = 180) {
  const parts = text.split(/(?<=[။.!?\n])/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > max) { out.push(cur); cur = p; }
    else cur = cur ? cur + " " + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

function ComicReader() {
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [active, setActive] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("ဖိုင်ရွေးပြီး စတင်ပါ");
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  const [showVoice, setShowVoice] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [ocrLang, setOcrLang] = useState("eng");
  const [translation, setTranslation] = useState("");
  const [translating, setTranslating] = useState(false);
  const [readTranslated, setReadTranslated] = useState(true);

  const fileRef = useRef<HTMLInputElement>(null);
  const pagesRef = useRef<ComicPage[]>([]);
  const activeRef = useRef(0);
  const textRef = useRef("");
  const autoNextRef = useRef(true);
  const playingRef = useRef(false);
  const voiceRef = useRef("");
  const ocrCache = useRef<Map<number, string>>(new Map());
  const urlsRef = useRef<string[]>([]);
  const ocrLangRef = useRef("eng");
  const transCache = useRef<Map<number, string>>(new Map());
  const readTranslatedRef = useRef(true);

  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { textRef.current = text; }, [text]);
  useEffect(() => { autoNextRef.current = autoNext; }, [autoNext]);
  useEffect(() => { voiceRef.current = voiceURI; }, [voiceURI]);
  useEffect(() => { ocrLangRef.current = ocrLang; }, [ocrLang]);
  useEffect(() => { readTranslatedRef.current = readTranslated; }, [readTranslated]);

  // Voices
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      setVoices(list);
      setVoiceURI((cur) => {
        if (cur && list.some((v) => v.voiceURI === cur)) return cur;
        const my = list.find((v) => v.lang.toLowerCase().startsWith("my"));
        return my ? my.voiceURI : "";
      });
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // Show cached OCR text when the page changes
  useEffect(() => {
    setText(ocrCache.current.get(active) ?? "");
    setTranslation(transCache.current.get(active) ?? "");
  }, [active]);

  // Cleanup
  useEffect(() => () => {
    playingRef.current = false;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const hasBurmeseVoice = useMemo(
    () => voices.some((v) => v.lang.toLowerCase().startsWith("my")), [voices],
  );

  const stopSpeaking = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    setPaused(false);
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }, []);

  const resetPages = () => {
    stopSpeaking();
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    ocrCache.current.clear();
    transCache.current.clear();
    setPages([]); setActive(0); setText(""); setTranslation("");
  };

  const track = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  };

  const loadImages = (files: File[]): ComicPage[] =>
    files.sort((a, b) => naturalSort(a.name, b.name))
      .map((f) => ({ name: f.name, url: track(f), source: "image" as const }));

  const loadCbz = async (file: File): Promise<ComicPage[]> => {
    setStatus("CBZ library ခေါ်နေသည်…");
    if (!window.JSZip) await loadScript(CDN.jszip);
    const zip = await window.JSZip.loadAsync(file);
    const names = Object.keys(zip.files)
      .filter((n: string) => !zip.files[n].dir && IMAGE_EXT.test(n) && !n.includes("__MACOSX"))
      .sort(naturalSort);
    const out: ComicPage[] = [];
    for (let i = 0; i < names.length; i++) {
      setStatus(`CBZ ဖတ်နေသည် ${i + 1}/${names.length}`);
      setProgress(Math.round(((i + 1) / names.length) * 100));
      const ext = names[i].split(".").pop()!.toLowerCase();
      const buf = await zip.files[names[i]].async("arraybuffer");
      const url = track(new Blob([buf], { type: MIME[ext] || "image/jpeg" }));
      out.push({ name: names[i].split("/").pop() || names[i], url, source: "cbz" });
    }
    return out;
  };

  const loadPdf = async (file: File): Promise<ComicPage[]> => {
    setStatus("PDF library ခေါ်နေသည်…");
    if (!window.pdfjsLib) {
      await loadScript(CDN.pdfjs);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    }
    const data = await file.arrayBuffer();
    const doc: PdfDoc = await window.pdfjsLib.getDocument({ data }).promise;
    const out: ComicPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      setStatus(`PDF စာမျက်နှာ ${n}/${doc.numPages} ပြောင်းနေသည်`);
      setProgress(Math.round((n / doc.numPages) * 100));
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
      if (blob) out.push({ name: `${file.name} · ${n}`, url: track(blob), source: "pdf", pageNo: n });
    }
    return out;
  };

  const onFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    const files = Array.from(list);
    resetPages();
    setBusy(true); setProgress(0);
    try {
      let result: ComicPage[] = [];
      const images = files.filter((f) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name));
      const pdf = files.find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      const cbz = files.find((f) => /\.(cbz|zip)$/i.test(f.name));
      if (images.length) result = loadImages(images);
      else if (pdf) result = await loadPdf(pdf);
      else if (cbz) result = await loadCbz(cbz);
      if (!result.length) {
        setStatus("ထောက်ပံ့တဲ့ ဖိုင် မတွေ့ပါ (ပုံ၊ PDF၊ CBZ သုံးနိုင်သည်)");
      } else {
        setPages(result); setActive(0);
        setStatus(`စာမျက်နှာ ${result.length} ခု ဖွင့်ပြီးပါပြီ`);
      }
    } catch (e: any) {
      setStatus(`ဖိုင်ဖွင့်မရပါ: ${e?.message || "မသိသော အမှား"}`);
    } finally {
      setBusy(false); setProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const runOcr = useCallback(async (index: number): Promise<string> => {
    const cached = ocrCache.current.get(index);
    if (cached !== undefined) return cached;
    const page = pagesRef.current[index];
    if (!page) return "";
    setBusy(true); setProgress(0);
    setStatus(`စာမျက်နှာ ${index + 1} ကို OCR လုပ်နေသည်…`);
    try {
      if (!window.Tesseract) await loadScript(CDN.tesseract);
      const res = await window.Tesseract.recognize(
        page.url,
        (OCR_LANGS.find((l) => l.code === ocrLangRef.current) ?? OCR_LANGS[1]).ocr,
        {
        logger: (m: any) => {
          if (m.status === "recognizing text") setProgress(Math.round(m.progress * 100));
          else if (m.status) setStatus(`OCR: ${m.status}`);
        },
        },
      );
      const clean = cleanBurmese(res?.data?.text || "");
      ocrCache.current.set(index, clean);
      if (activeRef.current === index) setText(clean);
      setStatus(clean ? `စာမျက်နှာ ${index + 1} စာသား ထုတ်ပြီးပါပြီ` : "စာသား မတွေ့ပါ");
      return clean;
    } catch (e: any) {
      setStatus(`OCR မအောင်မြင်ပါ: ${e?.message || "အင်တာနက်စစ်ပါ"}`);
      return "";
    } finally {
      setBusy(false); setProgress(null);
    }
  }, []);

  const translatePage = useCallback(async (index: number, source: string): Promise<string> => {
    const cached = transCache.current.get(index);
    if (cached !== undefined) return cached;
    if (!source.trim()) return "";
    setTranslating(true);
    setStatus(`စာမျက်နှာ ${index + 1} ကို မြန်မာလို ဘာသာပြန်နေသည်…`);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: source, from: ocrLangRef.current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.translation) {
        throw new Error(data.message || `ဘာသာပြန် server အမှား (${res.status})`);
      }
      transCache.current.set(index, data.translation);
      if (activeRef.current === index) setTranslation(data.translation);
      setStatus(`စာမျက်နှာ ${index + 1} ဘာသာပြန်ပြီးပါပြီ`);
      return data.translation as string;
    } catch (e: any) {
      setStatus(`ဘာသာပြန်မရပါ: ${e?.message || "အင်တာနက်စစ်ပါ"}`);
      return "";
    } finally {
      setTranslating(false);
    }
  }, []);

  const speak = (content: string) =>
    new Promise<void>((resolve) => {
      const chunks = toChunks(content);
      let i = 0;
      const next = () => {
        if (!playingRef.current || i >= chunks.length) return resolve();
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceRef.current);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "my-MM";
        u.onend = next;
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      };
      next();
    });

  const startReading = async () => {
    if (!("speechSynthesis" in window)) { setStatus("ဒီ browser မှာ အသံဖတ်စနစ် မပါပါ"); return; }
    if (playingRef.current) return;
    window.speechSynthesis.cancel();
    playingRef.current = true; setPlaying(true); setPaused(false);
    let idx = activeRef.current;
    let first = true;
    while (playingRef.current) {
      let t = first ? textRef.current : "";
      first = false;
      if (!t.trim()) {
        activeRef.current = idx;
        t = await runOcr(idx);
        if (!playingRef.current) break;
        if (activeRef.current === idx) setText(t);
      }
      let toSpeak = t;
      if (t.trim() && readTranslatedRef.current) {
        const tr = transCache.current.get(idx) ?? await translatePage(idx, t);
        if (!playingRef.current) break;
        if (tr.trim()) toSpeak = tr;
      }
      if (toSpeak.trim()) {
        setStatus(`စာမျက်နှာ ${idx + 1} ကို ဖတ်နေသည်…`);
        await speak(toSpeak);
      }
      if (!playingRef.current) break;
      if (autoNextRef.current && idx + 1 < pagesRef.current.length) {
        idx += 1; setActive(idx);
      } else break;
    }
    playingRef.current = false; setPlaying(false); setPaused(false);
    setStatus("ဖတ်ပြီးပါပြီ");
  };

  const togglePause = () => {
    if (!playing) { void startReading(); return; }
    if (paused) { window.speechSynthesis.resume(); setPaused(false); }
    else { window.speechSynthesis.pause(); setPaused(true); }
  };

  const go = (delta: number) => {
    const n = active + delta;
    if (n < 0 || n >= pages.length) return;
    if (playing) stopSpeaking();
    setActive(n);
  };

  const current = pages[active];

  return (
    <div className="reader-shell">
      <header className="topbar">
        <a className="brand" href="./">
          <span className="brand-mark"><BookOpen size={19} /></span>
          <span><b>MYANMAR AI</b><small>COMIC READER</small></span>
        </a>
        <div className="top-actions">
          <span className="local-pill"><i />LOCAL ONLY</span>
          <button className="icon-button" aria-label="အကူအညီ" onClick={() => setShowHelp(true)}>
            <Sparkles size={16} />
          </button>
        </div>
      </header>

      <section className="intro-row">
        <div>
          <span className="eyebrow">MYANMAR OCR · READ ALOUD</span>
          <h1>Comic ကို <em>ဖတ်ပြီး</em><br />နားထောင်ပါ</h1>
          <p className="intro-copy">
            Manga၊ Webtoon ဖိုင်တွေကို ဖွင့်ပြီး မြန်မာစာသား ထုတ်ယူကာ အသံနဲ့ နားထောင်နိုင်ပါတယ်။
            ဖိုင်တွေက သင့် browser ထဲမှာပဲ ရှိနေပါတယ်။
          </p>
        </div>
        <div className="intro-art" aria-hidden="true">
          <span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" />
          <div className="art-book"><FileImage size={34} /><span /></div>
          <span className="art-spark spark-a">✦</span><span className="art-spark spark-b">✧</span>
        </div>
      </section>

      <section className="upload-panel">
        <div className="upload-icon"><UploadCloud size={22} /></div>
        <div className="upload-copy">
          <h2>Comic ဖိုင် ရွေးပါ</h2>
          <p>ပုံများ (JPG/PNG/WebP)၊ PDF၊ CBZ/ZIP ထောက်ပံ့သည်</p>
        </div>
        <input
          ref={fileRef} className="file-input" type="file" multiple
          accept="image/*,.pdf,.cbz,.zip,application/pdf"
          onChange={(e) => void onFiles(e.target.files)}
        />
        <button className="primary-button" disabled={busy} onClick={() => fileRef.current?.click()}>
          <FolderOpen size={15} /> ဖိုင်ရွေးမည်
        </button>
      </section>

      <div className="status-line" role="status" aria-live="polite">
        <span className={`status-dot${busy ? " working" : ""}`} />
        <span>{status}</span>
        {progress !== null && <span className="progress-value">{progress}%</span>}
      </div>

      <main className="workspace">
        <section className="page-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">COMIC PAGE</span>
              <h2>{current ? current.name : "စာမျက်နှာ"}</h2>
            </div>
            <span className="page-count">{pages.length ? `${active + 1} / ${pages.length}` : "0 / 0"}</span>
          </div>

          <div className={`comic-stage${current ? " has-page" : ""}`}>
            {current ? (
              <img key={current.url} src={current.url} alt={`စာမျက်နှာ ${active + 1}`} />
            ) : (
              <div className="empty-page">
                <div className="empty-book"><BookOpen size={30} /></div>
                <b>ဖတ်စရာ မရှိသေးပါ</b>
                <span>Comic ဖိုင်တစ်ခု ရွေးလိုက်ရင် ဒီမှာ ပေါ်လာပါမယ်</span>
                <button onClick={() => fileRef.current?.click()}><FolderOpen size={14} /> ဖိုင်ရွေးမည်</button>
              </div>
            )}
          </div>

          <div className="page-toolbar">
            <button className="secondary-button" disabled={active <= 0} onClick={() => go(-1)}>
              <ChevronLeft size={14} /> ရှေ့
            </button>
            <span>{current ? current.name : "—"}</span>
            <button className="secondary-button" disabled={!pages.length || active >= pages.length - 1} onClick={() => go(1)}>
              နောက် <ChevronRight size={14} />
            </button>
          </div>
        </section>

        <section className="speech-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">TEXT &amp; VOICE</span>
              <h2>စာသား နှင့် အသံ</h2>
            </div>
            <div className="voice-orb">{playing && !paused ? <Volume2 size={16} /> : <VolumeX size={16} />}</div>
          </div>

          <div className="ocr-action">
            <div>
              <ScanText size={20} />
              <span><b>မြန်မာ OCR</b><small>ပုံထဲက စာသားကို ထုတ်ယူမည်</small></span>
            </div>
            <button disabled={!current || busy} onClick={() => {
              ocrCache.current.delete(active);
              transCache.current.delete(active);
              setTranslation("");
              void runOcr(active);
            }}>
              <ScanText size={13} /> စာသားထုတ်မည်
            </button>
          </div>

          <div className="voice-select-wrap">
            <label htmlFor="ocr-lang">Comic ထဲက ဘာသာစကား</label>
            <select id="ocr-lang" value={ocrLang} onChange={(e) => setOcrLang(e.target.value)}>
              {OCR_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>

          <div className="text-label">
            <span>ထုတ်ယူထားသော စာသား</span>
            <small>{text.length} လုံး · ပြင်ဆင်နိုင်သည်</small>
          </div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); ocrCache.current.set(active, e.target.value); }}
            placeholder="OCR လုပ်ပြီးရင် စာသားက ဒီမှာ ပေါ်လာပါမယ်။ ကိုယ်တိုင်လည်း ရိုက်ထည့်ပြင်နိုင်ပါတယ်။"
            spellCheck={false}
          />

          <div className="ocr-action">
            <div>
              <Languages size={20} />
              <span><b>မြန်မာ AI ဘာသာပြန်</b><small>ထုတ်ထားတဲ့ စာသားကို မြန်မာလို ပြန်မည်</small></span>
            </div>
            <button disabled={!text.trim() || busy || translating} onClick={() => {
              transCache.current.delete(active);
              void translatePage(active, text);
            }}>
              <Languages size={13} /> {translating ? "ပြန်နေသည်…" : "ဘာသာပြန်မည်"}
            </button>
          </div>

          <div className="text-label">
            <span>မြန်မာဘာသာပြန်</span>
            <small>{translation.length} လုံး · ပြင်ဆင်နိုင်သည်</small>
          </div>
          <textarea
            value={translation}
            onChange={(e) => { setTranslation(e.target.value); transCache.current.set(active, e.target.value); }}
            placeholder="ဘာသာပြန်ပြီးရင် မြန်မာစာသားက ဒီမှာ ပေါ်လာပါမယ်။"
            spellCheck={false}
          />

          <div className="voice-options">
            <label className="auto-next">
              <input type="checkbox" checked={readTranslated} onChange={(e) => setReadTranslated(e.target.checked)} />
              <span className="check-ui" />
              <span>ဖတ်ပြတဲ့အခါ မြန်မာဘာသာပြန်ကို သုံးမည်</span>
            </label>
          </div>

          <div className="voice-options">
            <label className="auto-next">
              <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} />
              <span className="check-ui" />
              <span>ဖတ်ပြီးရင် နောက်စာမျက်နှာ အလိုအလျောက် ဆက်မည်</span>
            </label>
            <button className="voice-settings" onClick={() => setShowVoice((v) => !v)}>
              <Volume2 size={13} /> အသံရွေးရန်
            </button>
          </div>

          {showVoice && (
            <div className="voice-select-wrap">
              <label htmlFor="voice-select">အသံ</label>
              <select id="voice-select" value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)}>
                <option value="">မူလ (browser default)</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                ))}
              </select>
              <small>
                {hasBurmeseVoice
                  ? "မြန်မာအသံ တွေ့ပါတယ်။"
                  : "ဒီစက်မှာ မြန်မာအသံ မတွေ့ပါ။ ဖုန်း/browser ရဲ့ text-to-speech setting မှာ မြန်မာဘာသာ အသံ ထည့်သွင်းပါ။"}
              </small>
            </div>
          )}

          <div className="playback-controls">
            <button className="play-button" disabled={!current || (busy && !playing)} onClick={togglePause}>
              {playing && !paused ? <><Pause size={16} /> ခေတ္တရပ်မည်</> : <><Play size={16} /> {paused ? "ဆက်ဖတ်မည်" : "ဖတ်ပြမည်"}</>}
            </button>
            <button className="stop-button" disabled={!playing} onClick={stopSpeaking}>
              <Square size={12} /> ရပ်မည်
            </button>
          </div>

          <p className="privacy-note">
            <Sparkles size={12} />
            <span>ဖိုင်တွေကို browser ထဲမှာပဲ ကိုင်တွယ်ပါတယ်။ OCR engine နဲ့ ဘာသာစကားဒေတာကိုသာ အင်တာနက်ကနေ ဒေါင်းလုဒ်လုပ်ပါတယ်။</span>
          </p>
        </section>
      </main>

      {pages.length > 0 && (
        <section className="page-strip">
          <div className="strip-heading">
            <h3>စာမျက်နှာများ</h3><span>{pages.length} ခု</span>
          </div>
          <div className="thumb-list">
            {pages.map((p, i) => (
              <button
                key={p.url} className={`thumb${i === active ? " selected" : ""}`}
                onClick={() => { if (playing) stopSpeaking(); setActive(i); }}
                aria-label={`စာမျက်နှာ ${i + 1}`}
              >
                <img src={p.url} alt="" loading="lazy" /><span>{i + 1}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <footer className="footer">
        <span>MYANMAR AI COMIC READER</span>
        <span>LOCAL · PRIVATE · FREE</span>
      </footer>

      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="help-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="ပိတ်မည်" onClick={() => setShowHelp(false)}><X size={16} /></button>
            <span className="section-kicker">HOW TO USE</span>
            <h2>အသုံးပြုနည်း</h2>
            <ol>
              <li>"ဖိုင်ရွေးမည်" ကိုနှိပ်ပြီး ပုံများ၊ PDF သို့မဟုတ် CBZ ရွေးပါ။</li>
              <li>"စာသားထုတ်မည်" ကိုနှိပ်ရင် ပုံထဲက မြန်မာစာကို ဖတ်ထုတ်ပေးပါမယ်။</li>
              <li>စာသား မှားနေရင် အလယ်က အကွက်ထဲမှာ တိုက်ရိုက် ပြင်နိုင်ပါတယ်။</li>
              <li>"ဘာသာပြန်မည်" ကိုနှိပ်ရင် AI က မြန်မာလို ပြန်ပေးပါမယ်။</li>
              <li>"ဖတ်ပြမည်" ကိုနှိပ်ပြီး အသံနဲ့ နားထောင်ပါ။</li>
            </ol>
            <p>OCR ရလဒ်က ပုံရဲ့ ရှင်းလင်းမှုပေါ် မူတည်ပါတယ်။ ပထမဆုံးအကြိမ် OCR လုပ်ရင် ဘာသာစကားဒေတာ ဒေါင်းလုဒ်လုပ်ရလို့ နည်းနည်း ကြာနိုင်ပါတယ်။</p>
            <button className="primary-button full" onClick={() => setShowHelp(false)}>နားလည်ပါပြီ</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ComicReader;
