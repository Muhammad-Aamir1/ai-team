import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Moon, Sun, Send, Sparkles, Plus,
  SlidersHorizontal, Mic, Copy, Check, X, Menu, SquarePen
} from 'lucide-react';
import './App.css';

// ─────────────────────────────────────────────────────────────
// Custom hook: encapsulates all SSE streaming logic
// ─────────────────────────────────────────────────────────────
function useConsensusStream() {
  const [status, setStatus]     = useState('');
  const [output, setOutput]     = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const submit = useCallback(async (issue) => {
    setIsLoading(true);
    setOutput('');
    setStatus('Initiating AI Consensus Chain...');

    try {
      const response = await fetch('/api/solve-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setOutput(`**Error:** ${err.error || 'Server error. Please try again.'}`);
        setIsLoading(false);
        return;
      }

      const reader  = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer    = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete trailing chunk

        for (const line of lines) {
          if (!line.trim()) continue;
          // Strip the 4 KB status-event padding before parsing
          const trimmed = line.trimEnd();
          try {
            const { type, data } = JSON.parse(trimmed);
            if (type === 'status') {
              setStatus(data);
            } else if (type === 'token') {
              setOutput((prev) => prev + data);
              setStatus('Gemini is finalizing the response...');
            } else if (type === 'error') {
              setOutput(`**Error:** ${data}`);
              setIsLoading(false);
            } else if (type === 'done') {
              setStatus('Done!');
              setIsLoading(false);
            }
          } catch {
            // Silently ignore corrupted / partial chunks
          }
        }
      }
    } catch {
      setOutput('**Network error.** Could not connect to the backend.');
      setIsLoading(false);
    }
  }, []);

  return { status, output, isLoading, submit };
}

// ─────────────────────────────────────────────────────────────
// Suggestion chips — label & prompt are now in sync
// ─────────────────────────────────────────────────────────────
const SUGGESTION_CHIPS = [
  { emoji: '☁️',  label: 'Cloud architecture',  prompt: 'Create an AWS VPC architecture diagram'         },
  { emoji: '🐳',  label: 'Explain Docker',       prompt: 'Explain how Docker containers work'             },
  { emoji: '🐍',  label: 'Python script',        prompt: 'Write a Python script for data analysis'        },
  { emoji: '🔐',  label: 'Cloud security',       prompt: 'Review my cloud security policies'              },
  { emoji: '⚛️',  label: 'Debug React',          prompt: 'Help me debug a React application'              },
  { emoji: '☸️',  label: 'Learn Kubernetes',     prompt: 'Teach me about Kubernetes'                      },
];

// ─────────────────────────────────────────────────────────────
// Main App component
// ─────────────────────────────────────────────────────────────
function App() {
  const { status, output, isLoading, submit } = useConsensusStream();

  const [issue,         setIssue]         = useState('');
  const [isDarkMode,    setIsDarkMode]    = useState(false);
  const [isCopied,      setIsCopied]      = useState(false);
  const [autoScroll,    setAutoScroll]    = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isListening,   setIsListening]   = useState(false);

  const mainContentRef = useRef(null);
  const recognitionRef = useRef(null);

  // ── Dark-mode ──
  useEffect(() => {
    document.body.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // ── Smart auto-scroll ──
  useEffect(() => {
    if (autoScroll && mainContentRef.current) {
      mainContentRef.current.scrollTop = mainContentRef.current.scrollHeight;
    }
  }, [output, status, autoScroll]);

  const handleScroll = () => {
    if (!mainContentRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = mainContentRef.current;
    setAutoScroll(scrollHeight - scrollTop <= clientHeight + 100);
  };

  // ── Copy button ──
  const handleCopy = () => {
    navigator.clipboard.writeText(output);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // ── Form submit ──
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!issue.trim() || isLoading) return;
    setAutoScroll(true);
    submit(issue.trim());
  };

  // ── Voice input (Web Speech API — fully free, runs in browser) ──
  const handleMic = () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Voice input is not supported in your browser. Try Chrome or Edge.');
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang          = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setIssue((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  };

  // ── New chat ──
  const handleNewChat = () => {
    if (isLoading) return;
    setIssue('');
    setIsSidebarOpen(false);
    // Force a page reload to reset hook state cleanly
    window.location.reload();
  };

  return (
    <div className="layout">

      {/* Mobile sidebar overlay */}
      {isSidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <button
          className="icon-btn close-sidebar-btn"
          onClick={() => setIsSidebarOpen(false)}
          aria-label="Close sidebar"
        >
          <X size={20} />
        </button>
        <button
          className="icon-btn desktop-menu-btn"
          aria-label="Toggle sidebar"
        >
          <Menu size={20} />
        </button>
        <button
          className="icon-btn new-chat-btn"
          onClick={handleNewChat}
          aria-label="New chat"
          title="New chat"
        >
          <SquarePen size={20} />
        </button>
      </aside>

      {/* Main content */}
      <div className="main-wrapper">

        {/* Header */}
        <header className="header">
          <div className="header-left">
            <button
              className="icon-btn mobile-menu-btn"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open sidebar"
            >
              <Menu size={20} />
            </button>
            <div className="logo">
              <h2>Consensus AI</h2>
            </div>
          </div>
          <button
            className="theme-toggle"
            onClick={() => setIsDarkMode(!isDarkMode)}
            aria-label="Toggle theme"
          >
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </header>

        {/* Scrollable content area */}
        <main
          className="main-content"
          ref={mainContentRef}
          onScroll={handleScroll}
        >
          {/* Empty / welcome state */}
          {!isLoading && !output && (
            <div className="gemini-empty-state">
              <h1 className="greeting-text">
                <Sparkles className="sparkle-icon" size={32} />
                Hi Amir
              </h1>
              <h2 className="sub-greeting">Where should we start?</h2>

              <div className="suggestion-chips">
                {SUGGESTION_CHIPS.map(({ emoji, label, prompt }) => (
                  <button
                    key={label}
                    className="chip"
                    onClick={() => setIssue(prompt)}
                  >
                    <span>{emoji}</span> {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Output area */}
          {(isLoading || output) && (
            <div className="output-container">

              <div className="output-header">
                {isLoading ? (
                  <div className="status-badge">
                    <Sparkles size={16} className="spin-icon" />
                    {status}
                  </div>
                ) : (
                  <div className="status-badge" style={{ color: 'var(--text-tertiary)' }}>
                    <Check size={16} /> Analysis Complete
                  </div>
                )}

                {output && (
                  <button onClick={handleCopy} className="copy-btn">
                    {isCopied ? <Check size={16} /> : <Copy size={16} />}
                    <span>{isCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
              </div>

              {output && (
                <div className="markdown-body">
                  <ReactMarkdown
                    components={{
                      code({ node, inline, className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || '');
                        return !inline && match ? (
                          <SyntaxHighlighter
                            style={vscDarkPlus}
                            language={match[1]}
                            PreTag="div"
                            className="code-block"
                            {...props}
                          >
                            {String(children).replace(/\n$/, '')}
                          </SyntaxHighlighter>
                        ) : (
                          <code className="inline-code" {...props}>
                            {children}
                          </code>
                        );
                      },
                    }}
                  >
                    {output}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Input bar */}
        <div className="input-area">
          <form onSubmit={handleSubmit} className="gemini-input-form">

            <div className="input-icons-left">
              <Plus size={20} />
              <SlidersHorizontal size={20} className="tools-icon" />
              <span className="tools-text">Tools</span>
            </div>

            <textarea
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              placeholder="Enter a prompt for Consensus AI"
              rows={1}
              disabled={isLoading}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />

            <div className="input-icons-right">
              {issue.trim() ? (
                <button
                  type="submit"
                  disabled={isLoading}
                  className="send-btn"
                  aria-label="Send"
                >
                  <Send size={20} />
                </button>
              ) : (
                <button
                  type="button"
                  className={`mic-btn ${isListening ? 'listening' : ''}`}
                  onClick={handleMic}
                  aria-label={isListening ? 'Stop listening' : 'Start voice input'}
                  title={isListening ? 'Tap to stop' : 'Voice input'}
                >
                  <Mic size={20} />
                </button>
              )}
            </div>

          </form>
        </div>

      </div>
    </div>
  );
}

export default App;