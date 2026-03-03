require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const LRUCache = require("lru-cache");
const { createClient } = require("@supabase/supabase-js");
const { OpenAI } = require("openai");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/* =========================
   ENV
   ========================= */
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// (opțional, recomandat) token simplu ca să nu-ți abuzeze endpoint-ul
// Setezi în Render: QUIZ_TOKEN=un_string_lung_random
const QUIZ_TOKEN = process.env.QUIZ_TOKEN || "";

/* =========================
   Clients
   ========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   Middlewares
   ========================= */
app.use(express.json({ limit: "1mb" }));

// ✅ CORS: permite doar site-ul tău WP (adaugă și varianta cu www dacă o folosești)
const ALLOWED_ORIGINS = new Set([
  "https://grey-pheasant-306609.hostingersite.com",
]);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      return cb(null, ALLOWED_ORIGINS.has(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Quiz-Token"],
  })
);

// ✅ token (dacă ai setat QUIZ_TOKEN în Render)
function checkToken(req, res, next) {
  if (!QUIZ_TOKEN) return next();
  const got = req.headers["x-quiz-token"];
  if (got !== QUIZ_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ✅ rate limit simplu pe IP (30 req/min)
const hits = new LRUCache({ max: 3000, ttl: 1000 * 60 });
function rateLimit(req, res, next) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const key = `ip:${ip}`;
  const count = (hits.get(key) || 0) + 1;
  hits.set(key, count);
  if (count > 30) return res.status(429).json({ error: "Too many requests. Try again soon." });
  next();
}

// ✅ cache 20 min (cost saver)
const cache = new LRUCache({ max: 800, ttl: 1000 * 60 * 20 });

/* =========================
   Health
   ========================= */
app.get("/health", (req, res) => res.send("ok"));

/* =========================
   EXISTING ROUTE (image -> quiz)
   păstrată, doar am pus port din env.
   ========================= */
app.post("/api/generate-quiz", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // 1) Upload în Supabase
    const fileName = `${Date.now()}-${req.file.originalname}`;
    const { error: upError } = await supabase.storage
      .from("uploads")
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (upError) throw upError;

    // 2) Link public
    const { data } = supabase.storage.from("uploads").getPublicUrl(fileName);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) throw new Error("Could not get public URL");

    // 3) OpenAI (vision) -> quiz JSON
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            'Ești un profesor expert. Generează un quiz de 5 întrebări grilă din poza primită, în format JSON curat: {"items":[{"question":"...","options":["A","B","C","D"],"correct_index":0}]}',
        },
        { role: "user", content: [{ type: "image_url", image_url: { url: publicUrl } }] },
      ],
      response_format: { type: "json_object" },
      temperature: 0.6,
    });

    const raw = response.choices?.[0]?.message?.content || "{}";
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Invalid JSON from model", raw });
    }

    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   NEW ROUTE (text params -> quiz)
   ✅ pentru pagina /quiz/ din WordPress
   POST /api/quiz/generate
   ========================= */
function normalizeInput(body = {}) {
  const level = String(body.level || "scoala").toLowerCase();
  const year = String(body.year || "1");
  const profile = String(body.profile || "");
  const subject = String(body.subject || "").trim();
  const chapter = String(body.chapter || "").trim();
  const difficulty = String(body.difficulty || "auto").toLowerCase();
  const quizType = String(body.quizType || "mcq4").toLowerCase();
  const mode = String(body.mode || "solo").toLowerCase();
  const seed = String(body.seed || "");

  let count = parseInt(body.count || "10", 10);
  if (!Number.isFinite(count)) count = 10;
  count = Math.max(3, Math.min(count, 20));

  const allowedTypes = new Set(["mcq4", "mcq3", "tf"]);
  const type = allowedTypes.has(quizType) ? quizType : "mcq4";

  const allowedDiff = new Set(["auto", "easy", "med", "hard"]);
  const diff = allowedDiff.has(difficulty) ? difficulty : "auto";

  const allowedMode = new Set(["solo", "duel"]);
  const m = allowedMode.has(mode) ? mode : "solo";

  return { level, year, profile, subject, chapter, difficulty: diff, quizType: type, count, mode: m, seed };
}

function buildPrompt(input) {
  const diffMap = { auto: "mediu", easy: "ușor", med: "mediu", hard: "greu" };
  const diffHuman = diffMap[input.difficulty] || "mediu";

  const optCount = input.quizType === "mcq3" ? 3 : input.quizType === "tf" ? 2 : 4;

  return `
Generează ${input.count} întrebări pentru România.

Context:
- Nivel: ${input.level}
- Clasa/An: ${input.year}
- Profil: ${input.profile || "—"}
- Materie: ${input.subject}
- Capitol: ${input.chapter}
- Dificultate: ${diffHuman}
- Tip: ${input.quizType}

Reguli:
- mcq4: 4 opțiuni; mcq3: 3 opțiuni; tf: 2 opțiuni (Adevărat/Fals)
- O singură variantă corectă
- Fără „toate de mai sus”
- Întrebări clare, potrivite pentru nivel
- Returnează STRICT JSON valid, fără text extra, fără markdown.

Format EXACT:
{
  "items": [
    {
      "question": "…",
      "options": ["…", "…", "…", "…"],
      "correct_index": 0
    }
  ]
}

IMPORTANT:
- items să aibă exact ${input.count} întrebări
- options să aibă exact ${optCount} elemente
- correct_index între 0 și ${optCount - 1}
- Pentru tf, options trebuie să fie exact ["Adevărat","Fals"] (în ordinea asta).
- Seed (pentru variație): ${input.seed || "—"}
`;
}

app.post("/api/quiz/generate", rateLimit, checkToken, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const input = normalizeInput(req.body);

    if (!input.subject || input.subject.length < 2) {
      return res.status(400).json({ error: "Missing subject" });
    }
    if (!input.chapter || input.chapter.length < 2) {
      return res.status(400).json({ error: "Missing chapter" });
    }

    // cache key
    const ckey = JSON.stringify(input);
    const cached = cache.get(ckey);
    if (cached) return res.json(cached);

    // response_format (json_object) -> ușor de parsat
    const prompt = buildPrompt(input);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Returnezi STRICT JSON valid. Fără text extra." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const raw = response.choices?.[0]?.message?.content || "{}";
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Invalid JSON from model", raw });
    }

    const items = obj?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(502).json({ error: "Empty items", raw: obj });
    }

    const optCount = input.quizType === "mcq3" ? 3 : input.quizType === "tf" ? 2 : 4;

    // normalize + validate
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;

      const question = String(it.question || "").trim();
      const options = Array.isArray(it.options) ? it.options.map((x) => String(x).trim()) : [];
      let correct_index = parseInt(it.correct_index, 10);
      if (!Number.isFinite(correct_index)) correct_index = 0;

      if (!question) continue;

      // fix TF options
      if (input.quizType === "tf") {
        const tfOpts = ["Adevărat", "Fals"];
        correct_index = correct_index === 1 ? 1 : 0;
        out.push({ question, options: tfOpts, correct_index });
        continue;
      }

      if (options.length !== optCount) continue;
      if (correct_index < 0 || correct_index >= optCount) correct_index = 0;

      out.push({ question, options, correct_index });
    }

    if (out.length === 0) {
      return res.status(502).json({ error: "No valid questions after validation", raw: obj });
    }

    // dacă modelul a dat mai multe/mai puține, ajustăm la count
    const finalOut = out.slice(0, input.count);

    cache.set(ckey, finalOut);
    res.json(finalOut);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log("Backend pornit pe port:", PORT));
