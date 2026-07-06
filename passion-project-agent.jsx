import { useState, useRef, useEffect } from "react";

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
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
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

function fileToBase64Jpeg(file, maxEdge = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = url;
  });
}

// ---------- Agent steps ----------
async function extractTitles(base64) {
  const text = await callClaude([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
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
        'Assign each book to the single best-fitting passion category, but only if it is genuinely relevant. Books that fit none go in "unmatched". Respond ONLY with JSON, no prose: {"categories":[{"passion":"...","books":["title"]}],"unmatched":["title"]}',
    },
  ]);
  return parseJson(text);
}

async function genQuestions(cats) {
  const text = await callClaude([
    {
      type: "text",
      text:
        `A learner has these passion projects, each with books they already own: ${JSON.stringify(
          cats.map((c) => ({ passion: c.passion, books: c.books }))
        )}\n` +
        "For EACH passion, write ONE sharp, specific clarifying question a good coach would ask to shape the project — grounded in the actual books listed. Keep each under 25 words. " +
        'Respond ONLY with JSON, no prose: {"questions":[{"passion":"...","question":"..."}]}',
    },
  ]);
  const parsed = parseJson(text);
  return parsed.questions || [];
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

// ---------- Storage ----------
async function loadLibrary() {
  try {
    const r = await window.storage.get(STORAGE_KEY);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}
async function saveLibrary(lib) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(lib));
  } catch (e) {
    console.error("Save failed", e);
  }
}
async function clearLibrary() {
  try {
    await window.storage.delete(STORAGE_KEY);
  } catch {
    /* already gone */
  }
}

// ---------- Reusable UI ----------
function PhotoUploader({ photos, setPhotos, compact }) {
  const fileRef = useRef(null);
  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    const next = [];
    for (const f of files) {
      try {
        const base64 = await fileToBase64Jpeg(f);
        next.push({ name: f.name, base64, previewUrl: URL.createObjectURL(f) });
      } catch {
        /* skip unreadable */
      }
    }
    setPhotos((p) => [...p, ...next]);
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
          Bookshelf, Kindle library screen, audiobook app, a stack on your desk — anything readable. You can also drag photos here.
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
  const [passionsInput, setPassionsInput] = useState("");
  const [log, setLog] = useState([]);
  const [shaping, setShaping] = useState([]); // [{passion, books[], question, intent, answer}]
  const [pendingAdd, setPendingAdd] = useState(null); // {matches:[{passion, newBooks[], selected}], unmatched:[]}
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
    if (!photos.length || !passions.length) return;
    setPhase("scanning");
    setLog([]);
    try {
      let all = [];
      for (let i = 0; i < photos.length; i++) {
        addLog(`Reading titles in photo ${i + 1} of ${photos.length}…`);
        all = all.concat(await extractTitles(photos[i].base64));
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

      addLog("Drafting a shaping question for each passion…");
      const qs = await genQuestions(cats);
      const qMap = Object.fromEntries(qs.map((q) => [q.passion, q.question]));

      setShaping(
        cats.map((c) => ({
          passion: c.passion,
          books: c.books,
          question: qMap[c.passion] || "What would make this project feel worth the weeks you'll give it?",
          intent: "learn",
          answer: "",
        }))
      );
      setLibrary({ projects: [], unmatched: sorted.unmatched || [] });
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
    if (!photos.length || !library) return;
    setPhase("merging");
    setLog([]);
    try {
      let all = [];
      for (let i = 0; i < photos.length; i++) {
        addLog(`Reading titles in photo ${i + 1} of ${photos.length}…`);
        all = all.concat(await extractTitles(photos[i].base64));
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
      const lib = { ...library, projects: [...library.projects], unmatched: [...library.unmatched, ...pendingAdd.unmatched] };
      for (const m of pendingAdd.matches) {
        const idx = lib.projects.findIndex((p) => p.passion === m.passion);
        if (idx === -1) continue;
        if (!m.selected) {
          lib.unmatched = [...lib.unmatched, ...m.newBooks];
          continue;
        }
        const proj = lib.projects[idx];
        const books = [...proj.books, ...m.newBooks];
        const weeks = scheduleFor(books.length);
        addLog(
          weeks !== proj.weeks
            ? `Rebuilding “${proj.passion}” with ${m.newBooks.length} new book(s) — plan grows to ${weeks} weeks…`
            : `Rebuilding “${proj.passion}” with ${m.newBooks.length} new book(s)…`
        );
        const { goal, weeks: plan } = await buildPlan(proj.passion, proj.intent, proj.answer, books, weeks);
        lib.projects[idx] = { ...proj, books, weeks, goal, plan: plan || [] };
      }
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

  const startOver = async () => {
    await clearLibrary();
    setLibrary(null);
    setPhotos([]);
    setPassionsInput("");
    setShaping([]);
    setPendingAdd(null);
    setPhase("setup");
  };

  const passionCount = passionsInput.split(",").map((s) => s.trim()).filter(Boolean).length;

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
            <div style={{ height: 12 }} />
            <SectionLabel n="2" text="Name your passions" />
            <input
              value={passionsInput}
              onChange={(e) => setPassionsInput(e.target.value)}
              placeholder="e.g. street safety advocacy, human-centered design, launching a newsletter"
              style={{ width: "100%", boxSizing: "border-box", padding: "13px 15px", fontSize: 15, border: `1.5px solid ${T.line}`, borderRadius: 8, background: T.card, color: T.ink, outline: "none", marginBottom: 6, fontFamily: T.body }}
            />
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 26 }}>Separate with commas. The agent matches books to whichever passion fits best.</div>
            <button onClick={runScan} disabled={!(photos.length && passionCount)} style={btnPrimary(photos.length > 0 && passionCount > 0)}>
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
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                  <span style={{ color: T.marigoldInk }}>Coach asks: </span>
                  {s.question}
                </div>
                <textarea
                  value={s.answer}
                  onChange={(e) => setShaping((sh) => sh.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))}
                  placeholder="A sentence or two is plenty — this steers the whole plan."
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
              Choose which projects to fold them into. Rebuilt plans keep your intent and answers; the schedule grows if the book count crosses a threshold.
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
            <button onClick={runAddScan} disabled={!photos.length} style={btnPrimary(photos.length > 0)}>
              Scan for new books
            </button>
            <div style={{ marginTop: 10, textAlign: "center" }}>
              <button onClick={() => { setPhotos([]); setPhase("library"); }} style={{ ...btnSecondary(), border: "none", textDecoration: "underline" }}>
                Back to my projects
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
              <button onClick={startOver} style={btnSecondary()}>Start over</button>
            </div>
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
                      {p.weeks}-WEEK PLAN
                    </div>
                  </button>
                  {open && (
                    <div>
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
