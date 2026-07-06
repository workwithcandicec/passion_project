import { useState, useRef, useEffect } from "react";
import { WORKER_URL } from "./config.js";

// ---------- Design tokens ----------
const T = {
  bg: "#F4F6F1",
  ink: "#21301F",
  green: "#2F6B4F",
  greenDark: "#1E4A36",
  marigold: "#D9A441",
  marigoldInk: "#9C731F",
  muted: "#6B7568",
  card: "#FFFFFF",
  line: "#DDE3D8",
  display: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  body: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
};

const STORAGE_KEY = "passion-project-library-v1";

// Weeks rule: 1 book -> 4 wk, 2-3 books -> 8 wk, 4+ -> 12 wk
const scheduleFor = (count) => (count >= 4 ? 12 : count >= 2 ? 8 : 4);

const INTENTS = [
  { id: "change", label: "Change something", hint: "advocate, organize, ship a real-world outcome" },
  { id: "learn", label: "Learn something", hint: "build skill and understanding, end with a capstone" },
  { id: "research", label: "Research something", hint: "build a reference base to ground future work" },
];

// ---------- Claude API ----------
async function callClaude(content) {
  if (!WORKER_URL || WORKER_URL.includes("YOUR-WORKER")) {
    throw new Error("Setup needed: set WORKER_URL in src/config.js to your deployed Cloudflare Worker URL.");
  }
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = Math.min(
    ...["{", "["].map((c) => (clean.indexOf(c) === -1 ? Infinity : clean.indexOf(c)))
  );
  return JSON.parse(clean.slice(start));
}

function decodeToJpeg(file, maxEdge = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    const fail = (why) => { URL.revokeObjectURL(url); reject(new Error(why)); };
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
      } catch (e) {
        fail("canvas: " + e.message);
      }
    };
    img.onerror = () => fail("decode failed");
    img.src = url;
  });
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

const API_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Try: decode + resize to JPEG. Fallback: send the raw file if the API accepts its type.
async function fileToApiImage(file) {
  try {
    return { base64: await decodeToJpeg(file), mediaType: "image/jpeg" };
  } catch (e) {
    console.error("Resize path failed for", file.name, e);
    const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || "");
    if (isHeic) {
      try {
        const heic2any = (await import("heic2any")).default;
        const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
        const jpegBlob = Array.isArray(converted) ? converted[0] : converted;
        return { base64: await decodeToJpeg(jpegBlob), mediaType: "image/jpeg" };
      } catch (e2) {
        console.error("HEIC conversion failed", e2);
      }
    }
    if (API_IMAGE_TYPES.includes(file.type) && file.size < 4.5 * 1024 * 1024) {
      return { base64: await readFileBase64(file), mediaType: file.type };
    }
    throw new Error(file.name || "photo");
  }
}

// ---------- Agent steps ----------
async function extractTitles(base64, mediaType = "image/jpeg") {
  const text = await callClaude([
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    {
      type: "text",
      text:
        "This photo shows books — it may be a physical bookshelf, a Kindle or e-reader library screen, an audiobook app, or a stack of books. " +
        'Identify every title you can read with reasonable confidence; skip anything unreadable. Respond ONLY with a JSON array, no prose, no markdown: [{"title":"...","author":"..."}] (author may be an empty string).',
    },
  ]);
  const arr = parseJson(text);
  return Array.isArray(arr) ? arr : [];
}

async function categorize(titles, passions) {
  const text = await callClaude([
    {
      type: "text",
      text:
        `Passion categories: ${JSON.stringify(passions)}\n` +
        `Books: ${JSON.stringify(titles)}\n` +
        'A book may serve more than one passion — assign it to EVERY category it genuinely fits, so the same title can appear under several passions. Only include genuinely relevant matches. Books that fit none go in "unmatched". Respond ONLY with JSON, no prose: {"categories":[{"passion":"...","books":["title"]}],"unmatched":["title"]}',
    },
  ]);
  return parseJson(text);
}

const FALLBACK_Q = {
  change: "What specifically do you want to be different in the world when this project is done?",
  learn: "What do you want to be able to do that you can't today?",
  research: "What future decision or work should this reference base support?",
};

async function genShaping(passion, books) {
  const text = await callClaude([
    {
      type: "text",
      text:
        `A learner wants to build a project around their passion "${passion}". They own these books but have probably NOT read them yet: ${JSON.stringify(books)}.\n` +
        "IMPORTANT: never ask about a book's contents, arguments, or authors — the learner hasn't read them. Ask only about the learner's own goals, situation, audience, and constraints.\n" +
        "For EACH of these three project intents, write ONE sharp coaching question (under 22 words) plus 3 short example answers the learner could tap to adopt (under 12 words each):\n" +
        "- change: they want to change something in the real world (an outcome, a policy, a behavior)\n" +
        "- learn: they want to build skill and understanding, ending in a capstone\n" +
        "- research: they want to build an organized reference base for future work\n" +
        'Respond ONLY with JSON, no prose: {"change":{"question":"...","suggestions":["...","...","..."]},"learn":{"question":"...","suggestions":["...","...","..."]},"research":{"question":"...","suggestions":["...","...","..."]}}',
    },
  ]);
  return parseJson(text);
}

async function buildPlan(passion, intent, answer, books, weeks) {
  const intentGuide = {
    change:
      "The learner wants to CHANGE something in the real world. The plan should build toward a concrete action or deliverable (a campaign, proposal, event, or shipped artifact).",
    learn:
      "The learner wants to LEARN. The plan should build skill progressively and end with a capstone that demonstrates understanding.",
    research:
      "The learner wants to RESEARCH and build a reference base. The plan should produce organized notes, an annotated bibliography, and a synthesis document they can draw on later.",
  }[intent] || "";
  const text = await callClaude([
    {
      type: "text",
      text:
        `Design a ${weeks}-week project plan for the passion "${passion}" built around books the learner already owns: ${JSON.stringify(books)}.\n` +
        intentGuide +
        (answer ? `\nThe learner added: "${answer}"` : "") +
        "\nPace the reading across the weeks and pair each week with one hands-on move that advances the project. Keep every field SHORT. " +
        'Respond ONLY with JSON, no prose: {"goal":"one sentence describing what exists at the end","weeks":[{"week":1,"theme":"max 6 words","reading":"book + chapters/pages","move":"one concrete step"}]}',
    },
  ]);
  return parseJson(text);
}

// ---------- Storage (browser localStorage) ----------
async function loadLibrary() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
async function saveLibrary(lib) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
  } catch (e) {
    console.error("Save failed", e);
  }
}
async function clearLibrary() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* already gone */
  }
}

// ---------- Export helpers ----------
function slug(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function planToMarkdown(p) {
  const intentLabel = (INTENTS.find((x) => x.id === p.intent) || {}).label || "";
  const lines = [
    `# ${p.passion} — ${p.weeks}-week passion project`,
    "",
    intentLabel ? `**Intent:** ${intentLabel}` : "",
    p.answer ? `**Shaping note:** ${p.answer}` : "",
    p.goal ? `**By the end:** ${p.goal}` : "",
    "",
    `**Books:** ${p.books.join(" · ")}`,
    "",
    "## Week by week",
    "",
  ];
  for (const w of p.plan || []) {
    lines.push(`### Week ${w.week} — ${w.theme}`);
    lines.push(`- Reading: ${w.reading}`);
    lines.push(`- Move: ${w.move}`);
    lines.push("");
  }
  return lines.filter((l) => l !== "" || true).filter((l) => l !== undefined && l !== null && l !== false).join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Calendar (.ics) export ----------
function nextMondayISO() {
  const d = new Date();
  const offset = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function icsEscape(t) {
  return String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function foldIcsLine(line) {
  const out = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = " " + rest.slice(73);
  }
  out.push(rest);
  return out.join("\r\n");
}

function planToIcs(p, startISO) {
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const now = new Date();
  const dtstamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const [y, m, day] = startISO.split("-").map(Number);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Passion Project Planner//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const w of p.plan || []) {
    const start = new Date(y, m - 1, day + (w.week - 1) * 7);
    const end = new Date(y, m - 1, day + (w.week - 1) * 7 + 1);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${slug(p.passion)}-w${w.week}-${dtstamp}@passion-project-planner`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${fmt(start)}`);
    lines.push(`DTEND;VALUE=DATE:${fmt(end)}`);
    lines.push(foldIcsLine(`SUMMARY:${icsEscape(`Wk ${w.week} of ${p.weeks} · ${w.theme} — ${p.passion}`)}`));
    lines.push(foldIcsLine(`DESCRIPTION:${icsEscape(`Reading: ${w.reading}\nMove: ${w.move}`)}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadIcs(filename, text) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Reusable UI ----------
function PhotoUploader({ photos, setPhotos, compact }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    setUploadError("");
    const next = [];
    const failed = [];
    for (const f of files) {
      try {
        const { base64, mediaType } = await fileToApiImage(f);
        next.push({ name: f.name, base64, mediaType, previewUrl: URL.createObjectURL(f) });
      } catch {
        failed.push(f.name || "photo");
      }
    }
    if (next.length) setPhotos((p) => [...p, ...next]);
    if (failed.length)
      setUploadError(
        `Couldn't read: ${failed.join(", ")}. Try a JPEG or PNG, or upload a screenshot of the photo (screenshots are always PNG).`
      );
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  return (
    <div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles({ target: { files: e.dataTransfer.files } });
        }}
        style={{
          position: "relative",
          border: `1.5px dashed ${T.green}`,
          borderRadius: 10,
          padding: compact ? 20 : 28,
          textAlign: "center",
          background: T.card,
          marginBottom: 14,
        }}
      >
        <div style={{ fontFamily: T.display, fontSize: 17, color: T.greenDark }}>
          Tap to upload photo(s) of your books
        </div>
        <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>
          {busy ? "Processing photo…" : "Bookshelf, Kindle library screen, audiobook app, a stack on your desk — anything readable. You can also drag photos here."}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onFiles}
          aria-label="Upload photos of your books"
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
        />
      </div>
      {uploadError && (
        <div style={{ background: "#FDF3F0", border: "1px solid #E8C4B8", borderRadius: 8, padding: "12px 14px", fontSize: 13.5, marginBottom: 12, lineHeight: 1.5 }}>
          {uploadError}
        </div>
      )}
      {photos.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative" }}>
              <img src={p.previewUrl} alt={p.name} style={{ width: 110, height: 82, objectFit: "cover", borderRadius: 6, border: `1px solid ${T.line}` }} />
              <button
                onClick={() => setPhotos((ph) => ph.filter((_, j) => j !== i))}
                aria-label="Remove photo"
                style={{ position: "absolute", top: -8, right: -8, width: 22, height: 22, borderRadius: "50%", border: "none", background: T.ink, color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: "22px", padding: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ n, text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <span style={{ width: 24, height: 24, borderRadius: "50%", background: T.green, color: "#fff", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
      <span style={{ fontFamily: T.display, fontSize: 17, fontWeight: 600 }}>{text}</span>
    </div>
  );
}

function AgentLog({ title, log }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 24 }}>
      <div style={{ fontFamily: T.display, fontSize: 19, marginBottom: 14, color: T.greenDark }}>{title}</div>
      {log.map((l, i) => (
        <div key={i} style={{ fontSize: 14, padding: "6px 0", color: i === log.length - 1 ? T.ink : T.muted, display: "flex", gap: 8 }}>
          <span style={{ color: T.marigold }}>{i === log.length - 1 ? "◐" : "✓"}</span>
          {l}
        </div>
      ))}
    </div>
  );
}

const btnPrimary = (enabled = true) => ({
  width: "100%",
  padding: "15px",
  fontSize: 16,
  fontFamily: T.display,
  fontWeight: 600,
  color: "#fff",
  background: enabled ? T.green : "#B9C4B6",
  border: "none",
  borderRadius: 8,
  cursor: enabled ? "pointer" : "default",
});

const btnSecondary = () => ({
  padding: "11px 20px",
  fontSize: 14.5,
  fontWeight: 600,
  color: T.greenDark,
  background: "transparent",
  border: `1.5px solid ${T.green}`,
  borderRadius: 8,
  cursor: "pointer",
  fontFamily: T.body,
});

// ---------- Main app ----------
export default function PassionProjectAgent() {
  // library = { projects: [{passion, intent, answer, question, books[], weeks, goal, plan[]}], unmatched: [] }
  const [library, setLibrary] = useState(null);
  const [phase, setPhase] = useState("boot"); // boot | setup | scanning | shape | building | library | adding | merging | confirmAdd | error
  const [photos, setPhotos] = useState([]);
  const [manualTitles, setManualTitles] = useState("");
  const [passionsInput, setPassionsInput] = useState("");
  const [log, setLog] = useState([]);
  const [shaping, setShaping] = useState([]); // [{passion, books[], question, intent, answer}]
  const [pendingAdd, setPendingAdd] = useState(null);
  const [alignDraft, setAlignDraft] = useState(null); // {names:[], rows:[{title, in:{passion:bool}}]}
  const [newPassion, setNewPassion] = useState(null); // {name, intent} | null
  const [copied, setCopied] = useState(-1);
  const [startDates, setStartDates] = useState({}); // project index -> "YYYY-MM-DD" // {matches:[{passion, newBooks[], selected}], unmatched:[]}
  const [errorMsg, setErrorMsg] = useState("");
  const [openProject, setOpenProject] = useState(0);

  const addLog = (m) => setLog((l) => [...l, m]);

  useEffect(() => {
    (async () => {
      const lib = await loadLibrary();
      if (lib && lib.projects && lib.projects.length) {
        setLibrary(lib);
        setPhase("library");
      } else {
        setPhase("setup");
      }
    })();
  }, []);

  // ---- First-time scan: photos -> titles -> categories -> shaping questions ----
  const runScan = async () => {
    const passions = passionsInput.split(",").map((s) => s.trim()).filter(Boolean);
    const typed = manualTitles.split("\n").map((s) => s.trim()).filter(Boolean);
    if ((!photos.length && !typed.length) || !passions.length) return;
    setPhase("scanning");
    setLog([]);
    try {
      let all = typed.map((t) => ({ title: t }));
      for (let i = 0; i < photos.length; i++) {
        addLog(`Reading titles in photo ${i + 1} of ${photos.length}…`);
        all = all.concat(await extractTitles(photos[i].base64, photos[i].mediaType));
      }
      const seen = new Set();
      const titles = all
        .map((b) => b.title)
        .filter((t) => {
          const k = (t || "").toLowerCase();
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      addLog(`Found ${titles.length} titles.`);
      if (!titles.length) throw new Error("No readable titles found — try a closer, well-lit photo.");

      addLog("Matching titles to your passions…");
      const sorted = await categorize(titles, passions);
      const cats = (sorted.categories || []).filter((c) => c.books && c.books.length);
      if (!cats.length) throw new Error("No books matched your passions. Try broader passion names or another photo.");

      const shaped = [];
      for (const c of cats) {
        addLog(`Drafting coach questions for \u201c${c.passion}\u201d\u2026`);
        let intents = null;
        try {
          intents = await genShaping(c.passion, c.books);
        } catch (e) {
          console.error("Shaping generation failed for", c.passion, e);
        }
        shaped.push({ passion: c.passion, books: c.books, intents, intent: "learn", answer: "" });
      }
      setShaping(shaped);
      setLibrary({ projects: [], unmatched: sorted.unmatched || [] });
      setManualTitles("");
      setPhase("shape");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  // ---- Build plans from shaped passions ----
  const runBuild = async () => {
    setPhase("building");
    setLog([]);
    try {
      const projects = [];
      for (const s of shaping) {
        const weeks = scheduleFor(s.books.length);
        addLog(`Designing a ${weeks}-week plan for “${s.passion}”…`);
        const { goal, weeks: plan } = await buildPlan(s.passion, s.intent, s.answer, s.books, weeks);
        projects.push({ ...s, weeks, goal, plan: plan || [] });
      }
      const lib = { projects, unmatched: (library && library.unmatched) || [] };
      setLibrary(lib);
      await saveLibrary(lib);
      setOpenProject(0);
      setPhase("library");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  // ---- Add-books loop: scan new photos, propose merges ----
  const runAddScan = async () => {
    const typed = manualTitles.split("\n").map((s) => s.trim()).filter(Boolean);
    if ((!photos.length && !typed.length) || !library) return;
    setPhase("merging");
    setLog([]);
    try {
      let all = typed.map((t) => ({ title: t }));
      for (let i = 0; i < photos.length; i++) {
        addLog(`Reading titles in photo ${i + 1} of ${photos.length}…`);
        all = all.concat(await extractTitles(photos[i].base64, photos[i].mediaType));
      }
      const owned = new Set(
        library.projects.flatMap((p) => p.books).concat(library.unmatched).map((t) => t.toLowerCase())
      );
      const seen = new Set();
      const titles = all
        .map((b) => b.title)
        .filter((t) => {
          const k = (t || "").toLowerCase();
          if (!k || seen.has(k) || owned.has(k)) return false;
          seen.add(k);
          return true;
        });
      if (!titles.length) throw new Error("No new titles found — everything in these photos is already in your library.");
      addLog(`Found ${titles.length} new titles. Matching to your projects…`);

      const passions = library.projects.map((p) => p.passion);
      const sorted = await categorize(titles, passions);
      const matches = (sorted.categories || [])
        .filter((c) => c.books && c.books.length)
        .map((c) => ({ passion: c.passion, newBooks: c.books, selected: true }));
      setPendingAdd({ matches, unmatched: sorted.unmatched || [] });
      setManualTitles("");
      setPhase("confirmAdd");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  const runMerge = async () => {
    setPhase("building");
    setLog([]);
    try {
      const lib = { ...library, projects: [...library.projects], unmatched: [...library.unmatched] };
      for (const m of pendingAdd.matches) {
        const idx = lib.projects.findIndex((p) => p.passion === m.passion);
        if (idx === -1 || !m.selected) continue;
        const proj = lib.projects[idx];
        const fresh = m.newBooks.filter((b) => !proj.books.includes(b));
        if (!fresh.length) continue;
        const books = [...proj.books, ...fresh];
        const weeks = scheduleFor(books.length);
        addLog(
          weeks !== proj.weeks
            ? `Rebuilding \u201c${proj.passion}\u201d with ${fresh.length} new book(s) \u2014 plan grows to ${weeks} weeks\u2026`
            : `Rebuilding \u201c${proj.passion}\u201d with ${fresh.length} new book(s)\u2026`
        );
        const { goal, weeks: plan } = await buildPlan(proj.passion, proj.intent, proj.answer, books, weeks);
        lib.projects[idx] = { ...proj, books, weeks, goal, plan: plan || [], stale: false };
      }
      // Any new title that landed in no project is kept in the unmatched pool
      const seenNew = new Set();
      const allNew = [...pendingAdd.matches.flatMap((m) => m.newBooks), ...pendingAdd.unmatched].filter((t) => {
        const k = t.toLowerCase();
        if (seenNew.has(k)) return false;
        seenNew.add(k);
        return true;
      });
      const inAnyProject = new Set(lib.projects.flatMap((pr) => pr.books).map((t) => t.toLowerCase()));
      lib.unmatched = [...lib.unmatched, ...allNew.filter((t) => !inAnyProject.has(t.toLowerCase()))];
      setLibrary(lib);
      await saveLibrary(lib);
      setPendingAdd(null);
      setPhotos([]);
      setPhase("library");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  // ---- Manual alignment: any book <-> any passion, many-to-many ----
  const openAlign = () => {
    const names = library.projects.map((p) => p.passion);
    const seen = new Set();
    const titles = [...library.projects.flatMap((p) => p.books), ...library.unmatched].filter((t) => {
      const k = (t || "").toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const rows = titles.map((t) => ({
      title: t,
      in: Object.fromEntries(names.map((n) => [n, library.projects.find((p) => p.passion === n).books.includes(t)])),
    }));
    setAlignDraft({ names, rows });
    setPhase("align");
  };

  const applyAlign = async () => {
    const lib = { ...library };
    lib.projects = library.projects.map((p) => {
      const books = alignDraft.rows.filter((r) => r.in[p.passion]).map((r) => r.title);
      const changed = books.join("|") !== p.books.join("|");
      if (!changed) return p;
      return books.length
        ? { ...p, books, stale: true }
        : { ...p, books, plan: [], goal: "", weeks: 0, stale: false };
    });
    lib.unmatched = alignDraft.rows.filter((r) => alignDraft.names.every((n) => !r.in[n])).map((r) => r.title);
    setLibrary(lib);
    await saveLibrary(lib);
    setAlignDraft(null);
    setPhase("library");
  };

  const rebuildProject = async (i) => {
    setPhase("building");
    setLog([]);
    try {
      const proj = library.projects[i];
      const weeks = scheduleFor(proj.books.length);
      addLog(`Rebuilding \u201c${proj.passion}\u201d as a ${weeks}-week plan\u2026`);
      const { goal, weeks: plan } = await buildPlan(proj.passion, proj.intent, proj.answer, proj.books, weeks);
      const lib = {
        ...library,
        projects: library.projects.map((x, j) => (j === i ? { ...x, weeks, goal, plan: plan || [], stale: false } : x)),
      };
      setLibrary(lib);
      await saveLibrary(lib);
      setPhase("library");
    } catch (e) {
      setErrorMsg(e.message);
      setPhase("error");
    }
  };

  const addPassion = async () => {
    const name = ((newPassion && newPassion.name) || "").trim();
    if (!name || library.projects.some((p) => p.passion.toLowerCase() === name.toLowerCase())) return;
    const lib = {
      ...library,
      projects: [
        ...library.projects,
        { passion: name, intent: newPassion.intent, answer: "", question: "", books: [], weeks: 0, goal: "", plan: [], stale: false },
      ],
    };
    setLibrary(lib);
    await saveLibrary(lib);
    setNewPassion(null);
  };

  const copyPlan = async (i) => {
    const md = planToMarkdown(library.projects[i]);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(i);
      setTimeout(() => setCopied(-1), 1500);
    } catch {
      // Clipboard blocked in this environment — fall back to a download
      downloadText(`${slug(library.projects[i].passion)}-plan.md`, md);
    }
  };

  const exportAll = () => {
    const withPlans = library.projects.filter((p) => p.plan && p.plan.length);
    downloadText("passion-project-plans.md", withPlans.map(planToMarkdown).join("\n\n---\n\n"));
  };

  const startOver = async () => {
    await clearLibrary();
    setLibrary(null);
    setPhotos([]);
    setPassionsInput("");
    setManualTitles("");
    setShaping([]);
    setPendingAdd(null);
    setPhase("setup");
  };

  const passionCount = passionsInput.split(",").map((s) => s.trim()).filter(Boolean).length;
  const hasBooks = photos.length > 0 || manualTitles.trim().length > 0;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: T.body, padding: "40px 20px" }}>
      <div style={{ maxWidth: 780, margin: "0 auto" }}>
        <div style={{ borderBottom: `3px double ${T.green}`, paddingBottom: 20, marginBottom: 28 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: T.green, marginBottom: 6 }}>
            Personal Library · Passion Projects
          </div>
          <h1 style={{ fontFamily: T.display, fontSize: 34, margin: 0, fontWeight: 600, lineHeight: 1.15 }}>Passion Project Planner</h1>
          <p style={{ color: T.muted, margin: "8px 0 0", fontSize: 15, maxWidth: 580 }}>
            Show the agent the books you already own, name your passions, shape what you want each project to do — and get a week-by-week plan.
          </p>
        </div>

        {phase === "boot" && <div style={{ color: T.muted, fontSize: 14 }}>Opening your library…</div>}

        {phase === "setup" && (
          <div>
            <SectionLabel n="1" text="Show your books" />
            <PhotoUploader photos={photos} setPhotos={setPhotos} />
            <div style={{ fontSize: 13, color: T.muted, margin: "2px 0 8px" }}>
              Photo upload not working on your device? Type or paste titles instead — one per line:
            </div>
            <textarea
              value={manualTitles}
              onChange={(e) => setManualTitles(e.target.value)}
              placeholder={"Walkable City\nThe Design of Everyday Things\n…"}
              rows={3}
              style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 14, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.card, color: T.ink, outline: "none", resize: "vertical", fontFamily: T.body, marginBottom: 4 }}
            />
            <div style={{ height: 12 }} />
            <SectionLabel n="2" text="Name your passions" />
            <input
              value={passionsInput}
              onChange={(e) => setPassionsInput(e.target.value)}
              placeholder="e.g. street safety advocacy, human-centered design, launching a newsletter"
              style={{ width: "100%", boxSizing: "border-box", padding: "13px 15px", fontSize: 15, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.card, color: T.ink, outline: "none", marginBottom: 6, fontFamily: T.body }}
            />
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 26 }}>Separate with commas. The agent matches books to whichever passion fits best.</div>
            <button onClick={runScan} disabled={!(hasBooks && passionCount)} style={btnPrimary(hasBooks && passionCount > 0)}>
              Scan my library
            </button>
            <div style={{ fontSize: 12.5, color: T.muted, marginTop: 10, textAlign: "center" }}>
              1 book in a passion → 4 weeks · 2–3 books → 8 weeks · 4+ books → 12 weeks
            </div>
          </div>
        )}

        {(phase === "scanning" || phase === "merging") && <AgentLog title="The librarian is working…" log={log} />}
        {phase === "building" && <AgentLog title="Designing your plans…" log={log} />}

        {phase === "shape" && (
          <div>
            <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 600, marginBottom: 6 }}>Put shape to each passion</div>
            <div style={{ fontSize: 14, color: T.muted, marginBottom: 20 }}>
              The agent found books for {shaping.length} of your passions. Tell it what each project should <em>do</em>.
            </div>
            {shaping.map((s, i) => (
              <div key={i} style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 22, marginBottom: 18 }}>
                <div style={{ fontFamily: T.display, fontSize: 20, fontWeight: 600 }}>{s.passion}</div>
                <div style={{ fontSize: 13.5, marginTop: 4, marginBottom: 14 }}>
                  <span style={{ color: T.muted }}>From your library: </span>
                  <em style={{ fontFamily: T.display }}>{s.books.join(" · ")}</em>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  {INTENTS.map((it) => {
                    const active = s.intent === it.id;
                    return (
                      <button
                        key={it.id}
                        onClick={() => setShaping((sh) => sh.map((x, j) => (j === i ? { ...x, intent: it.id } : x)))}
                        title={it.hint}
                        style={{
                          padding: "8px 14px",
                          fontSize: 13.5,
                          fontWeight: 600,
                          borderRadius: 20,
                          border: `1.5px solid ${active ? T.green : T.line}`,
                          background: active ? T.green : "transparent",
                          color: active ? "#fff" : T.ink,
                          cursor: "pointer",
                          fontFamily: T.body,
                        }}
                      >
                        {it.label}
                      </button>
                    );
                  })}
                </div>
                {(() => {
                  const iq = (s.intents && s.intents[s.intent]) || {};
                  const suggestions = Array.isArray(iq.suggestions) ? iq.suggestions : [];
                  return (
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                        <span style={{ color: T.marigoldInk }}>Coach asks: </span>
                        {iq.question || FALLBACK_Q[s.intent]}
                      </div>
                      {suggestions.length > 0 && (
                        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
                          {suggestions.map((sug, k) => {
                            const chosen = s.answer === sug;
                            return (
                              <button
                                key={k}
                                onClick={() => setShaping((sh) => sh.map((x, j) => (j === i ? { ...x, answer: chosen ? "" : sug } : x)))}
                                style={{ padding: "6px 12px", fontSize: 12.5, fontWeight: 500, borderRadius: 18, border: `1.5px dashed ${chosen ? T.green : T.line}`, background: chosen ? "#EAF2ED" : "transparent", color: chosen ? T.greenDark : T.muted, cursor: "pointer", fontFamily: T.body, textAlign: "left" }}
                              >
                                {sug}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <textarea
                  value={s.answer}
                  onChange={(e) => setShaping((sh) => sh.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))}
                  placeholder="Tap a suggestion above or write your own — this steers the whole plan."
                  rows={2}
                  style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 14, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.bg, color: T.ink, outline: "none", resize: "vertical", fontFamily: T.body }}
                />
              </div>
            ))}
            <button onClick={runBuild} style={btnPrimary(true)}>Build my project plans</button>
          </div>
        )}

        {phase === "confirmAdd" && pendingAdd && (
          <div>
            <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 600, marginBottom: 6 }}>New books found</div>
            <div style={{ fontSize: 14, color: T.muted, marginBottom: 18 }}>
              Choose which projects to fold them into — a book can join more than one. Rebuilt plans keep your intent and answers; the schedule grows if the book count crosses a threshold.
            </div>
            {pendingAdd.matches.length === 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 20, marginBottom: 16, fontSize: 14 }}>
                None of the new titles matched an existing project. They'll be kept in your unmatched list.
              </div>
            )}
            {pendingAdd.matches.map((m, i) => (
              <label key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18, marginBottom: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={m.selected}
                  onChange={() => setPendingAdd((pa) => ({ ...pa, matches: pa.matches.map((x, j) => (j === i ? { ...x, selected: !x.selected } : x)) }))}
                  style={{ marginTop: 3, width: 17, height: 17, accentColor: T.green }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{m.passion}</div>
                  <div style={{ fontSize: 13.5, marginTop: 3 }}>
                    <span style={{ color: T.muted }}>Add: </span>
                    <em style={{ fontFamily: T.display }}>{m.newBooks.join(" · ")}</em>
                  </div>
                </div>
              </label>
            ))}
            {pendingAdd.unmatched.length > 0 && (
              <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
                Not matched to any project: {pendingAdd.unmatched.join(" · ")}
              </div>
            )}
            <button onClick={runMerge} style={btnPrimary(true)}>
              {pendingAdd.matches.some((m) => m.selected) ? "Update my projects" : "Save without updating plans"}
            </button>
            <div style={{ marginTop: 10, textAlign: "center" }}>
              <button onClick={() => { setPendingAdd(null); setPhotos([]); setPhase("library"); }} style={{ ...btnSecondary(), border: "none", textDecoration: "underline" }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === "adding" && (
          <div>
            <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 600, marginBottom: 12 }}>Add new books</div>
            <PhotoUploader photos={photos} setPhotos={setPhotos} compact />
            <div style={{ fontSize: 13, color: T.muted, margin: "2px 0 8px" }}>Or type/paste new titles, one per line:</div>
            <textarea
              value={manualTitles}
              onChange={(e) => setManualTitles(e.target.value)}
              rows={3}
              style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 14, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.card, color: T.ink, outline: "none", resize: "vertical", fontFamily: T.body, marginBottom: 12 }}
            />
            <button onClick={runAddScan} disabled={!hasBooks} style={btnPrimary(hasBooks)}>
              Scan for new books
            </button>
            <div style={{ marginTop: 10, textAlign: "center" }}>
              <button onClick={() => { setPhotos([]); setPhase("library"); }} style={{ ...btnSecondary(), border: "none", textDecoration: "underline" }}>
                Back to my projects
              </button>
            </div>
          </div>
        )}

        {phase === "align" && alignDraft && (
          <div>
            <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 600, marginBottom: 6 }}>Align books to passions</div>
            <div style={{ fontSize: 14, color: T.muted, marginBottom: 18 }}>
              Tap to add or remove a book from a passion — a book can belong to several at once. Changed projects will offer a rebuilt plan.
            </div>
            {alignDraft.rows.map((r, ri) => (
              <div key={ri} style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: "14px 18px", marginBottom: 10 }}>
                <div style={{ fontFamily: T.display, fontSize: 15.5, marginBottom: 9 }}>{r.title}</div>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  {alignDraft.names.map((n) => {
                    const active = r.in[n];
                    return (
                      <button
                        key={n}
                        onClick={() =>
                          setAlignDraft((d) => ({
                            ...d,
                            rows: d.rows.map((x, j) => (j === ri ? { ...x, in: { ...x.in, [n]: !x.in[n] } } : x)),
                          }))
                        }
                        style={{ padding: "6px 12px", fontSize: 12.5, fontWeight: 600, borderRadius: 18, border: `1.5px solid ${active ? T.green : T.line}`, background: active ? T.green : "transparent", color: active ? "#fff" : T.muted, cursor: "pointer", fontFamily: T.body }}
                      >
                        {active ? "✓ " : "+ "}{n}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div style={{ height: 8 }} />
            <button onClick={applyAlign} style={btnPrimary(true)}>Save alignment</button>
            <div style={{ marginTop: 10, textAlign: "center" }}>
              <button onClick={() => { setAlignDraft(null); setPhase("library"); }} style={{ ...btnSecondary(), border: "none", textDecoration: "underline" }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div style={{ background: "#FDF3F0", border: "1px solid #E8C4B8", borderRadius: 10, padding: 22 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>The agent hit a snag</div>
            <div style={{ fontSize: 14, color: T.muted, marginBottom: 16 }}>{errorMsg}</div>
            <button onClick={() => setPhase(library && library.projects && library.projects.length ? "library" : "setup")} style={btnSecondary()}>
              Go back
            </button>
          </div>
        )}

        {phase === "library" && library && (
          <div>
            <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
              <button onClick={() => setPhase("adding")} style={{ ...btnSecondary(), background: T.green, color: "#fff", border: `1.5px solid ${T.green}` }}>
                + Add new books
              </button>
              <button onClick={openAlign} style={btnSecondary()}>Align books</button>
              <button onClick={() => setNewPassion({ name: "", intent: "learn" })} style={btnSecondary()}>+ Add a passion</button>
              {library.projects.some((p) => p.plan && p.plan.length > 0) && (
                <button onClick={exportAll} style={btnSecondary()}>Export all</button>
              )}
              <button onClick={startOver} style={btnSecondary()}>Start over</button>
            </div>
            {newPassion && (
              <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 18, marginBottom: 18 }}>
                <div style={{ fontFamily: T.display, fontSize: 18, fontWeight: 600, marginBottom: 10 }}>New passion</div>
                <input
                  value={newPassion.name}
                  onChange={(e) => setNewPassion({ ...newPassion, name: e.target.value })}
                  placeholder="e.g. pedestrian advocacy"
                  style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 14.5, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.bg, color: T.ink, outline: "none", fontFamily: T.body, marginBottom: 12 }}
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                  {INTENTS.map((it) => {
                    const active = newPassion.intent === it.id;
                    return (
                      <button key={it.id} onClick={() => setNewPassion({ ...newPassion, intent: it.id })} title={it.hint}
                        style={{ padding: "7px 13px", fontSize: 13, fontWeight: 600, borderRadius: 20, border: `1.5px solid ${active ? T.green : T.line}`, background: active ? T.green : "transparent", color: active ? "#fff" : T.ink, cursor: "pointer", fontFamily: T.body }}>
                        {it.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={addPassion} style={{ ...btnSecondary(), background: T.green, color: "#fff" }}>Save passion</button>
                  <button onClick={() => setNewPassion(null)} style={btnSecondary()}>Cancel</button>
                </div>
                <div style={{ fontSize: 12.5, color: T.muted, marginTop: 10 }}>
                  Then use "Align books" to move existing titles into it — or it will catch matches from your next upload.
                </div>
              </div>
            )}
            {library.projects.map((p, i) => {
              const open = openProject === i;
              const intentLabel = (INTENTS.find((x) => x.id === p.intent) || {}).label || "";
              return (
                <div key={i} style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, marginBottom: 18, overflow: "hidden" }}>
                  <button
                    onClick={() => setOpenProject(open ? -1 : i)}
                    style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "18px 22px", borderBottom: open ? `2px solid ${T.green}` : "none", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", fontFamily: T.body, color: T.ink }}
                  >
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: T.muted }}>{intentLabel}</div>
                      <div style={{ fontFamily: T.display, fontSize: 22, fontWeight: 600 }}>{p.passion}</div>
                    </div>
                    <div style={{ border: `2px solid ${T.marigold}`, color: T.marigoldInk, borderRadius: 6, padding: "4px 12px", fontSize: 13, fontWeight: 700, transform: "rotate(-2deg)", letterSpacing: "0.06em" }}>
                      {p.weeks ? `${p.weeks}-WEEK PLAN` : "NO PLAN YET"}
                    </div>
                  </button>
                  {open && (
                    <div>
                      {p.stale && p.books.length > 0 && (
                        <div style={{ padding: "13px 22px", borderBottom: `1px solid ${T.line}`, fontSize: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#FBF6EA" }}>
                          <span>Books changed — this plan is out of date.</span>
                          <button onClick={() => rebuildProject(i)} style={{ ...btnSecondary(), padding: "7px 14px", fontSize: 13.5 }}>
                            Rebuild as {scheduleFor(p.books.length)}-week plan
                          </button>
                        </div>
                      )}
                      {p.books.length === 0 && (
                        <div style={{ padding: "13px 22px", borderBottom: `1px solid ${T.line}`, fontSize: 14, color: T.muted }}>
                          No books aligned to this passion yet — use "Align books" or upload more.
                        </div>
                      )}
                      {p.goal && (
                        <div style={{ padding: "13px 22px", borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
                          <span style={{ color: T.marigoldInk, fontWeight: 700 }}>By the end: </span>
                          {p.goal}
                        </div>
                      )}
                      <div style={{ padding: "13px 22px", borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
                        <span style={{ color: T.muted }}>From your library: </span>
                        <em style={{ fontFamily: T.display }}>{p.books.join(" · ")}</em>
                      </div>
                      {p.plan.map((w) => (
                        <div key={w.week} style={{ display: "flex", gap: 16, padding: "14px 22px", borderBottom: `1px solid ${T.line}` }}>
                          <div style={{ fontFamily: T.display, color: T.green, fontWeight: 700, minWidth: 52, fontSize: 15 }}>Wk {w.week}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 14.5 }}>{w.theme}</div>
                            <div style={{ fontSize: 13.5, marginTop: 3 }}>{w.reading}</div>
                            <div style={{ fontSize: 13.5, color: T.muted, marginTop: 3 }}>
                              <span style={{ color: T.marigoldInk, fontWeight: 700 }}>Move: </span>
                              {w.move}
                            </div>
                          </div>
                        </div>
                      ))}
                      {p.plan && p.plan.length > 0 && (
                        <div style={{ padding: "14px 22px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                          <button onClick={() => downloadText(`${slug(p.passion)}-plan.md`, planToMarkdown(p))} style={{ ...btnSecondary(), padding: "8px 15px", fontSize: 13.5 }}>
                            Download .md
                          </button>
                          <button onClick={() => copyPlan(i)} style={{ ...btnSecondary(), padding: "8px 15px", fontSize: 13.5 }}>
                            {copied === i ? "Copied!" : "Copy plan"}
                          </button>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <label style={{ fontSize: 13, color: T.muted }}>Starts:</label>
                            <input
                              type="date"
                              value={startDates[i] || nextMondayISO()}
                              onChange={(e) => setStartDates((sd) => ({ ...sd, [i]: e.target.value }))}
                              style={{ padding: "6px 9px", fontSize: 13, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.bg, color: T.ink, fontFamily: T.body }}
                            />
                            <button
                              onClick={() => downloadIcs(`${slug(p.passion)}-plan.ics`, planToIcs(p, startDates[i] || nextMondayISO()))}
                              style={{ ...btnSecondary(), padding: "8px 15px", fontSize: 13.5 }}
                            >
                              Add to calendar (.ics)
                            </button>
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {library.unmatched && library.unmatched.length > 0 && (
              <div style={{ fontSize: 13.5, color: T.muted, marginTop: 8 }}>
                <span style={{ fontWeight: 600 }}>In your library, not yet in a project: </span>
                {library.unmatched.join(" · ")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
