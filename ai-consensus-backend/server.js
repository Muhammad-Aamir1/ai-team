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
// Shared JSON schema — required from EVERY model
// ─────────────────────────────────────────────────────────────
const JSON_SCHEMA = `
CRITICAL — Respond with ONLY valid JSON. No markdown fences, no text outside the JSON object.

Required schema:
{
  "confidence": <integer 1-10>,
  "confidence_reason": "<one sentence explaining your score>",
  "root_cause": "<the single most likely root cause — 1-2 sentences>",
  "all_possible_causes": [
    {
      "cause": "<cause name>",
      "likelihood": "<High | Medium | Low>",
      "signal": "<exact command or log line that confirms this cause>"
    }
  ],
  "solution": "<full technical solution in Markdown — use headers, code blocks, tables>",
  "verification_steps": [
    {
      "command": "<exact command to run>",
      "expected_output": "<what success looks like>",
      "if_still_failing": "<what to check next>"
    }
  ],
  "prevention": "<one paragraph: how to prevent this issue recurring>",
  "evidence": [
    {
      "point": "<specific claim this evidence supports>",
      "source": "<documentation name or RFC>",
      "url": "<full public URL e.g. https://kubernetes.io/docs/... or N/A>",
      "reliability": "<Official Docs | RFC Standard | Best Practice | Community Knowledge | Logical Reasoning>"
    }
  ]
}

Rules — strictly enforced:
- all_possible_causes: MINIMUM 3, MAXIMUM 8. Cover ALL layers: app, container, K8s, network, IAM, cloud infra, upstream deps, config drift.
- evidence: MINIMUM 2 items with real documentation URLs.
- confidence: integer only (1=very uncertain, 10=absolutely certain).
- verification_steps: MINIMUM 1 — must show how to confirm the fix worked.
- solution: complete Markdown, never truncate.
- Output ONLY the raw JSON. No backticks, no preamble, no trailing text.`;

// ─────────────────────────────────────────────────────────────
// PROMPT 0: Query Decomposer — cheap, fast, runs first
// ─────────────────────────────────────────────────────────────
const DECOMPOSE_PROMPT = `You are a technical query analyst for a cloud engineering support system.
Given a user's problem description, extract structured diagnostic information.

Respond with ONLY valid JSON — no markdown fences, no preamble, no trailing text:
{
  "symptom": "<what the user observes — one sentence>",
  "components": ["<K8s component>", "<GCP service>", "<other>"],
  "layers_to_investigate": ["<app layer>", "<container layer>", "<K8s layer>", "<network layer>", "<IAM layer>"],
  "missing_context": ["<piece of info that would change the diagnosis — e.g. exit code, error message, kubectl describe output>"],
  "severity": "<Critical | High | Medium | Low>",
  "rephrased_query": "<the user problem rewritten as a precise engineering statement>"
}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 1: Primary analyst — Gemini, initial analysis
// ─────────────────────────────────────────────────────────────
const INITIAL_SYSTEM_PROMPT = `You are a senior cloud and DevOps engineer specialising in GCP, Kubernetes, Terraform, CI/CD, and distributed systems with 10+ years of production experience on GKE.

Your task — follow these steps in strict order:

STEP 1 — ROOT CAUSE ENUMERATION (do this FIRST before writing any solution):
List ALL possible root causes. Minimum 3, maximum 8.
For each: name it, rate likelihood (High/Medium/Low), and name the exact command or log signal that confirms it.
Think across ALL layers: application code, container runtime, Kubernetes control plane, networking, IAM/RBAC, GCP infrastructure, upstream services, timing/race conditions, config drift, resource limits.

STEP 2 — DEEP SOLUTION:
Write a complete step-by-step solution for the TOP 2 most likely causes.
Always: diagnostic commands first → fix commands → verify it worked.

STEP 3 — EDGE CASES:
List non-obvious edge cases the user must check if the top 2 fixes don't resolve it.

${JSON_SCHEMA}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 2: Independent analyst — Llama, second opinion
// ─────────────────────────────────────────────────────────────
const REVIEWER_SYSTEM_PROMPT = `You are a senior SRE and cloud engineer specialising in GCP, Kubernetes, and distributed systems.

Analyse this problem COMPLETELY INDEPENDENTLY. Do not anchor to any prior answer.

STEP 1 — ROOT CAUSE ENUMERATION:
Think about what ELSE could cause this that a standard answer might miss.
List ALL possible causes (min 3, max 8) across every layer: application, container, Kubernetes, networking, IAM, cloud infra, data layer, external dependencies, regional/zonal issues.

STEP 2 — SOLUTION:
Complete diagnostic and fix steps for your top 2 causes.
Include the exact commands and exactly what output to look for.

STEP 3 — PREVENTION:
How does the user ensure this never happens again? Infrastructure changes, monitoring alerts, CI/CD gates, resource limits?

${JSON_SCHEMA}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 3: Devil's Advocate — DeepSeek, finds what others miss
// ─────────────────────────────────────────────────────────────
const DEVIL_ADVOCATE_PROMPT = `You are a senior SRE whose specific job is to find what everyone else misses in incident diagnosis.

Your mandate:
1. Identify the LEAST OBVIOUS root causes — not the textbook first answer.
2. Think specifically about: upstream service dependencies, race conditions, config drift over time, IAM permission boundaries, GCP regional/zonal failures, quota exhaustion, API version deprecations, clock skew, DNS TTL issues, mTLS certificate expiry, node pool version mismatches, GKE-specific quirks (Autopilot vs Standard modes, Workload Identity federation, GKE dataplane v2, node auto-provisioning).
3. Ask: "What if the obvious fix is applied and the problem STILL happens?" — then answer that.
4. Flag any assumption in the standard approach that could be WRONG in a real GCP production environment.

STEP 1 — NON-OBVIOUS CAUSES (min 3, max 8 — focus on ones others routinely skip):
STEP 2 — SOLUTION for your top picks, including how to verify each:
STEP 3 — WHAT TO DO IF ALL OBVIOUS FIXES FAIL:

${JSON_SCHEMA}`;

// ─────────────────────────────────────────────────────────────
// PROMPT 4: Synthesiser — Gemini Final, merges all 3 analyses
// ─────────────────────────────────────────────────────────────
const FINAL_SYSTEM_PROMPT = `You are the Lead Cloud Architect and final quality reviewer for a 3-model AI consensus system.

You will receive 3 independent JSON analyses from different AI engineers. Your job:

1. COMPARE: Where all 3 agree → high confidence. Where 2 agree → likely correct. Where 1 model uniquely identified something → include it if valid, mark confidence accordingly.

2. MERGE all_possible_causes: Combine ALL causes from all 3 analysts into one complete deduplicated list. Do NOT drop causes — a minority cause is still worth surfacing.

3. SYNTHESISE solution: Write ONE perfect final answer. Start with the most likely causes. Use the best diagnostic steps from all 3 analyses.

4. BUILD A DIAGNOSTIC DECISION TREE inside your solution Markdown:
## 🔍 Diagnostic Decision Tree
Run this first: \`<primary diagnostic command>\`
├── If you see [symptom X] → Root Cause: [A]
│   Fix: \`<specific command>\`
│   Verify: \`<verification command>\`
├── If you see [symptom Y] → Root Cause: [B]
│   Fix: \`<specific command>\`
│   Verify: \`<verification command>\`
└── If none of the above → Escalation: [what to do next]
The tree must cover ALL root causes from all 3 analysts.

5. VALIDATE evidence: Replace any vague sources with specific real documentation URLs.

6. VERIFICATION: Include at least 2 verification_steps showing how the user confirms the fix worked.

7. CONFIDENCE: Compute as the average of all 3 scores, then +1 if strong agreement, -1 if significant conflict.

8. NEVER mention the other AI models or the review process. Write as one expert voice.

9. Tone: polished, friendly, with relevant emojis. Be the expert the user needs.

${JSON_SCHEMA}

Also include these two extra fields:
- "consensus_note": "<one sentence describing agreement level across the 3 models>",
- "model_scores": { "gemini": <int>, "llama": <int>, "deepseek": <int> }`;

// ─────────────────────────────────────────────────────────────
// PROMPT 5: Validator — QA pass, catches command errors
// ─────────────────────────────────────────────────────────────
const VALIDATOR_PROMPT = `You are a DevOps QA engineer and technical accuracy reviewer for GCP and Kubernetes solutions.

You will receive a proposed solution to a user's infrastructure problem. Your job:

1. COMMAND CHECK: Verify every kubectl and gcloud command for correct syntax and valid flags. Fix any that are wrong.
2. GKE SPECIFICS: Does this solution work on GKE specifically — not just vanilla Kubernetes? Flag Autopilot vs Standard differences, Workload Identity requirements, GKE-specific APIs.
3. HARM CHECK: Will any step make the problem worse or cause unintended downtime? If yes, flag and replace with a safer alternative.
4. COMPLETENESS: Are there any critical diagnostic steps a real SRE would always run that are missing?
5. VERIFICATION: Does the solution tell the user how to CONFIRM the fix worked? If not, add verification_steps with exact expected outputs.

If you find issues — fix them in place.
If the solution is already correct — return it unchanged, but always ensure verification_steps exist.

${JSON_SCHEMA}

Important: keep ALL fields from the input. Only correct what is factually wrong or incomplete.`;

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
        symptom:    decomposed.symptom    || '',
        severity:   decomposed.severity   || '',
        category:   category              || 'general',
        components: decomposed.components || [],
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