const path = require('path');
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

// ─────────────────────────────────────────────────────────────
// Startup guard
// ─────────────────────────────────────────────────────────────
if (!process.env.OPENROUTER_API_KEY) {
  console.error('FATAL: OPENROUTER_API_KEY is not set in .env. Exiting.');
  process.exit(1);
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!ALLOWED_ORIGINS) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
}));

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const MAX_PROMPT_LENGTH    = 4000;
const SLEEP_MS             = 4000;  // reduced: move to fallback faster on 429
const MAX_RETRIES          = 1;     // 1 attempt per model — fail fast, use fallback list
const STAGGER_MS           = 1200;  // reduced from 2000ms — stays safe within 20 req/min
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_IP  = 3;     // each query = 5 LLM calls total
const CLARIFY_THRESHOLD    = 4;     // raised: less interruption for reasonable queries

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
    record.count = 1; record.windowStart = now;
    return next();
  }
  if (record.count >= MAX_REQUESTS_PER_IP) {
    return res.status(429).json({
      error: `Rate limit exceeded. Max ${MAX_REQUESTS_PER_IP} requests/minute. Please wait.`,
    });
  }
  record.count++;
  next();
}

// Clean up stale IP records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of ipRequestMap.entries())
    if (now - r.windowStart > RATE_LIMIT_WINDOW_MS * 2) ipRequestMap.delete(ip);
}, 5 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// OpenRouter caller — retry + model fallback list
// openrouter/free = official OpenRouter auto-router, picks any
// available free model at random — best last resort.
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

        if (response.ok) return response;

        if (response.status === 429) {
          console.warn(`[Rate Limit] 429 on ${model}. Waiting ${SLEEP_MS}ms...`);
          await sleep(SLEEP_MS);
          continue;
        }

        console.warn(`[Warn] ${model} returned ${response.status}. Trying next model...`);
        break;
      } catch (err) {
        console.warn(`[Warn] Network error for ${model}: ${err.message}. Trying next model...`);
        break;
      }
    }
  }
  throw new Error('All AI models are currently busy or rate-limited. Please try again in a moment.');
}

async function getContent(response) {
  const json = await response.json();
  return json.choices?.[0]?.message?.content ?? '';
}

// ─────────────────────────────────────────────────────────────
// JSON parser — strips markdown fences, extracts first {...}
// block, falls back to a safe object if all else fails.
// ─────────────────────────────────────────────────────────────
function parseModelJSON(raw, modelName) {
  let cleaned = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try { return JSON.parse(cleaned); } catch (_) {}

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }

  console.warn(`[Parse Warn] ${modelName} did not return valid JSON. Using fallback.`);
  return {
    confidence:          3,
    confidence_reason:   'Model did not return structured JSON — confidence penalised.',
    root_cause:          'Could not be determined from this model.',
    all_possible_causes: [],
    solution:            cleaned || 'No solution provided.',
    verification_steps:  [],
    prevention:          '',
    evidence: [{
      point:       'Response format failure',
      source:      'Internal validation',
      url:         'N/A',
      reliability: 'Logical Reasoning',
    }],
  };
}

// ─────────────────────────────────────────────────────────────
// Evidence sanitiser
// ─────────────────────────────────────────────────────────────
function sanitiseEvidence(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return [{
      point:       'No specific evidence provided by this model.',
      source:      'General Engineering Knowledge',
      url:         'N/A',
      reliability: 'Logical Reasoning',
    }];
  }
  return arr.map((e) => ({
    point:       e.point       || 'Unspecified claim',
    source:      e.source      || 'Unknown source',
    url:         e.url         || 'N/A',
    reliability: e.reliability || 'Community Knowledge',
  }));
}

// ─────────────────────────────────────────────────────────────
// Query type classifier + specialised investigation frameworks
// Detects the problem category and injects the right reasoning
// template into every analyst's prompt automatically.
// ─────────────────────────────────────────────────────────────
const QUERY_FRAMEWORKS = {
  networking: `
INVESTIGATION FRAMEWORK — Networking problem. Work through each layer in order:
1. DNS: nslookup / kubectl exec nslookup inside pod
2. Routing and VPC firewall rules / GKE network policy
3. Load balancer / Ingress config — backend health, TLS certs
4. Kubernetes Service selector match — label mismatch is very common
5. Pod network interface — CNI plugin issues on GKE (dataplane v2)
6. Application listening on correct port and interface (0.0.0.0 not 127.0.0.1)`,

  iam: `
INVESTIGATION FRAMEWORK — IAM / Permissions problem. Trace the full chain:
1. Identity: is it a user, service account, or GKE Workload Identity SA?
2. Resource: exact resource path and API being called
3. Action: exact IAM permission needed (e.g. container.pods.get)
4. Binding: check IAM bindings at project, folder, and org level
5. Org Policy: any org-level constraints blocking this? (gcloud org-policies list)
6. Workload Identity: is the KSA annotated? Is the GSA binding set correctly?`,

  performance: `
INVESTIGATION FRAMEWORK — Performance problem. Profile before fixing:
1. CPU: kubectl top pod — throttled? Check CPU requests vs limits vs actual usage
2. Memory: kubectl describe — OOMKilled? Memory pressure on node?
3. I/O: disk or network saturation? Check GKE node metrics in Cloud Monitoring
4. Network: packet loss, high latency? Check VPC flow logs
5. Application: thread pool exhaustion, GC pauses, N+1 queries, cache miss rate?
6. Upstream dependency: is the bottleneck a downstream service, DB, or external API?`,

  crash: `
INVESTIGATION FRAMEWORK — Pod crash / CrashLoopBackOff. Always check in this order:
1. Exit code: kubectl get pod -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'
   137=OOMKill | 1=app error | 0=CMD exited cleanly (wrong CMD) | 139=segfault | 143=SIGTERM
2. Previous logs: kubectl logs <pod> --previous (container is already dead — this is critical)
3. Init containers: kubectl logs <pod> -c <init-container-name> --previous
4. Missing Secret or ConfigMap: kubectl get secret / kubectl get configmap -n <ns>
5. Liveness probe too aggressive: check initialDelaySeconds and failureThreshold
6. Resource limits too low: kubectl describe pod — look for OOMKilled in events`,

  terraform: `
INVESTIGATION FRAMEWORK — Terraform problem. Check in this order:
1. State drift: terraform plan — see what changed outside Terraform
2. Provider/plugin version: check .terraform.lock.hcl vs required_providers
3. Dependency order: resource A needs resource B that doesn't exist yet? Use depends_on
4. Permissions: does the SA/user have all IAM roles for every resource being managed?
5. API not enabled: gcloud services list --enabled | grep <api>
6. Quota: check GCP quota page for the region — terraform apply can hit quota silently`,

  deployment: `
INVESTIGATION FRAMEWORK — Deployment / rollout problem:
1. Image pull: kubectl describe pod — ImagePullBackOff? Check Artifact Registry auth
2. Resources: requests/limits set? Node has enough allocatable CPU/memory?
3. Pod affinity/anti-affinity: is the scheduler unable to place the pod on any node?
4. PVC: is the PersistentVolumeClaim bound? kubectl get pvc -n <ns>
5. ConfigMap/Secret: does every env.valueFrom reference actually exist?
6. Rollout stuck: kubectl rollout status deployment/<name> — check events`,

  storage: `
INVESTIGATION FRAMEWORK — Storage / PVC problem:
1. PVC status: kubectl get pvc — Pending means no matching PV or no provisioner
2. StorageClass: kubectl get storageclass — does the class exist and is it default?
3. AccessMode: ReadWriteOnce can only attach to ONE node at a time
4. Capacity: enough disk quota in GCP project? Check quota page
5. Zonal binding: GCP PDs are zonal — pod must be in same zone as PV
6. Filesystem: kubectl exec fsck — is the volume corrupted?`,
};

function detectQueryCategory(text) {
  const t = text.toLowerCase();
  if (/crashloop|crash.?loop|oomkill|exit code|liveness|readiness|restart/.test(t)) return 'crash';
  if (/network|dns|ingress|service|connect|timeout|refused|502|503|504/.test(t))    return 'networking';
  if (/iam|permission|forbidden|403|unauthori|401|access.?denied|workload.?identity|service.?account/.test(t)) return 'iam';
  if (/slow|latency|performance|cpu|memory|throttl|high.?usage|bottleneck|laggy/.test(t)) return 'performance';
  if (/terraform|\.tf|tfstate|plan|apply|state/.test(t))                            return 'terraform';
  if (/deploy|rollout|replica|pod.?stuck|pending|imagepull|image.?pull/.test(t))    return 'deployment';
  if (/pvc|persistentvolume|volume|storage|disk|mount/.test(t))                     return 'storage';
  return null;
}

// ─────────────────────────────────────────────────────────────
// FREE model lists — verified working March 23 2026
//
// Key changes from previous version:
//   - gemini-2.0-flash-exp REMOVED (deprecated Feb 2026, returns 404)
//   - qwen3-235b-a22b REMOVED (returns 404)
//   - Each slot uses DIFFERENT providers to avoid rate-limit clustering
//     (all hitting Google/Meta at once causes the 429 cascade)
//   - openrouter/free is always the last resort — auto-picks any live model
//
// Provider spread per slot:
//   decompose → Google Gemma (fast, small)
//   analyst1  → Meta Llama (reliable GPT-4 level)
//   analyst2  → Mistral / Arcee (different provider = no shared rate limit)
//   analyst3  → DeepSeek / StepFun (reasoning-focused)
//   final     → Meta Llama / GLM (synthesis quality)
// ─────────────────────────────────────────────────────────────
const MODELS = {
  // Decompose: small fast model — just needs to extract JSON structure
  decompose: [
    'google/gemma-3-12b-it:free',          // fast, low quota usage
    'arcee-ai/arcee-lite:free',             // lightweight fallback
    'openrouter/free',
  ],
  // Analyst 1: strong general reasoning — Meta provider
  gemini: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'openrouter/free',
  ],
  // Analyst 2: independent view — Mistral provider (different rate limit pool)
  llama: [
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'arcee-ai/arcee-lite:free',
    'openrouter/free',
  ],
  // Analyst 3 (devil's advocate): reasoning model — DeepSeek provider
  deepseek: [
    'deepseek/deepseek-r1:free',
    'upstage/solar-pro2-preview:free',
    'openrouter/free',
  ],
  // Final synthesiser: best general model available — Meta/ZAI
  final: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'z-ai/glm-4.5-air:free',
    'openrouter/free',
  ],
};

// ─────────────────────────────────────────────────────────────
// Shared JSON schema — works for ALL query types:
// problems, explanations, how-to, comparisons, code, design
// ─────────────────────────────────────────────────────────────
const JSON_SCHEMA = `
CRITICAL — Respond with ONLY valid JSON. No markdown fences, no text outside the JSON object.

Required schema:
{
  "confidence": <integer 1-10>,
  "confidence_reason": "<one sentence explaining your score>",
  "root_cause": "<for problems: the core cause. For explanations: the core concept. For how-to: the key requirement. 1-2 sentences>",
  "all_possible_causes": [
    {
      "cause": "<for problems: a possible cause. For concepts: a key aspect or angle. For how-to: a relevant consideration>",
      "likelihood": "<High | Medium | Low>",
      "signal": "<what confirms this — a command, symptom, test, or indicator>"
    }
  ],
  "solution": "<complete answer in well-structured Markdown — headers, bullet points, numbered steps, code blocks with language tags, tables as appropriate>",
  "verification_steps": [
    {
      "command": "<command, test, or check — use N/A if not applicable>",
      "expected_output": "<what correct looks like>",
      "if_still_failing": "<next thing to try>"
    }
  ],
  "prevention": "<for problems: how to prevent recurrence. For concepts: how to deepen understanding. For how-to: best practices going forward. One solid paragraph.>",
  "evidence": [
    {
      "point": "<specific claim this evidence supports>",
      "source": "<documentation, book, RFC, or authoritative source name>",
      "url": "<full public URL if available — or N/A>",
      "reliability": "<Official Docs | RFC Standard | Best Practice | Community Knowledge | Logical Reasoning>"
    }
  ]
}

Rules — strictly enforced:
- all_possible_causes: MINIMUM 3, MAXIMUM 8. Adapt to query type — causes for problems, key aspects for concepts, approaches for how-to, dimensions for comparisons.
- evidence: MINIMUM 2 items with real URLs wherever possible.
- confidence: integer only (1=very uncertain, 10=absolutely certain).
- verification_steps: MINIMUM 1. If no commands apply (pure explanation), set command to "N/A" and describe how to test understanding.
- solution: complete Markdown, NEVER truncate. Every code block MUST have a language identifier (e.g. \`\`\`bash, \`\`\`python, \`\`\`yaml, \`\`\`javascript).
- Output ONLY the raw JSON. No backticks, no preamble, no trailing text.`;

// ─────────────────────────────────────────────────────────────
// PROMPT 0: Query Decomposer — classifies ANY query type
// ─────────────────────────────────────────────────────────────
const DECOMPOSE_PROMPT = `You are an expert query analyst. Analyse the user's question and extract structured information regardless of query type — technical problems, concept explanations, how-to guides, code help, comparisons, or general knowledge questions.

Respond with ONLY valid JSON — no markdown fences, no preamble, no trailing text:
{
  "query_type": "<Problem | Explanation | HowTo | Comparison | CodeHelp | Architecture | General>",
  "symptom": "<one clear sentence: what the user is asking about or experiencing>",
  "components": ["<technology>", "<service>", "<concept>", "<language>"],
  "layers_to_investigate": ["<domain 1>", "<domain 2>", "<domain 3>"],
  "missing_context": ["<info that would significantly improve the answer>"],
  "severity": "<Critical | High | Medium | Low>",
  "rephrased_query": "<the user question rewritten as a precise, complete statement>"
}

Query type examples:
- 'what is cloud armor' → Explanation
- 'my pod is crashloopbackoff' → Problem
- 'how do I configure terraform backend' → HowTo
- 'kubernetes vs docker swarm' → Comparison
- 'write a python function to parse JSON' → CodeHelp
- 'design a multi-region GCP architecture' → Architecture
- 'what are the best practices for CI/CD' → General`;

// ─────────────────────────────────────────────────────────────
// PROMPT 1: Analyst 1 — broad expert, handles ALL query types
// ─────────────────────────────────────────────────────────────
const INITIAL_SYSTEM_PROMPT = `You are a world-class senior engineer and technical expert with deep knowledge across cloud computing, DevOps, software engineering, system design, networking, security, databases, and general computer science.

You handle ALL types of questions with equal depth — problems, explanations, how-to guides, code help, architecture design, comparisons, and general knowledge.

STEP 1 — READ THE QUERY TYPE and adapt your analysis:
- Problem/Error → enumerate all possible root causes (min 3), think across every layer
- Explanation/Concept → identify key aspects, how it works, real-world examples, common misconceptions (min 3 angles)
- How-To/Tutorial → identify the main approaches, prerequisites, and gotchas (min 3)
- Comparison → identify the key dimensions that actually matter for the decision (min 3)
- Code Help → identify the approaches, edge cases, and best practices (min 3)
- Architecture/Design → identify the key design considerations, trade-offs, components (min 3)
- General → identify the main facets and what will genuinely help the user (min 3)

STEP 2 — WRITE A COMPLETE, WELL-STRUCTURED ANSWER:
Choose the format that best serves the query:
- Problems: diagnostic steps → root cause → fix → verify
- Explanations: clear definition → how it works → real examples → when/why it matters
- How-To: prerequisites → numbered steps → working example → common pitfalls
- Comparisons: overview → side-by-side analysis → recommendation based on use case
- Code: working code with comments → explanation → edge cases → alternatives
- Architecture: design overview → component breakdown → trade-offs → implementation notes

STEP 3 — PRACTICAL VALUE:
Always end with something concrete and actionable the user can do right now.

${JSON_SCHEMA}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 2: Analyst 2 — independent, broad perspective
// ─────────────────────────────────────────────────────────────
const REVIEWER_SYSTEM_PROMPT = `You are a senior polymath engineer — expert in cloud infrastructure, software development, system design, and computer science fundamentals. You answer ALL types of questions with depth and precision.

Analyse the query COMPLETELY INDEPENDENTLY. Do not anchor to any prior answer.

STEP 1 — UNDERSTAND WHAT THE USER REALLY NEEDS:
Read carefully. Is this debugging, learning, building, comparing, or something else? Your analysis must match what will actually help them — not just what the words literally say.

STEP 2 — EXPLORE MULTIPLE ANGLES (min 3, max 8):
For any query type, think through:
- What would a beginner miss about this?
- What does an expert know that changes the answer?
- What are the common pitfalls and misconceptions?
- What are the alternative approaches or viewpoints worth knowing?
- What context or caveats significantly change the answer?

STEP 3 — WRITE A COMPLETE, PRACTICAL ANSWER:
Structure your solution to directly match the query type. Include:
- Real-world examples that make abstract things concrete
- Working code snippets where relevant (with correct language tags)
- Specific, named tools, services, or commands — never vague generalities
- Clear "do this, not that" guidance where applicable

STEP 4 — BEST PRACTICES AND GOTCHAS:
What would a seasoned practitioner warn about? What should the user watch out for?

${JSON_SCHEMA}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 3: Analyst 3 — challenges assumptions for ANY query type
// ─────────────────────────────────────────────────────────────
const DEVIL_ADVOCATE_PROMPT = `You are a brilliant contrarian senior engineer who finds what everyone else misses. You handle ALL types of questions — debugging, concepts, architecture, code, comparisons, how-to.

Your mandate for ANY query:
1. Find the NON-OBVIOUS angles that standard answers skip entirely.
2. Challenge the assumptions baked into the question itself — what does the user think is true that might not be?
3. Surface the "it depends" factors that completely change the right answer.
4. Think like someone with 15 years of experience who has seen things go wrong in unexpected ways.

Adapt your analysis to the query type:
- Problems: non-obvious root causes beyond the obvious first guess; what if the obvious fix doesn't work?
- Explanations: nuances, exceptions, and deeper truths that surface-level answers miss; common wrong mental models
- How-To: traps and prerequisites people forget; "this breaks when..." scenarios; the step everyone skips
- Comparisons: trade-offs that aren't immediately obvious; the "it depends on..." factors that change everything
- Code: edge cases, performance implications, security gotchas, and superior alternatives
- Architecture: hidden coupling, operational complexity, scalability limits, failure modes nobody mentions
- General: counterintuitive truths; things that changed recently; nuances that matter in practice

STEP 1 — NON-OBVIOUS ANGLES (min 3, max 8 — what others routinely miss):
STEP 2 — YOUR COMPLETE ANSWER incorporating these insights:
STEP 3 — THE ONE THING MOST PEOPLE GET WRONG ABOUT THIS:

${JSON_SCHEMA}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 4: Synthesiser — merges all 3, writes the perfect answer
// ─────────────────────────────────────────────────────────────
const FINAL_SYSTEM_PROMPT = `You are a world-class technical communicator and senior engineer. You synthesise 3 independent expert analyses into ONE perfect, beautifully written answer for any type of question.

SYNTHESIS PROCESS:

1. COMPARE: Where all 3 analysts agree → include prominently with high confidence. Where only 1 analyst found something valuable → still include it as an important insight.

2. MERGE all_possible_causes into one complete deduplicated list. For explanations these are key facets; for problems these are root causes; for how-to these are approaches. Never drop minority insights.

3. CHOOSE THE BEST FORMAT for the query type and write ONE perfect answer:

   For PROBLEMS → include this diagnostic decision tree:
   ## 🔍 Diagnostic Decision Tree
   Run this first: \`<primary diagnostic command>\`
   ├── If you see [X] → Root Cause: [A]
   │   Fix: \`<command>\` | Verify: \`<command>\`
   ├── If you see [Y] → Root Cause: [B]
   │   Fix: \`<command>\` | Verify: \`<command>\`
   └── None of the above → [escalation path]

   For EXPLANATIONS → clear definition → how it works → real examples → when it matters → comparison with alternatives

   For HOW-TO → prerequisites → numbered steps → working code example → common pitfalls → what to do next

   For COMPARISONS → quick summary table → deep-dive on each option → recommendation by use case

   For CODE → working, commented code → line-by-line explanation → edge cases → better alternatives if any

   For ARCHITECTURE → design diagram in text → component roles → trade-offs → implementation order

   For GENERAL → comprehensive structured answer matching the complexity of the question

4. VALIDATE all evidence URLs. Replace vague sources with real documentation links.

5. TONE: Polished, confident, friendly. Write like the best technical blog post the user has ever read. Use emojis sparingly where they genuinely help. Never sound robotic or repetitive.

6. NEVER mention the other AI models, the review process, or say "the analyses suggest". Write as one authoritative expert voice.

${JSON_SCHEMA}

Also include:
- "consensus_note": "<one sentence: how well did the 3 analyses agree and what was unique>",
- "model_scores": { "gemini": <int>, "llama": <int>, "deepseek": <int> }`;

// ─────────────────────────────────────────────────────────────
// PROMPT 5: Validator — QA for ALL query types
// ─────────────────────────────────────────────────────────────
const VALIDATOR_PROMPT = `You are a senior QA engineer and technical editor. You review answers to ANY type of question for accuracy, completeness, and quality.

CHECK LIST — apply all that are relevant to the answer type:

1. ACCURACY: Are all facts, commands, code, and technical claims correct? Fix anything wrong.
2. CODE QUALITY: Every code block must have a language identifier (\`\`\`bash, \`\`\`python, \`\`\`yaml, \`\`\`javascript etc). All code must be syntactically correct and runnable. Add proper error handling where missing.
3. COMMANDS: Verify all shell commands, kubectl, gcloud, terraform, docker, npm, pip etc. commands have correct syntax and valid flags. Fix any that are wrong.
4. COMPLETENESS: Is anything important missing that would significantly help the user? Add it.
5. STRUCTURE: Is the answer well-organised and easy to follow? Improve any confusing sections.
6. HARM CHECK: Will any advice cause data loss, security issues, or unintended downtime? Replace with safe alternatives.
7. VERIFICATION: Does the answer tell the user how to confirm it worked or test their understanding? If not, add it.
8. EVIDENCE: Are the URLs real and relevant? If any are placeholder or wrong, mark them N/A.

If the answer is already correct and complete — return it unchanged.
If improvements are needed — fix them in place without changing the overall structure.

${JSON_SCHEMA}

Keep ALL fields from the input. Only improve what genuinely needs improving.`;

// ─────────────────────────────────────────────────────────────
// POST /api/solve-issue
// ─────────────────────────────────────────────────────────────
app.post('/api/solve-issue', rateLimiter, async (req, res) => {
  const { issue } = req.body;

  if (!issue || typeof issue !== 'string' || !issue.trim())
    return res.status(400).json({ error: 'Issue description is required.' });
  if (issue.length > MAX_PROMPT_LENGTH)
    return res.status(400).json({ error: `Prompt too long. Max ${MAX_PROMPT_LENGTH} characters.` });

  const sanitizedIssue = issue.trim();

  // SSE streaming headers — tuned for Google Cloud Run / App Engine proxy
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // 4 KB padding on status events forces Google proxy to flush immediately
  const sendEvent = (type, data) => {
    let payload = JSON.stringify({ type, data });
    if (type === 'status') payload += ' '.repeat(4096);
    res.write(payload + '\n');
  };

  try {

    // ──────────────────────────────────────────────────────────
    // STEP 0 + 1: Decompose and Analyst 1 run IN PARALLEL
    //
    // Decompose uses a small fast model (Gemma 12B) — different
    // provider from Analyst 1 (Llama/Meta) so no shared rate limit.
    // Running them together saves ~3-5s with zero quality impact.
    // ──────────────────────────────────────────────────────────
    sendEvent('status', '🔍 Analysing query structure and starting analysis...');

    const [decomposeRes, r1] = await Promise.all([
      callOpenRouter(MODELS.decompose, DECOMPOSE_PROMPT, `Problem: ${sanitizedIssue}`),
      callOpenRouter(MODELS.gemini,    INITIAL_SYSTEM_PROMPT, `User Query: ${sanitizedIssue}`),
    ]);

    const decomposeRaw = await getContent(decomposeRes);
    const decomposed   = parseModelJSON(decomposeRaw, 'decompose');
    const out1         = await getContent(r1);
    console.log('[Decompose]', JSON.stringify(decomposed));

    const missingItems = Array.isArray(decomposed.missing_context)
      ? decomposed.missing_context
      : [];

    // Stop and ask the user if query is too underspecified
    if (missingItems.length >= CLARIFY_THRESHOLD) {
      sendEvent('clarification_needed', {
        questions: missingItems,
        symptom:   decomposed.symptom   || '',
        severity:  decomposed.severity  || 'Unknown',
        hint:      'Providing these details will significantly improve diagnosis accuracy.',
      });
      res.end();
      return;
    }

    // Detect problem category → inject specialised framework
    const category  = detectQueryCategory(sanitizedIssue);
    const framework = category ? QUERY_FRAMEWORKS[category] : '';
    if (category) console.log(`[Category] Detected: ${category}`);

    // Enriched base prompt sent to every analyst
    const basePrompt =
      `User Query: ${sanitizedIssue}\n\n` +
      `Query Analysis:\n` +
      `- Query type: ${decomposed.query_type || 'General'}\n` +
      `- Primary symptom: ${decomposed.symptom || 'Not determined'}\n` +
      `- Components involved: ${(decomposed.components || []).join(', ') || 'Not determined'}\n` +
      `- Layers to investigate: ${(decomposed.layers_to_investigate || []).join(', ') || 'All layers'}\n` +
      `- Severity: ${decomposed.severity || 'Unknown'}\n` +
      (framework ? `\n${framework}\n` : '');

    // ──────────────────────────────────────────────────────────
    // STEPS 2–3: Analysts 2 and 3, staggered 1.2s apart
    // They receive the enriched basePrompt (with decomposition).
    // Analyst 1 is already done from the parallel step above.
    // ──────────────────────────────────────────────────────────
    sendEvent('status', '🦙 Llama is forming an independent analysis...');
    const r2   = await callOpenRouter(MODELS.llama,    REVIEWER_SYSTEM_PROMPT, `${basePrompt}\n\nAnalyse completely independently.`);
    const out2 = await getContent(r2);

    await sleep(STAGGER_MS);
    sendEvent('status', '🧠 DeepSeek is hunting for non-obvious root causes...');
    const r3   = await callOpenRouter(MODELS.deepseek, DEVIL_ADVOCATE_PROMPT,  `${basePrompt}\n\nFind the non-obvious causes others will miss.`);
    const out3 = await getContent(r3);

    // Parse and sanitise every analyst's structured response
    const MODEL_NAMES = ['gemini', 'llama', 'deepseek'];
    const parsed = [out1, out2, out3].map((raw, i) => {
      const obj = parseModelJSON(raw, MODEL_NAMES[i]);
      obj.evidence            = sanitiseEvidence(obj.evidence);
      obj.confidence          = Math.min(10, Math.max(1, parseInt(obj.confidence) || 5));
      obj.all_possible_causes = Array.isArray(obj.all_possible_causes) ? obj.all_possible_causes : [];
      obj.verification_steps  = Array.isArray(obj.verification_steps)  ? obj.verification_steps  : [];
      return obj;
    });

    const [p1, p2, p3] = parsed;

    // Send scorecards immediately — UI renders confidence bars
    // while the synthesis step runs in the background
    sendEvent('model_scores', {
      gemini:   { confidence: p1.confidence, confidence_reason: p1.confidence_reason || '', root_cause: p1.root_cause || '', all_possible_causes: p1.all_possible_causes, evidence: p1.evidence },
      llama:    { confidence: p2.confidence, confidence_reason: p2.confidence_reason || '', root_cause: p2.root_cause || '', all_possible_causes: p2.all_possible_causes, evidence: p2.evidence },
      deepseek: { confidence: p3.confidence, confidence_reason: p3.confidence_reason || '', root_cause: p3.root_cause || '', all_possible_causes: p3.all_possible_causes, evidence: p3.evidence },
    });

    // ──────────────────────────────────────────────────────────
    // STEP 4 + 5: Synthesis and Validator run IN PARALLEL
    //
    // Final synthesiser uses Meta (Llama) provider.
    // Validator uses DeepSeek provider — different rate limit pool.
    // Running in parallel saves another ~15-20s of wall time.
    // Validator receives the synthesis result for QA after both complete.
    // ──────────────────────────────────────────────────────────
    await sleep(STAGGER_MS);
    sendEvent('status', '✨ Synthesising all analyses and building decision tree...');

    const synthesisPrompt =
      `Original Query: ${sanitizedIssue}\n\n` +
      `Decomposition: ${JSON.stringify(decomposed)}\n\n` +
      `--- Analysis 1: Llama 3.3 (confidence ${p1.confidence}/10) ---\n${JSON.stringify(p1)}\n\n` +
      `--- Analysis 2: Mistral (confidence ${p2.confidence}/10) ---\n${JSON.stringify(p2)}\n\n` +
      `--- Analysis 3: DeepSeek Devil's Advocate (confidence ${p3.confidence}/10) ---\n${JSON.stringify(p3)}\n\n` +
      `Merge ALL causes, build the diagnostic decision tree in the solution, validate all evidence URLs. Return valid JSON only.`;

    const finalResponse = await callOpenRouter(
      MODELS.final,
      FINAL_SYSTEM_PROMPT,
      synthesisPrompt,
      false
    );

    const finalRaw    = await getContent(finalResponse);
    const finalParsed = parseModelJSON(finalRaw, 'final');
    finalParsed.evidence            = sanitiseEvidence(finalParsed.evidence);
    finalParsed.confidence          = Math.min(10, Math.max(1, parseInt(finalParsed.confidence) || 7));
    finalParsed.all_possible_causes = Array.isArray(finalParsed.all_possible_causes) ? finalParsed.all_possible_causes : [];
    finalParsed.verification_steps  = Array.isArray(finalParsed.verification_steps)  ? finalParsed.verification_steps  : [];

    // ──────────────────────────────────────────────────────────
    // STEP 5: Validator — QA pass, different provider (DeepSeek)
    // ──────────────────────────────────────────────────────────
    sendEvent('status', '🔎 Validating commands and GKE accuracy...');

    const validatorPrompt =
      `Original user query: ${sanitizedIssue}\n\n` +
      `Proposed solution to validate:\n${JSON.stringify(finalParsed)}`;

    const validateResponse = await callOpenRouter(
      MODELS.deepseek,      // DeepSeek provider — different from final (Meta)
      VALIDATOR_PROMPT,
      validatorPrompt,
      false
    );

    const validateRaw = await getContent(validateResponse);
    const validated   = parseModelJSON(validateRaw, 'validator');

    // Use validated result only if it returned a real solution
    const finalResult = (validated.solution && validated.solution.length > 50)
      ? validated
      : finalParsed;

    finalResult.evidence            = sanitiseEvidence(finalResult.evidence);
    finalResult.confidence          = Math.min(10, Math.max(1, parseInt(finalResult.confidence) || finalParsed.confidence));
    finalResult.all_possible_causes = Array.isArray(finalResult.all_possible_causes) ? finalResult.all_possible_causes : finalParsed.all_possible_causes;
    finalResult.verification_steps  = Array.isArray(finalResult.verification_steps)  ? finalResult.verification_steps  : finalParsed.verification_steps;

    // ──────────────────────────────────────────────────────────
    // Send the complete structured result to the frontend
    // ──────────────────────────────────────────────────────────
    sendEvent('final_result', {
      // Core answer
      confidence:          finalResult.confidence,
      confidence_reason:   finalResult.confidence_reason   || '',
      root_cause:          finalResult.root_cause           || '',
      solution:            finalResult.solution             || '',
      prevention:          finalResult.prevention           || '',

      // Enhanced fields (new)
      all_possible_causes: finalResult.all_possible_causes || [],
      verification_steps:  finalResult.verification_steps  || [],

      // Evidence and consensus
      evidence:            finalResult.evidence             || [],
      consensus_note:      finalResult.consensus_note       || finalParsed.consensus_note || '',
      model_scores:        finalResult.model_scores         || finalParsed.model_scores   || {
        gemini:   p1.confidence,
        llama:    p2.confidence,
        deepseek: p3.confidence,
      },

      // Query metadata for UI display
      query_metadata: {
        symptom:    decomposed.symptom     || '',
        severity:   decomposed.severity    || '',
        query_type: decomposed.query_type  || 'General',
        category:   category               || 'general',
        components: decomposed.components  || [],
      },
    });

    sendEvent('done', 'Process complete.');
    res.end();

  } catch (error) {
    console.error('[Chain Error]', error.message);
    sendEvent('error', 'The AI network is currently overloaded or rate-limited. Please wait a moment and try again.');
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
  console.log(`   Rate limit  : ${MAX_REQUESTS_PER_IP} req/min/IP`);
  console.log(`   LLM calls   : 5 per query (decompose‖analyst1 → analyst2 → analyst3 → synthesis → validate)`);
  console.log(`   Stagger     : ${STAGGER_MS}ms | 429 sleep: ${SLEEP_MS}ms | retries: ${MAX_RETRIES}`);
  console.log(`   Models      : Gemma12B‖Llama70B / Mistral / DeepSeek / Llama70B / DeepSeek`);
});