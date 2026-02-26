import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Moon, Sun, Send, Bot, Sparkles } from 'lucide-react';
import './App.css';

function App() {
  const [issue, setIssue] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [finalOutput, setFinalOutput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);
  
  const outputEndRef = useRef(null);

  // Auto-scroll to bottom as text streams
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [finalOutput, statusMessage]);

  // Handle Dark Mode toggle
  useEffect(() => {
    document.body.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!issue.trim()) return;

    setIsProcessing(true);
    setStatusMessage('Initiating AI Consensus Chain...');
    setFinalOutput('');

    try {
      const response = await fetch('/api/solve-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const events = chunk.split('\n').filter(Boolean);

        for (const event of events) {
          try {
            const parsed = JSON.parse(event);
            if (parsed.type === 'status') {
              setStatusMessage(parsed.data);
            } else if (parsed.type === 'token') {
              setFinalOutput((prev) => prev + parsed.data);
              setStatusMessage('Finalizing...');
            } else if (parsed.type === 'error') {
              setFinalOutput(`**Error:** ${parsed.data}`);
              setIsProcessing(false);
            } else if (parsed.type === 'done') {
              setStatusMessage('Done!');
              setIsProcessing(false);
            }
          } catch (err) {
            // Ignore partial JSON chunks during rapid streaming
          }
        }
      }
    } catch (error) {
      setFinalOutput("**Network error.** Could not connect to the backend.");
      setIsProcessing(false);
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="logo">
          <Sparkles className="icon-sparkle" size={28} />
          <h1>Consensus AI</h1>
        </div>
        <button 
          className="theme-toggle" 
          onClick={() => setIsDarkMode(!isDarkMode)}
          aria-label="Toggle dark mode"
        >
          {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </header>

      {/* Main Content Area */}
      <main className="main-content">
        {!isProcessing && !finalOutput && (
          <div className="empty-state">
            <Bot size={48} className="empty-icon" />
            <h2>How can I help you today?</h2>
            <p>Describe your tech, code, or cloud architecture issue. I will pass it through 5 flagship AI models to verify and refine the perfect solution.</p>
          </div>
        )}

        {(isProcessing || finalOutput) && (
          <div className="output-container">
            {/* Status Indicator */}
            {isProcessing && (
              <div className="status-badge">
                <div className="pulsing-dot"></div>
                {statusMessage}
              </div>
            )}

            {/* Markdown Rendered Output */}
            {finalOutput && (
              <div className="markdown-body">
                <ReactMarkdown
                  components={{
                    code({node, inline, className, children, ...props}) {
                      const match = /language-(\w+)/.exec(className || '')
                      return !inline && match ? (
                        <SyntaxHighlighter
                          children={String(children).replace(/\n$/, '')}
                          style={vscDarkPlus}
                          language={match[1]}
                          PreTag="div"
                          className="code-block"
                          {...props}
                        />
                      ) : (
                        <code className="inline-code" {...props}>
                          {children}
                        </code>
                      )
                    }
                  }}
                >
                  {finalOutput}
                </ReactMarkdown>
              </div>
            )}
            <div ref={outputEndRef} />
          </div>
        )}
      </main>

      {/* Input Area (Pinned to bottom like a chat UI) */}
      <div className="input-wrapper">
        <form onSubmit={handleSubmit} className="input-form">
          <textarea
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            placeholder="Ask anything about code, cloud, or tech..."
            rows={1}
            disabled={isProcessing}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />
          <button 
            type="submit" 
            disabled={isProcessing || !issue.trim()}
            className="submit-btn"
          >
            <Send size={20} />
          </button>
        </form>
        <p className="disclaimer">Consensus AI checks outputs across Gemma, Llama, Mistral, Qwen, and Phi-3.</p>
      </div>
    </div>
  );
}

export default App;