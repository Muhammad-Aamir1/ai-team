const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Custom CORS setup for Google Cloud Shell
// app.use(cors({
//   origin: 'https://5173-cs-159059507892-default.cs-us-west1-vwey.cloudshell.dev',
//   credentials: true
// }));

app.use(cors({
  origin: '*' 
}));
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Sleep helper function for rate limit cooldowns
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function with Retries & Cooldown
async function callOpenRouter(modelList, systemPrompt, userPrompt, stream = false) {
    const MAX_RETRIES = 3; 

    for (const model of modelList) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`Attempting to use model: ${model} (Attempt ${attempt}/${MAX_RETRIES})...`);
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'http://localhost:3000', 
                        'X-Title': 'AI Consensus Resolver'
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ],
                        stream: stream
                    })
                });

                if (response.ok) {
                    return response; 
                } else if (response.status === 429) {
                    console.warn(`[Rate Limit] 429 Too Many Requests on ${model}. Pausing for 3 seconds...`);
                    await sleep(3000); 
                } else {
                    console.warn(`[Warning] ${model} failed with status ${response.status}. Moving to backup...`);
                    break; 
                }
            } catch (error) {
                console.warn(`[Warning] Network error reaching ${model}. Moving to backup...`);
                break; 
            }
        }
    }
    throw new Error("All fallback models are currently busy or rate-limited.");
}

// Reusable System Prompt for the Reviewers (Steps 2-5)
const REVIEWER_SYSTEM_PROMPT = `You are an expert technical problem solver. Your task is to review the provided user issue and the proposed solution from a previous AI. You must carefully review the response, find any mistakes, find the correct answer for the solution, and explicitly identify the root cause of the issue.`;

// app.post('/api/solve-issue', async (req, res) => {
//     const { issue } = req.body;

//     if (!issue) return res.status(400).json({ error: 'Issue description is required.' });

//     res.setHeader('Content-Type', 'text/event-stream');
//     res.setHeader('Cache-Control', 'no-cache');
//     res.setHeader('Connection', 'keep-alive');
//     res.setHeader('X-Accel-Buffering', 'no'); // <-- ADD THIS LINE

//     const sendEvent = (type, data) => res.write(JSON.stringify({ type, data }) + '\n');

//     try {
app.post('/api/solve-issue', async (req, res) => {
    const { issue } = req.body;

    if (!issue) return res.status(400).json({ error: 'Issue description is required.' });

    // --- 1. BULLETPROOF STREAMING HEADERS FOR GOOGLE CLOUD ---
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); // no-transform prevents App Engine gzip buffering
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // --- 2. FORCE HEADERS TO SEND IMMEDIATELY ---
    res.flushHeaders();

    // --- 3. SMART EVENT SENDER WITH PADDING ---
    const sendEvent = (type, data) => {
        let payload = JSON.stringify({ type, data });
        
        // Trick Google's Proxy: Status updates are too small to trigger a network flush on their own.
        // We add 4KB of invisible space padding ONLY to 'status' events to force the proxy to push them to the UI instantly!
        if (type === 'status') {
            payload += ' '.repeat(4096);
        }
        
        res.write(payload + '\n');
    };

    try {
        // --- STEP 1: GEMINI (Initial Answer) ---
        // --- STEP 1: GEMINI (Initial Answer) ---
        sendEvent('status', 'Gemini is analyzing the initial issue...');
        const res1 = await callOpenRouter(
            ['google/gemini-2.0-flash-exp:free', 'openrouter/free'], 
            'You are an expert technical problem solver. Analyze the issue, identify the root cause, and provide the correct solution.',
            `User Query: ${issue}`
        );
        const data1 = await res1.json();
        const out1 = data1.choices[0].message.content;

        // --- STEP 2: DEEPSEEK (Review Gemini) ---
        sendEvent('status', 'DeepSeek is reviewing and finding mistakes...');
        const res2 = await callOpenRouter(
            ['deepseek/deepseek-chat:free', 'openrouter/free'], 
            REVIEWER_SYSTEM_PROMPT,
            `User Query: ${issue}\n\nPrevious AI Output (Gemini):\n${out1}\n\nPlease review the response above, find any mistakes, provide the correct solution, and explicitly state the root cause.`
        );
        const data2 = await res2.json();
        const out2 = data2.choices[0].message.content;

        // --- STEP 3: META LLAMA 3 (Review DeepSeek) ---
        sendEvent('status', 'Meta Llama 3 is verifying the solution...');
        const res3 = await callOpenRouter(
            ['meta-llama/llama-3.3-70b-instruct:free', 'openrouter/free'],
            REVIEWER_SYSTEM_PROMPT,
            `User Query: ${issue}\n\nPrevious AI Output (DeepSeek):\n${out2}\n\nPlease review the response above, find any mistakes, provide the correct solution, and explicitly state the root cause.`
        );
        const data3 = await res3.json();
        const out3 = data3.choices[0].message.content;
        
        // --- STEP 4: QWEN (Review Llama) ---
        sendEvent('status', 'Qwen is double-checking accuracy...');
        const res4 = await callOpenRouter(
            ['qwen/qwen-2.5-72b-instruct:free', 'openrouter/free'],
            REVIEWER_SYSTEM_PROMPT,
            `User Query: ${issue}\n\nPrevious AI Output (Meta Llama):\n${out3}\n\nPlease review the response above, find any mistakes, provide the correct solution, and explicitly state the root cause.`
        );
        const data4 = await res4.json();
        const out4 = data4.choices[0].message.content;

        // --- STEP 5: MISTRAL (Review Qwen) ---
        sendEvent('status', 'Mistral is running a final compliance check...');
        const res5 = await callOpenRouter(
            ['mistralai/mistral-nemo:free', 'openrouter/free'], 
            REVIEWER_SYSTEM_PROMPT,
            `User Query: ${issue}\n\nPrevious AI Output (Qwen):\n${out4}\n\nPlease review the response above, find any remaining mistakes, provide the absolute correct solution, identify the root cause.`
        );
        const data5 = await res5.json();
        const out5 = data5.choices[0].message.content;

        // --- STEP 6: GEMINI FINAL SYNTHESIZER (STREAMING) ---
        sendEvent('status', 'Gemini Final is polishing the response for the customer...');
        const FINAL_SYSTEM_PROMPT = `You are the Lead Cloud Architect and Customer Success Manager. You will be provided with a user's query and the technical analysis generated by 5 different AI engineers. 
        
Your STRICT objectives:
1. Synthesize all the provided outputs into a SINGLE, perfect, correct answer.
2. Resolve any internal conflicts or disagreements the previous AI models had. NEVER mention the other AI models, the review process, or say things like "The previous response was wrong."
3. Make the response highly polite, friendly, and clean. Include appropriate emojis/icons to make it visually appealing and easy to read.
4. Clearly state the Root Cause, the Solution, and any commands required to fix it in beautifully formatted Markdown.`;

        const res6 = await callOpenRouter(
            ['google/gemini-2.0-flash-exp:free', 'openrouter/free'], 
            FINAL_SYSTEM_PROMPT,
            `Original Customer Query: ${issue}\n\n--- AI 1 Analysis ---\n${out1}\n\n--- AI 2 Analysis ---\n${out2}\n\n--- AI 3 Analysis ---\n${out3}\n\n--- AI 4 Analysis ---\n${out4}\n\n--- AI 5 Analysis ---\n${out5}\n\nBased on all of the analysis above, please generate the final, perfect, highly polite response for the customer.`,
            true // Enable streaming
        );

        const reader = res6.body.getReader();
        const decoder = new TextDecoder("utf-8");

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim() !== '');
            
            for (const line of lines) {
                if (line === 'data: [DONE]') break;
                if (line.startsWith('data: ')) {
                    try {
                        const parsed = JSON.parse(line.replace('data: ', ''));
                        if (parsed.choices && parsed.choices[0].delta.content) {
                            sendEvent('token', parsed.choices[0].delta.content);
                        }
                    } catch (e) { /* Ignore partial JSON chunks */ }
                }
            }
        }

        sendEvent('done', 'Process complete.');
        res.end();

    } catch (error) {
        console.error("Chain Error:", error);
        sendEvent('error', 'The AI network is currently overloaded. Please try again in a few moments.');
        res.end();
    }
});

// --- NEW: Serve React Frontend ---
app.use(express.static(path.join(__dirname, 'dist')));

// Smart catch-all route to serve the React app
app.use((req, res, next) => {
    // If it's a page navigation (no dot in the path), serve index.html and DO NOT cache it
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.includes('.')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    } else {
        // If it's a missing .js or .css file, cleanly return a 404 instead of an HTML file
        res.status(404).send('File not found');
    }
});

// Explicitly bind to 0.0.0.0 so Cloud Run can reach it
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend successfully running on port ${PORT}`);
});