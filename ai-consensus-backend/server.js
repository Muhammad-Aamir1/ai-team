const path = require('path');
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

// ─────────────────────────────────────────────────────────────
// Startup guard — fail fast if the API key is missing
// ─────────────────────────────────────────────────────────────
if (!process.env.OPENROUTER_API_KEY) {
  console.error('FATAL: OPENROUTER_API_KEY is not set in .env. Exiting.');
  process.exit(1);
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Allowed origins: set ALLOWED_ORIGINS=https://yourdomain.com in .env for production.
// Falls back to open '*' only when not set (local dev convenience).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, same-origin)
      if (!origin) return callback(null, true);
      // If no allowlist is configured, open to all (dev mode)
      if (!ALLOWED_ORIGINS) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
  })
);

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_PROMPT_LENGTH = 4000; // characters
const SLEEP_MS          = 3000; // pause on 429
const MAX_RETRIES       = 3;

// ── Per-IP in-memory rate limiter (free, no Redis needed) ──
// Allows MAX_REQUESTS per WINDOW_MS per IP.
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_IP  = 5;         // adjust as needed
const ipRequestMap = new Map();

function rateLimiter(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  if (!ipRequestMap.has(ip)) {
    ipRequestMap.set(ip, { count: 1, windowStart: now });
    return next();
  }

  const record = ipRequestMap.get(ip);

  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Window expired — reset
    record.count       = 1;
    record.windowStart = now;
    return next();
  }

  if (record.count >= MAX_REQUESTS_PER_IP) {
    return res.status(429).json({
      error: `Rate limit exceeded. You can make ${MAX_REQUESTS_PER_IP} requests per minute. Please wait a moment.`,
    });
  }

  record.count++;
  next();
}

// Cleanup stale IP entries every 5 minutes so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRequestMap.entries()) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      ipRequestMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Helper: sleep
// ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────
// Helper: call OpenRouter with retry + fallback model list
// All models used here are FREE tier on OpenRouter.
// ─────────────────────────────────────────────────────────────
async function callOpenRouter(modelList, systemPrompt, userPrompt, stream = false) {
  for (const model of modelList) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[OpenRouter] ${model} — attempt ${attempt}/${MAX_RETRIES}`);
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.SITE_URL || 'https://consensus-ai.app',
            'X-Title':      'Consensus AI',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user',   content: userPrompt   },
            ],
            stream,
          }),
        });

        if (response.ok)               return response;
        if (response.status === 429)   {
          console.warn(`[Rate Limit] 429 on ${model}. Waiting ${SLEEP_MS}ms…`);
          await sleep(SLEEP_MS);
          continue;
        }
        // Any other HTTP error — try next model
        console.warn(`[Warn] ${model} returned ${response.status}. Trying next model…`);
        break;
      } catch (err) {
        console.warn(`[Warn] Network error for ${model}: ${err.message}. Trying next model…`);
        break;
      }
    }
  }
  throw new Error('All AI models are currently busy or rate-limited. Please try again in a moment.');
}

// ─────────────────────────────────────────────────────────────
// Helper: extract text content from an OpenRouter JSON response
// ─────────────────────────────────────────────────────────────
async function getContent(response) {
  const json = await response.json();
  return json.choices?.[0]?.message?.content ?? '';
}

// ─────────────────────────────────────────────────────────────
// System prompts
// ─────────────────────────────────────────────────────────────
const INITIAL_SYSTEM_PROMPT =
  'You are an expert technical problem solver. Analyze the issue thoroughly, identify the root cause, and provide the correct solution with clear reasoning.';

const REVIEWER_SYSTEM_PROMPT =
  'You are an expert technical problem solver. Your task is to review the provided user issue and the proposed solution from a previous AI. Carefully review the response, identify any mistakes or gaps, provide the correct solution, and explicitly state the root cause.';

const FINAL_SYSTEM_PROMPT = `You are a Lead Cloud Architect and Customer Success expert. You will be given a user query and technical analysis from 5 AI engineers.

Your objectives:
1. Synthesize all provided outputs into ONE perfect, correct answer.
2. Resolve any conflicts silently. NEVER mention other AI models, the review process, or phrases like "the previous response was wrong."
3. Be polite, friendly, and clear. Use appropriate emojis to improve readability.
4. Format with Markdown: clearly show Root Cause, Solution, and any commands needed.`;

// ─────────────────────────────────────────────────────────────
// FREE model lists — each slot has a primary + fallback.
// Using only OpenRouter free-tier models (no cost to you or users).
// ─────────────────────────────────────────────────────────────
const MODELS = {
  gemini:   ['google/gemini-2.0-flash-exp:free',        'google/gemini-flash-1.5:free'],
  deepseek: ['deepseek/deepseek-chat:free',              'deepseek/deepseek-r1:free'],
  llama:    ['meta-llama/llama-3.3-70b-instruct:free',  'meta-llama/llama-3.1-8b-instruct:free'],
  qwen:     ['qwen/qwen-2.5-72b-instruct:free',         'qwen/qwen-2.5-7b-instruct:free'],
  mistral:  ['mistralai/mistral-nemo:free',              'mistralai/mistral-7b-instruct:free'],
};

// ─────────────────────────────────────────────────────────────
// POST /api/solve-issue
// ─────────────────────────────────────────────────────────────
app.post('/api/solve-issue', rateLimiter, async (req, res) => {
  // ── Input validation ──
  const { issue } = req.body;

  if (!issue || typeof issue !== 'string' || !issue.trim()) {
    return res.status(400).json({ error: 'Issue description is required.' });
  }
  if (issue.length > MAX_PROMPT_LENGTH) {
    return res
      .status(400)
      .json({ error: `Prompt is too long. Maximum ${MAX_PROMPT_LENGTH} characters allowed.` });
  }

  const sanitizedIssue = issue.trim();

  // ── Streaming headers (optimised for Google Cloud Run / App Engine) ──
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // ── Event sender — 4 KB padding on status events forces Cloud proxy flush ──
  const sendEvent = (type, data) => {
    let payload = JSON.stringify({ type, data });
    if (type === 'status') payload += ' '.repeat(4096);
    res.write(payload + '\n');
  };

  try {
    // ────────────────────────────────────────────────
    // STEPS 1–5: Run all 5 models IN PARALLEL.
    // This cuts total wait time from ~75s → ~15–20s.
    // Each model independently analyses the user query.
    // ────────────────────────────────────────────────
    sendEvent('status', '⚡ Five AI models are analysing your query in parallel...');

    const userPrompt = `User Query: ${sanitizedIssue}`;

    const [out1, out2, out3, out4, out5] = await Promise.all([
      callOpenRouter(MODELS.gemini,   INITIAL_SYSTEM_PROMPT, userPrompt).then(getContent),
      callOpenRouter(MODELS.deepseek, REVIEWER_SYSTEM_PROMPT,
        `${userPrompt}\n\nAnalyse this query independently and provide your best solution with root cause.`
      ).then(getContent),
      callOpenRouter(MODELS.llama,    REVIEWER_SYSTEM_PROMPT,
        `${userPrompt}\n\nAnalyse this query independently and provide your best solution with root cause.`
      ).then(getContent),
      callOpenRouter(MODELS.qwen,     REVIEWER_SYSTEM_PROMPT,
        `${userPrompt}\n\nAnalyse this query independently and provide your best solution with root cause.`
      ).then(getContent),
      callOpenRouter(MODELS.mistral,  REVIEWER_SYSTEM_PROMPT,
        `${userPrompt}\n\nAnalyse this query independently and provide your best solution with root cause.`
      ).then(getContent),
    ]);

    // ────────────────────────────────────────────────
    // STEP 6: Gemini Final — synthesise & stream
    // ────────────────────────────────────────────────
    sendEvent('status', '✨ Gemini is synthesising the final answer...');

    const synthesisPrompt =
      `Original Query: ${sanitizedIssue}\n\n` +
      `--- Analysis 1 (Gemini) ---\n${out1}\n\n`   +
      `--- Analysis 2 (DeepSeek) ---\n${out2}\n\n` +
      `--- Analysis 3 (Llama 3) ---\n${out3}\n\n`  +
      `--- Analysis 4 (Qwen) ---\n${out4}\n\n`     +
      `--- Analysis 5 (Mistral) ---\n${out5}\n\n`  +
      `Based on all analyses above, generate the final, perfect, polite response.`;

    const streamResponse = await callOpenRouter(
      MODELS.gemini,
      FINAL_SYSTEM_PROMPT,
      synthesisPrompt,
      true // streaming enabled
    );

    const reader  = streamResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line === 'data: [DONE]') break;
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed  = JSON.parse(line.slice(6)); // remove 'data: '
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) sendEvent('token', content);
        } catch {
          // Partial JSON chunk — skip
        }
      }
    }

    sendEvent('done', 'Process complete.');
    res.end();

  } catch (error) {
    console.error('[Chain Error]', error.message);
    sendEvent(
      'error',
      'The AI network is currently overloaded or rate-limited. Please wait a moment and try again.'
    );
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────
// Serve compiled React frontend (production)
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.includes('.')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    res.status(404).send('Not found');
  }
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Consensus AI backend running on port ${PORT}`);
});