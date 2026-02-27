// import React, { useState, useEffect, useRef } from 'react';
// import ReactMarkdown from 'react-markdown';
// import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
// import { Moon, Sun, Send, Menu, SquarePen, Sparkles, Plus, SlidersHorizontal, Mic, Copy, Check } from 'lucide-react';
// import './App.css';

// function App() {
//   const [issue, setIssue] = useState('');
//   const [statusMessage, setStatusMessage] = useState('');
//   const [finalOutput, setFinalOutput] = useState('');
//   const [isProcessing, setIsProcessing] = useState(false);
//   const [isDarkMode, setIsDarkMode] = useState(false);
//   const [isCopied, setIsCopied] = useState(false);
//   const [autoScroll, setAutoScroll] = useState(true); // Smart scroll state
  
//   const mainContentRef = useRef(null);

//   // Smart Auto-Scroll logic
//   useEffect(() => {
//     if (autoScroll && mainContentRef.current) {
//       // Smoothly scroll the container to the bottom without hijacking the whole page
//       mainContentRef.current.scrollTop = mainContentRef.current.scrollHeight;
//     }
//   }, [finalOutput, statusMessage, autoScroll]);

//   // Detect if the user manually scrolls up
//   const handleScroll = () => {
//     if (!mainContentRef.current) return;
//     const { scrollTop, scrollHeight, clientHeight } = mainContentRef.current;
//     // If user is within 100px of the bottom, keep auto-scrolling. Otherwise, pause it.
//     const isAtBottom = scrollHeight - scrollTop <= clientHeight + 100;
//     setAutoScroll(isAtBottom);
//   };

//   useEffect(() => {
//     document.body.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
//   }, [isDarkMode]);

//   const handleCopy = () => {
//     navigator.clipboard.writeText(finalOutput);
//     setIsCopied(true);
//     setTimeout(() => setIsCopied(false), 2000); // Reset button after 2 seconds
//   };

//   const handleSubmit = async (e) => {
//     e.preventDefault();
//     if (!issue.trim()) return;

//     setIsProcessing(true);
//     setStatusMessage('Initiating AI Consensus Chain...');
//     setFinalOutput('');
//     setAutoScroll(true); // Reset auto-scroll when a new prompt starts

//     try {
//       const response = await fetch('/api/solve-issue', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ issue })
//       });

//       const reader = response.body.getReader();
//       const decoder = new TextDecoder('utf-8');

//       while (true) {
//         const { value, done } = await reader.read();
//         if (done) break;

//         const chunk = decoder.decode(value, { stream: true });
//         const events = chunk.split('\n').filter(Boolean);

//         for (const event of events) {
//           try {
//             const parsed = JSON.parse(event);
//             if (parsed.type === 'status') {
//               setStatusMessage(parsed.data);
//             } else if (parsed.type === 'token') {
//               setFinalOutput((prev) => prev + parsed.data);
//               setStatusMessage('Finalizing...');
//             } else if (parsed.type === 'error') {
//               setFinalOutput(`**Error:** ${parsed.data}`);
//               setIsProcessing(false);
//             } else if (parsed.type === 'done') {
//               setStatusMessage('Done!');
//               setIsProcessing(false);
//             }
//           } catch (err) { }
//         }
//       }
//     } catch (error) {
//       setFinalOutput("**Network error.** Could not connect to the backend.");
//       setIsProcessing(false);
//     }
//   };

//   const handleChipClick = (text) => {
//     setIssue(text);
//   };

//   return (
//     <div className="layout">
//       {/* Sidebar */}
//       <aside className="sidebar">
//         <button className="icon-btn"><Menu size={20} /></button>
//         <button className="icon-btn new-chat-btn"><SquarePen size={20} /></button>
//       </aside>

//       {/* Main Content Area */}
//       <div className="main-wrapper">
//         <header className="header">
//           <div className="logo">
//             <h2>Consensus AI</h2>
//           </div>
//           <button 
//             className="theme-toggle" 
//             onClick={() => setIsDarkMode(!isDarkMode)}
//           >
//             {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
//           </button>
//         </header>

//         {/* Added the ref and onScroll listener here */}
//         <main className="main-content" ref={mainContentRef} onScroll={handleScroll}>
//           {!isProcessing && !finalOutput && (
//             <div className="gemini-empty-state">
//               <h1 className="greeting-text">
//                 <Sparkles className="sparkle-icon" size={32} /> Hi Md
//               </h1>
//               <h2 className="sub-greeting">Where should we start?</h2>
              
//               <div className="suggestion-chips">
//                 <button onClick={() => handleChipClick("Create an AWS VPC architecture diagram")} className="chip">
//                   <span>🍌</span> Create image
//                 </button>
//                 <button onClick={() => handleChipClick("Explain how Docker containers work")} className="chip">
//                   <span>🏏</span> Explore cricket
//                 </button>
//                 <button onClick={() => handleChipClick("Write a python script for data analysis")} className="chip">
//                   <span>🎸</span> Create music
//                 </button>
//                 <button onClick={() => handleChipClick("Review my cloud security policies")} className="chip">
//                   Write anything
//                 </button>
//                 <button onClick={() => handleChipClick("Help me debug a React application")} className="chip">
//                   Boost my day
//                 </button>
//                 <button onClick={() => handleChipClick("Teach me about Kubernetes")} className="chip">
//                   Help me learn
//                 </button>
//               </div>
//             </div>
//           )}

//           {(isProcessing || finalOutput) && (
//             <div className="output-container">
//               {/* Copy Button & Status Badge Header */}
//               <div className="output-header">
//                 {isProcessing ? (
//                   <div className="status-badge">
//                     <Sparkles size={16} className="spin-icon" />
//                     {statusMessage}
//                   </div>
//                 ) : (
//                   <div className="status-badge" style={{ color: 'var(--text-tertiary)' }}>
//                     <Check size={16} /> Analysis Complete
//                   </div>
//                 )}
                
//                 {/* The new Copy Button */}
//                 {finalOutput && (
//                   <button onClick={handleCopy} className="copy-btn">
//                     {isCopied ? <Check size={16} /> : <Copy size={16} />}
//                     <span>{isCopied ? 'Copied' : 'Copy'}</span>
//                   </button>
//                 )}
//               </div>

//               {finalOutput && (
//                 <div className="markdown-body">
//                   <ReactMarkdown
//                     components={{
//                       code({node, inline, className, children, ...props}) {
//                         const match = /language-(\w+)/.exec(className || '')
//                         return !inline && match ? (
//                           <SyntaxHighlighter
//                             children={String(children).replace(/\n$/, '')}
//                             style={vscDarkPlus}
//                             language={match[1]}
//                             PreTag="div"
//                             className="code-block"
//                             {...props}
//                           />
//                         ) : (
//                           <code className="inline-code" {...props}>
//                             {children}
//                           </code>
//                         )
//                       }
//                     }}
//                   >
//                     {finalOutput}
//                   </ReactMarkdown>
//                 </div>
//               )}
//             </div>
//           )}
//         </main>

//         {/* Input Box */}
//         <div className="input-area">
//           <form onSubmit={handleSubmit} className="gemini-input-form">
//             <div className="input-icons-left">
//                <Plus size={20} />
//                <SlidersHorizontal size={20} className="tools-icon" /> <span className="tools-text">Tools</span>
//             </div>
//             <textarea
//               value={issue}
//               onChange={(e) => setIssue(e.target.value)}
//               placeholder="Enter a prompt for Consensus AI"
//               rows={1}
//               disabled={isProcessing}
//               onKeyDown={(e) => {
//                 if (e.key === 'Enter' && !e.shiftKey) {
//                   e.preventDefault();
//                   handleSubmit(e);
//                 }
//               }}
//             />
//             <div className="input-icons-right">
//               {issue.trim() ? (
//                 <button type="submit" disabled={isProcessing} className="send-btn">
//                   <Send size={20} />
//                 </button>
//               ) : (
//                 <Mic size={20} />
//               )}
//             </div>
//           </form>
//         </div>
//       </div>
//     </div>
//   );
// }

// export default App;



import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Moon, Sun, Send, Menu, SquarePen, Sparkles, Plus, SlidersHorizontal, Mic, Copy, Check } from 'lucide-react';
import './App.css';

function App() {
  const [issue, setIssue] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [finalOutput, setFinalOutput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true); // Smart scroll state
  
  const mainContentRef = useRef(null);

  // Smart Auto-Scroll logic
  useEffect(() => {
    if (autoScroll && mainContentRef.current) {
      // Smoothly scroll the container to the bottom without hijacking the whole page
      mainContentRef.current.scrollTop = mainContentRef.current.scrollHeight;
    }
  }, [finalOutput, statusMessage, autoScroll]);

  // Detect if the user manually scrolls up
  const handleScroll = () => {
    if (!mainContentRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = mainContentRef.current;
    // If user is within 100px of the bottom, keep auto-scrolling. Otherwise, pause it.
    const isAtBottom = scrollHeight - scrollTop <= clientHeight + 100;
    setAutoScroll(isAtBottom);
  };

  useEffect(() => {
    document.body.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const handleCopy = () => {
    navigator.clipboard.writeText(finalOutput);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000); // Reset button after 2 seconds
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!issue.trim()) return;

    setIsProcessing(true);
    setStatusMessage('Initiating AI Consensus Chain...');
    setFinalOutput('');
    setAutoScroll(true); // Reset auto-scroll when a new prompt starts

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
              // CHANGED HERE: Now clearly states Gemini is finalizing the response
              setStatusMessage('Gemini is finalizing the response...');
            } else if (parsed.type === 'error') {
              setFinalOutput(`**Error:** ${parsed.data}`);
              setIsProcessing(false);
            } else if (parsed.type === 'done') {
              setStatusMessage('Done!');
              setIsProcessing(false);
            }
          } catch (err) { }
        }
      }
    } catch (error) {
      setFinalOutput("**Network error.** Could not connect to the backend.");
      setIsProcessing(false);
    }
  };

  const handleChipClick = (text) => {
    setIssue(text);
  };

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <button className="icon-btn"><Menu size={20} /></button>
        <button className="icon-btn new-chat-btn"><SquarePen size={20} /></button>
      </aside>

      {/* Main Content Area */}
      <div className="main-wrapper">
        <header className="header">
          <div className="logo">
            <h2>Consensus AI</h2>
          </div>
          <button 
            className="theme-toggle" 
            onClick={() => setIsDarkMode(!isDarkMode)}
          >
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </header>

        {/* Added the ref and onScroll listener here */}
        <main className="main-content" ref={mainContentRef} onScroll={handleScroll}>
          {!isProcessing && !finalOutput && (
            <div className="gemini-empty-state">
              <h1 className="greeting-text">
                <Sparkles className="sparkle-icon" size={32} /> Hi Md
              </h1>
              <h2 className="sub-greeting">Where should we start?</h2>
              
              <div className="suggestion-chips">
                <button onClick={() => handleChipClick("Create an AWS VPC architecture diagram")} className="chip">
                  <span>🍌</span> Create image
                </button>
                <button onClick={() => handleChipClick("Explain how Docker containers work")} className="chip">
                  <span>🏏</span> Explore cricket
                </button>
                <button onClick={() => handleChipClick("Write a python script for data analysis")} className="chip">
                  <span>🎸</span> Create music
                </button>
                <button onClick={() => handleChipClick("Review my cloud security policies")} className="chip">
                  Write anything
                </button>
                <button onClick={() => handleChipClick("Help me debug a React application")} className="chip">
                  Boost my day
                </button>
                <button onClick={() => handleChipClick("Teach me about Kubernetes")} className="chip">
                  Help me learn
                </button>
              </div>
            </div>
          )}

          {(isProcessing || finalOutput) && (
            <div className="output-container">
              {/* Copy Button & Status Badge Header */}
              <div className="output-header">
                {isProcessing ? (
                  <div className="status-badge">
                    <Sparkles size={16} className="spin-icon" />
                    {statusMessage}
                  </div>
                ) : (
                  <div className="status-badge" style={{ color: 'var(--text-tertiary)' }}>
                    <Check size={16} /> Analysis Complete
                  </div>
                )}
                
                {/* The new Copy Button */}
                {finalOutput && (
                  <button onClick={handleCopy} className="copy-btn">
                    {isCopied ? <Check size={16} /> : <Copy size={16} />}
                    <span>{isCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
              </div>

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
            </div>
          )}
        </main>

        {/* Input Box */}
        <div className="input-area">
          <form onSubmit={handleSubmit} className="gemini-input-form">
            <div className="input-icons-left">
               <Plus size={20} />
               <SlidersHorizontal size={20} className="tools-icon" /> <span className="tools-text">Tools</span>
            </div>
            <textarea
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              placeholder="Enter a prompt for Consensus AI"
              rows={1}
              disabled={isProcessing}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
            <div className="input-icons-right">
              {issue.trim() ? (
                <button type="submit" disabled={isProcessing} className="send-btn">
                  <Send size={20} />
                </button>
              ) : (
                <Mic size={20} />
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;