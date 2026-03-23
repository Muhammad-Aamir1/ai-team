import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Send, Mic, Copy, Check, X, SquarePen, Sparkles,
  ChevronRight, ExternalLink, BookOpen, Zap, Shield,
  Brain, Globe, AlertCircle, ChevronDown, ChevronUp,
  HelpCircle, ListChecks, ShieldCheck, Tag, Activity,
  Sun, Moon,
} from 'lucide-react';
import './App.css';

// ─────────────────────────────────────────────────────────────
// SSE hook — handles ALL 6 server event types:
//   status               → progress text + pipeline step
//   clarification_needed → server says query is too vague
//   model_scores         → per-model confidence + causes + evidence
//   final_result         → complete structured answer
//   error / done         → lifecycle
// ─────────────────────────────────────────────────────────────
function useConsensusStream() {
  const [status,        setStatus]        = useState('');
  const [isLoading,     setIsLoading]     = useState(false);
  const [activeStep,    setActiveStep]    = useState(-1);
  const [modelScores,   setModelScores]   = useState(null);
  const [result,        setResult]        = useState(null);
  const [clarification, setClarification] = useState(null); // NEW

  const submit = useCallback(async (issue) => {
    setIsLoading(true);
    setModelScores(null);
    setResult(null);
    setClarification(null);
    setActiveStep(0);
    setStatus('Analysing your query structure...');

    try {
      const response = await fetch('/api/solve-issue', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ issue }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setResult({ error: err.error || 'Server error. Please try again.' });
        setIsLoading(false);
        setActiveStep(-1);
        return;
      }

      const reader  = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let   buffer  = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const { type, data } = JSON.parse(line.trimEnd());

            if (type === 'status') {
              setStatus(data);
              // Map each server status string to the right pipeline step
              if      (data.includes('Analysing your query'))             setActiveStep(0);
              else if (data.includes('Gemini is enumerating'))            setActiveStep(1);
              else if (data.includes('Llama'))                            setActiveStep(2);
              else if (data.includes('DeepSeek'))                         setActiveStep(3);
              else if (data.includes('Synthesising'))                     setActiveStep(4);
              else if (data.includes('Validating'))                       setActiveStep(5);

            } else if (type === 'clarification_needed') {
              // Server decided query is too vague — show questions to user
              setClarification(data);
              setIsLoading(false);
              setActiveStep(-1);

            } else if (type === 'model_scores') {
              setModelScores(data);
              setActiveStep(4);

            } else if (type === 'final_result') {
              setResult(data);
              setIsLoading(false);
              setActiveStep(6);
              // Browser notification — only fires if tab is not in focus
              if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                new Notification('✅ Consensus AI — Response ready', {
                  body: 'Your analysis is complete. Click to view the answer.',
                  icon: '/favicon.ico',
                  tag:  'consensus-ai-result', // prevents duplicate notifications
                });
              }

            } else if (type === 'error') {
              setResult({ error: data });
              setIsLoading(false);
              setActiveStep(-1);

            } else if (type === 'done') {
              setStatus('Complete');
              setIsLoading(false);
              setActiveStep(6);
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    } catch {
      setResult({ error: 'Network error. Could not connect to the backend.' });
      setIsLoading(false);
      setActiveStep(-1);
    }
  }, []);

  return { status, isLoading, activeStep, modelScores, result, clarification, submit };
}

// ─────────────────────────────────────────────────────────────
// Static data
// ─────────────────────────────────────────────────────────────

// Pipeline now reflects the 6-step server flow exactly
const PIPELINE_STEPS = [
  { label: 'Decompose',   icon: '🔍', role: 'Query analysis'        },
  { label: 'Gemini 2.0',  icon: '🌟', role: 'Root cause enumeration' },
  { label: 'Llama 3.3',   icon: '🦙', role: 'Independent analysis'   },
  { label: 'DeepSeek R1', icon: '🧠', role: 'Devil\'s advocate'      },
  { label: 'Synthesise',  icon: '✨', role: 'Decision tree builder'  },
  { label: 'Validate',    icon: '🔎', role: 'QA & command check'     },
];

// 3 models now (server changed from 5 to 3 analysts)
const MODEL_META = {
  gemini:   { label: 'Gemini 2.0',  icon: '🌟', color: '#4285f4' },
  llama:    { label: 'Llama 3.3',   icon: '🦙', color: '#f97316' },
  deepseek: { label: 'DeepSeek R1', icon: '🧠', color: '#8b5cf6' },
};

const LIKELIHOOD_COLOR = {
  High:   { text: '#f87171', bg: 'rgba(248,113,113,0.1)',  border: 'rgba(248,113,113,0.25)' },
  Medium: { text: '#fbbf24', bg: 'rgba(251,191,36,0.1)',   border: 'rgba(251,191,36,0.25)'  },
  Low:    { text: '#64748b', bg: 'rgba(100,116,139,0.1)',  border: 'rgba(100,116,139,0.25)' },
};

const SEVERITY_COLOR = {
  Critical: '#f87171',
  High:     '#fbbf24',
  Medium:   '#818cf8',
  Low:      '#34d399',
};

const CATEGORY_ICON = {
  crash:      '💥',
  networking: '🌐',
  iam:        '🔐',
  performance:'⚡',
  terraform:  '🏗️',
  deployment: '🚀',
  storage:    '💾',
  general:    '🔧',
};

const RELIABILITY_COLOR = {
  'Official Docs':      '#34d399',
  'RFC Standard':       '#60a5fa',
  'Best Practice':      '#a78bfa',
  'Community Knowledge':'#fbbf24',
  'Logical Reasoning':  '#94a3b8',
};

const CHIPS = [
  { emoji: '☸️', label: 'Kubernetes deep dive',     prompt: 'Explain Kubernetes architecture and how pods, services and ingress work together'  },
  { emoji: '🏗️', label: 'GCP architecture',         prompt: 'Design a highly available GCP architecture for a microservices application'        },
  { emoji: '🐳', label: 'Docker networking',         prompt: 'Explain Docker networking modes: bridge, host, overlay and when to use each'        },
  { emoji: '🔐', label: 'Cloud IAM best practices',  prompt: 'What are the best practices for GCP IAM roles and least privilege access?'         },
  { emoji: '📦', label: 'Terraform modules',         prompt: 'How do I structure Terraform modules for a large-scale GCP project?'              },
  { emoji: '🚀', label: 'CI/CD pipeline design',     prompt: 'Design a production-grade CI/CD pipeline using Jenkins and GKE'                   },
];

const TEACHERS = [
  { name: 'ByteByteGo',          avatar: 'BB', color: '#f97316', desc: 'Visual system design at scale. Real-world architectures used by top tech companies, beautifully explained.',          tags: ['System Design','Distributed Systems','Interviews'], url: 'https://bytebytego.com',                      platform: 'YouTube · Newsletter' },
  { name: 'Gaurav Sen',           avatar: 'GS', color: '#8b5cf6', desc: 'Deep-dives into scalable system design. Makes complex distributed concepts intuitive and interview-ready.',          tags: ['Scalability','HLD','LLD'],                         url: 'https://www.youtube.com/@gkcs',              platform: 'YouTube'              },
  { name: 'Arpit Bhayani',        avatar: 'AB', color: '#38bdf8', desc: 'Engineering fundamentals from first principles. Database internals, system design, backend architecture.',           tags: ['Databases','Backend','Architecture'],              url: 'https://arpitbhayani.me',                    platform: 'Newsletter · YouTube' },
  { name: 'Hussein Nasser',       avatar: 'HN', color: '#34d399', desc: 'Backend engineering and database deep dives. Networking, proxies, and real infrastructure with hands-on demos.',    tags: ['Networking','Databases','Backend'],                url: 'https://www.youtube.com/@hnasr',             platform: 'YouTube'              },
  { name: 'Fireship',             avatar: 'FI', color: '#fbbf24', desc: 'Fast-paced, high-quality dev content. Modern cloud tools and engineering concepts in 100 seconds or less.',         tags: ['Cloud','DevOps','Modern Stack'],                   url: 'https://www.youtube.com/@Fireship',          platform: 'YouTube'              },
  { name: 'TechWorld with Nana',  avatar: 'TN', color: '#f472b6', desc: 'Gold standard for DevOps and Kubernetes tutorials. Clear structured paths from beginner to production-ready.',      tags: ['DevOps','Kubernetes','Docker'],                    url: 'https://www.youtube.com/@TechWorldwithNana', platform: 'YouTube'              },
];

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

function AnimatedBg() {
  return (
    <div className="bg-canvas" aria-hidden="true">
      <div className="orb orb1" /><div className="orb orb2" /><div className="orb orb3" />
      <div className="grid-lines" />
    </div>
  );
}

function ConfidenceBar({ score, color }) {
  const pct   = (score / 10) * 100;
  const shade = score >= 8 ? '#34d399' : score >= 6 ? '#fbbf24' : '#f87171';
  return (
    <div className="conf-bar-wrap">
      <div className="conf-bar-track">
        <div className="conf-bar-fill" style={{ width: `${pct}%`, background: color || shade }} />
      </div>
      <span className="conf-score" style={{ color: color || shade }}>{score}/10</span>
    </div>
  );
}

// NEW: renders the all_possible_causes[] array inside a model card
function CausesList({ causes }) {
  if (!causes || causes.length === 0) return null;
  return (
    <div className="causes-list">
      <span className="causes-label"><ListChecks size={11} /> All possible causes</span>
      {causes.map((c, i) => {
        const lh = LIKELIHOOD_COLOR[c.likelihood] || LIKELIHOOD_COLOR.Low;
        return (
          <div key={i} className="cause-item">
            <div className="cause-top">
              <span className="cause-lh" style={{ color: lh.text, background: lh.bg, border: `1px solid ${lh.border}` }}>
                {c.likelihood}
              </span>
              <span className="cause-name">{c.cause}</span>
            </div>
            {c.signal && <div className="cause-signal">🔎 {c.signal}</div>}
          </div>
        );
      })}
    </div>
  );
}

// NEW: renders the verification_steps[] array
function VerificationSteps({ steps }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="verify-section">
      <div className="verify-title"><ShieldCheck size={14} /> Verification Steps</div>
      {steps.map((s, i) => (
        <div key={i} className="verify-item">
          <div className="verify-cmd"><code>{s.command}</code></div>
          {s.expected_output && (
            <div className="verify-expected">✅ Expected: <span>{s.expected_output}</span></div>
          )}
          {s.if_still_failing && (
            <div className="verify-fallback">⚠️ If still failing: <span>{s.if_still_failing}</span></div>
          )}
        </div>
      ))}
    </div>
  );
}

// NEW: query metadata bar — severity + category + components
function QueryMeta({ meta }) {
  if (!meta || (!meta.symptom && !meta.severity && !meta.category)) return null;
  const sevColor  = SEVERITY_COLOR[meta.severity]  || '#64748b';
  const catIcon   = CATEGORY_ICON[meta.category]   || '🔧';
  return (
    <div className="query-meta-bar">
      {meta.severity && (
        <span className="qmb-pill" style={{ color: sevColor, background: `${sevColor}18`, border: `1px solid ${sevColor}30` }}>
          <Activity size={11} /> {meta.severity}
        </span>
      )}
      {meta.category && meta.category !== 'general' && (
        <span className="qmb-pill qmb-cat">
          {catIcon} {meta.category}
        </span>
      )}
      {meta.components && meta.components.length > 0 && meta.components.slice(0, 3).map((c, i) => (
        <span key={i} className="qmb-pill qmb-comp"><Tag size={10} /> {c}</span>
      ))}
      {meta.symptom && <span className="qmb-symptom">{meta.symptom}</span>}
    </div>
  );
}

// NEW: clarification panel shown when server fires clarification_needed
function ClarificationPanel({ data }) {
  return (
    <div className="clarification-card">
      <div className="clar-header">
        <HelpCircle size={18} className="clar-icon" />
        <div>
          <div className="clar-title">A few more details would help</div>
          <div className="clar-sub">
            {data.severity && data.severity !== 'Unknown' && (
              <span style={{ color: SEVERITY_COLOR[data.severity] || '#64748b' }}>
                Severity: {data.severity} ·{' '}
              </span>
            )}
            {data.hint}
          </div>
        </div>
      </div>
      <div className="clar-questions">
        {data.questions.map((q, i) => (
          <div key={i} className="clar-q">
            <span className="clar-q-num">{i + 1}</span>
            <span className="clar-q-text">{q}</span>
          </div>
        ))}
      </div>
      <p className="clar-hint">Add these details to your query and try again ↓</p>
    </div>
  );
}

// Updated ModelCard — now shows all_possible_causes too
function ModelCard({ modelKey, data }) {
  const [open,       setOpen]       = useState(false);
  const [showCauses, setShowCauses] = useState(false);
  const meta = MODEL_META[modelKey] || { label: modelKey, icon: '🤖', color: '#94a3b8' };

  return (
    <div className="model-card">
      <div className="mc-header" onClick={() => setOpen(v => !v)}>
        <div className="mc-left">
          <span className="mc-icon">{meta.icon}</span>
          <div className="mc-info">
            <span className="mc-name">{meta.label}</span>
            <span className="mc-reason">{data.confidence_reason}</span>
          </div>
        </div>
        <div className="mc-right">
          <ConfidenceBar score={data.confidence} color={meta.color} />
          <button className="mc-toggle" aria-label="toggle details">
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="mc-body">
          {data.root_cause && (
            <div className="mc-root">
              <span className="mc-root-label">Root cause</span>
              <span className="mc-root-text">{data.root_cause}</span>
            </div>
          )}

          {/* Causes toggle inside model card */}
          {data.all_possible_causes && data.all_possible_causes.length > 0 && (
            <div className="mc-causes-toggle">
              <button className="mc-sub-toggle" onClick={() => setShowCauses(v => !v)}>
                <ListChecks size={12} />
                {data.all_possible_causes.length} possible causes identified
                {showCauses ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {showCauses && <CausesList causes={data.all_possible_causes} />}
            </div>
          )}

          <div className="evidence-list">
            <span className="evidence-label">Evidence</span>
            {data.evidence.map((e, i) => (
              <div key={i} className="ev-item">
                <div className="ev-point">
                  <span className="ev-rel" style={{
                    color:      RELIABILITY_COLOR[e.reliability] || '#94a3b8',
                    background: (RELIABILITY_COLOR[e.reliability] || '#94a3b8') + '18',
                    border:     `1px solid ${RELIABILITY_COLOR[e.reliability] || '#94a3b8'}30`,
                  }}>{e.reliability}</span>
                  <span className="ev-claim">{e.point}</span>
                </div>
                <div className="ev-source">
                  <span className="ev-src-name">{e.source}</span>
                  {e.url && e.url !== 'N/A'
                    ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="ev-url"><ExternalLink size={11} /> View source</a>
                    : <span className="ev-url-na">No URL</span>
                  }
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Updated pipeline — 6 steps matching the new server flow
function Pipeline({ activeStep, isLoading, status }) {
  return (
    <div className="pipeline">
      <div className="pipeline-title"><Zap size={11} />AI Consensus Pipeline</div>
      <div className="pipeline-track">
        {PIPELINE_STEPS.map((s, i) => {
          const done    = activeStep === 6 || activeStep > i;
          const running = isLoading && activeStep === i;
          return (
            <React.Fragment key={s.label}>
              <div className={`ps ${done ? 'ps-done' : running ? 'ps-run' : 'ps-idle'}`}>
                <div className="ps-bubble">
                  {done ? <Check size={9} /> : <span>{s.icon}</span>}
                </div>
                <div className="ps-text">
                  <span className="ps-name">{s.label}</span>
                  <span className="ps-role">{s.role}</span>
                </div>
              </div>
              {i < PIPELINE_STEPS.length - 1 && (
                <div className={`ps-line ${done ? 'ps-line-done' : ''}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>
      {status && isLoading && (
        <div className="pipeline-status"><span className="blink-dot" />{status}</div>
      )}
    </div>
  );
}

function TeacherCard({ t }) {
  return (
    <a href={t.url} target="_blank" rel="noopener noreferrer" className="tc" style={{ '--c': t.color }}>
      <div className="tc-top">
        <div className="tc-av" style={{ background: `${t.color}1a`, border: `1.5px solid ${t.color}44` }}>
          <span style={{ color: t.color }}>{t.avatar}</span>
        </div>
        <div className="tc-info">
          <span className="tc-name">{t.name}</span>
          <span className="tc-plat">{t.platform}</span>
        </div>
        <ExternalLink size={13} className="tc-ext" />
      </div>
      <p className="tc-desc">{t.desc}</p>
      <div className="tc-tags">
        {t.tags.map(tag => (
          <span key={tag} className="tc-tag" style={{ color: t.color, background: `${t.color}15`, border: `1px solid ${t.color}30` }}>{tag}</span>
        ))}
      </div>
    </a>
  );
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────
export default function App() {
  const { status, isLoading, activeStep, modelScores, result, clarification, submit } = useConsensusStream();

  const [issue,           setIssue]           = useState('');
  const [isDarkMode,      setIsDarkMode]      = useState(true); // dark by default
  const [isCopied,        setIsCopied]        = useState(false);
  const [autoScroll,      setAutoScroll]      = useState(true);
  const [isListening,     setIsListening]     = useState(false);
  const [showTeachers,    setShowTeachers]    = useState(false);
  const [showEvidence,    setShowEvidence]    = useState(false);
  const [showAllCauses,   setShowAllCauses]   = useState(false);
  const [showVerify,      setShowVerify]      = useState(false);
  const [showPrevention,  setShowPrevention]  = useState(false);

  const mainRef        = useRef(null);
  const textareaRef    = useRef(null);
  const recognitionRef = useRef(null);

  // Request notification permission once on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Apply theme to <html> so CSS variables cascade everywhere
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => {
    if (autoScroll && mainRef.current)
      mainRef.current.scrollTop = mainRef.current.scrollHeight;
  }, [result, modelScores, status, clarification, autoScroll]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px';
  }, [issue]);

  const handleScroll = () => {
    if (!mainRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = mainRef.current;
    setAutoScroll(scrollHeight - scrollTop <= clientHeight + 120);
  };

  const handleCopy = () => {
    if (result?.solution) {
      navigator.clipboard.writeText(result.solution);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const handleSubmit = (e) => {
    e?.preventDefault();
    if (!issue.trim() || isLoading) return;
    setAutoScroll(true);
    setShowTeachers(false);
    setShowEvidence(false);
    setShowAllCauses(false);
    setShowVerify(false);
    setShowPrevention(false);
    submit(issue.trim());
  };

  const handleMic = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Voice input requires Chrome or Edge.'); return; }
    if (isListening) { recognitionRef.current?.stop(); setIsListening(false); return; }
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = false;
    r.onresult = e => setIssue(p => p ? `${p} ${e.results[0][0].transcript}` : e.results[0][0].transcript);
    r.onend   = () => setIsListening(false);
    r.onerror = () => setIsListening(false);
    recognitionRef.current = r; r.start(); setIsListening(true);
  };

  const isEmpty = !isLoading && !result && !modelScores && !clarification;

  return (
    <div className="app">
      <AnimatedBg />

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sb-logo"><Sparkles size={15} /></div>
        <nav className="sb-nav">
          <button className={`sb-btn ${!showTeachers ? 'sb-active' : ''}`} title="Chat"               onClick={() => setShowTeachers(false)}><Brain    size={17} /></button>
          <button className={`sb-btn ${showTeachers  ? 'sb-active' : ''}`} title="Learning Resources" onClick={() => setShowTeachers(v => !v)}><BookOpen size={17} /></button>
          <button className="sb-btn" title="New Chat" onClick={() => !isLoading && window.location.reload()}><SquarePen size={17} /></button>
        </nav>
        <div className="sb-user" title="Amir">A</div>
      </aside>

      <div className="main-wrap">

        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-brand">
            <Sparkles size={16} className="tb-icon" />
            <span className="tb-name">Consensus AI</span>
            <span className="tb-chip">3-Model Chain</span>
          </div>
          <div className="topbar-right">
            <div className="live-pill"><span className="live-dot" />Live</div>
            <button
              className="theme-toggle-btn"
              onClick={() => setIsDarkMode(v => !v)}
              aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDarkMode ? 'Light mode' : 'Dark mode'}
            >
              {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="content" ref={mainRef} onScroll={handleScroll}>

          {/* Teachers panel */}
          {showTeachers && (
            <div className="teachers-panel">
              <div className="tp-header">
                <BookOpen size={20} className="tp-icon" />
                <div>
                  <h2 className="tp-title">Recommended Learning Resources</h2>
                  <p className="tp-sub">Hand-picked educators for system design, cloud &amp; DevOps mastery.</p>
                </div>
              </div>
              <div className="teachers-grid">
                {TEACHERS.map(t => <TeacherCard key={t.name} t={t} />)}
              </div>
            </div>
          )}

          {/* Welcome */}
          {isEmpty && !showTeachers && (
            <div className="welcome">
              <div className="welcome-glow" />
              <div className="welcome-badge"><Sparkles size={20} /></div>
              <h1 className="welcome-h1">Hey Amir <span className="wave">👋</span></h1>
              <p className="welcome-p">
                3 AI models analyse your query independently — enumerating all root causes, not just the obvious one.
                Gemini synthesises a decision tree. A validator QA-checks every command.
              </p>
              <div className="feat-row">
                <span className="feat"><Zap size={11} />~40s response</span>
                <span className="feat"><Shield size={11} />All root causes</span>
                <span className="feat"><Globe size={11} />Decision tree</span>
                <span className="feat"><ShieldCheck size={11} />Command validated</span>
              </div>
              <div className="chips">
                {CHIPS.map(c => (
                  <button key={c.label} className="chip" onClick={() => setIssue(c.prompt)}>
                    <span className="chip-em">{c.emoji}</span>
                    <span className="chip-lbl">{c.label}</span>
                    <ChevronRight size={13} className="chip-arr" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Processing / Results */}
          {(isLoading || result || modelScores || clarification) && !showTeachers && (
            <div className="out-wrap">

              {/* Pipeline — visible while loading */}
              {isLoading && (
                <Pipeline activeStep={activeStep} isLoading={isLoading} status={status} />
              )}

              {/* ── Clarification needed ── */}
              {clarification && !result && (
                <ClarificationPanel data={clarification} />
              )}

              {/* ── Model scorecards ── */}
              {modelScores && (
                <div className="scorecards-section">
                  <div className="section-header">
                    <span className="section-title">Model Confidence Scores</span>
                    <span className="section-sub">Click any model to see its root causes &amp; evidence</span>
                  </div>
                  {result?.model_scores && (
                    <div className="consensus-row">
                      {Object.entries(result.model_scores).map(([key, score]) => {
                        const meta = MODEL_META[key] || { icon: '🤖', color: '#94a3b8' };
                        return (
                          <div key={key} className="mini-score" style={{ '--mc': meta.color }}>
                            <span className="mini-icon">{meta.icon}</span>
                            <span className="mini-val" style={{ color: meta.color }}>{score}/10</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="model-cards">
                    {Object.entries(modelScores).map(([key, data]) => (
                      <ModelCard key={key} modelKey={key} data={data} />
                    ))}
                  </div>
                </div>
              )}

              {/* ── Final result ── */}
              {result && !result.error && (
                <div className="result-card">

                  {/* Header row */}
                  <div className="rc-header">
                    <div className="rc-badge-row">
                      <div className="rc-badge"><Check size={12} />Consensus Answer</div>
                      {result.consensus_note && (
                        <span className="consensus-note">{result.consensus_note}</span>
                      )}
                    </div>
                    <div className="rc-actions">
                      <div className="final-conf">
                        <span className="fc-label">Consensus confidence</span>
                        <ConfidenceBar score={result.confidence} />
                      </div>
                      <button className="copy-btn" onClick={handleCopy}>
                        {isCopied ? <><Check size={12} />Copied</> : <><Copy size={12} />Copy</>}
                      </button>
                    </div>
                  </div>

                  {/* Query metadata bar — NEW */}
                  {result.query_metadata && (
                    <QueryMeta meta={result.query_metadata} />
                  )}

                  {/* Root cause strip */}
                  {result.root_cause && (
                    <div className="root-cause-strip">
                      <AlertCircle size={14} className="rcs-icon" />
                      <div>
                        <span className="rcs-label">Primary Root Cause</span>
                        <span className="rcs-text">{result.root_cause}</span>
                      </div>
                    </div>
                  )}

                  {/* All possible causes toggle — NEW */}
                  {result.all_possible_causes && result.all_possible_causes.length > 0 && (
                    <div className="apc-section">
                      <button className="ev-toggle-btn" onClick={() => setShowAllCauses(v => !v)}>
                        <ListChecks size={14} />
                        <span>All Possible Causes ({result.all_possible_causes.length} identified)</span>
                        {showAllCauses ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {showAllCauses && (
                        <div className="apc-body">
                          <CausesList causes={result.all_possible_causes} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Solution markdown */}
                  <div className="markdown-body">
                    <ReactMarkdown components={{
                      code({ inline, className, children, ...props }) {
                        const m = /language-(\w+)/.exec(className || '');
                        return !inline && m
                          ? <SyntaxHighlighter style={vscDarkPlus} language={m[1]} PreTag="div" className="code-block" {...props}>{String(children).replace(/\n$/, '')}</SyntaxHighlighter>
                          : <code className="inline-code" {...props}>{children}</code>;
                      },
                    }}>{result.solution}</ReactMarkdown>
                  </div>

                  {/* Verification steps toggle — NEW */}
                  {result.verification_steps && result.verification_steps.length > 0 && (
                    <div className="verify-toggle-wrap evidence-section">
                      <button className="ev-toggle-btn" onClick={() => setShowVerify(v => !v)}>
                        <ShieldCheck size={14} />
                        <span>Verification Steps ({result.verification_steps.length})</span>
                        {showVerify ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {showVerify && (
                        <div className="final-evidence">
                          <VerificationSteps steps={result.verification_steps} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Prevention toggle — NEW */}
                  {result.prevention && (
                    <div className="evidence-section">
                      <button className="ev-toggle-btn" onClick={() => setShowPrevention(v => !v)}>
                        <Shield size={14} />
                        <span>Prevention</span>
                        {showPrevention ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {showPrevention && (
                        <div className="final-evidence">
                          <p className="prevention-text">{result.prevention}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Evidence toggle */}
                  {result.evidence && result.evidence.length > 0 && (
                    <div className="evidence-section">
                      <button className="ev-toggle-btn" onClick={() => setShowEvidence(v => !v)}>
                        <Shield size={14} />
                        <span>Verified Evidence ({result.evidence.length} sources)</span>
                        {showEvidence ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {showEvidence && (
                        <div className="final-evidence">
                          {result.evidence.map((e, i) => (
                            <div key={i} className="ev-item">
                              <div className="ev-point">
                                <span className="ev-rel" style={{
                                  color:      RELIABILITY_COLOR[e.reliability] || '#94a3b8',
                                  background: (RELIABILITY_COLOR[e.reliability] || '#94a3b8') + '18',
                                  border:     `1px solid ${RELIABILITY_COLOR[e.reliability] || '#94a3b8'}30`,
                                }}>{e.reliability}</span>
                                <span className="ev-claim">{e.point}</span>
                              </div>
                              <div className="ev-source">
                                <span className="ev-src-name">{e.source}</span>
                                {e.url && e.url !== 'N/A'
                                  ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="ev-url"><ExternalLink size={11} /> View source</a>
                                  : <span className="ev-url-na">No URL</span>
                                }
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Error state */}
              {result?.error && (
                <div className="error-card">
                  <AlertCircle size={18} />
                  <span>{result.error}</span>
                </div>
              )}

            </div>
          )}
        </main>

        {/* Input dock */}
        <div className="input-dock">
          <form className="input-form" onSubmit={handleSubmit}>
            <div className="input-shell">
              <textarea
                ref={textareaRef}
                value={issue}
                onChange={e => setIssue(e.target.value)}
                placeholder="Ask anything — cloud, DevOps, architecture, code..."
                disabled={isLoading}
                rows={1}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
              />
              <div className="input-btns">
                {issue.length > 0 && (
                  <span className={`ccount ${issue.length > 3800 ? 'warn' : ''}`}>{issue.length}/4000</span>
                )}
                <button type="button" className={`ib mic-ib ${isListening ? 'listening' : ''}`} onClick={handleMic} title="Voice input">
                  <Mic size={15} />
                </button>
                {issue.trim() && (
                  <button type="button" className="ib" onClick={() => setIssue('')} title="Clear"><X size={15} /></button>
                )}
                <button type="submit" disabled={!issue.trim() || isLoading} className="send-ib" title="Send">
                  <Send size={15} />
                </button>
              </div>
            </div>
            <div className="input-footer">
              <p className="input-disclaimer">
                ⚠️ Consensus AI can make mistakes. Always verify critical commands before running in production.
              </p>
              <p className="input-copyright">
                © {new Date().getFullYear()} Consensus AI · Built by Amir · Powered by OpenRouter free models · Not affiliated with any cloud provider
              </p>
            </div>
          </form>
        </div>

      </div>
    </div>
  );
}