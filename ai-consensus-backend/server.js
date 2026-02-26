require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Kept your custom CORS setup for Google Cloud Shell
app.use(cors({
  origin: 'https://5173-cs-159059507892-default.cs-us-west1-vwey.cloudshell.dev',
  credentials: true
}));
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// --- UPDATED: Helper function with Fallback Loop ---
async function callOpenRouter(modelList, systemPrompt, userPrompt, stream = false) {
    // Loop through the array of models provided
    for (const model of modelList) {
        try {
            console.log(`Attempting to use model: ${model}...`);
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
                return response; // Success! Return the response and exit the loop
            } else {
                console.warn(`[Warning] ${model} failed with status ${response.status}. Trying backup...`);
            }
        } catch (error) {
            console.warn(`[Warning] Network error reaching ${model}. Trying backup...`);
        }
    }
    
    // If it loops through all backups and fails, throw the final error
    throw new Error("All fallback models are currently busy.");
}

app.post('/api/solve-issue', async (req, res) => {
    const { issue } = req.body;

    if (!issue) {
        return res.status(400).json({ error: 'Issue description is required.' });
    }

    // Set headers for Server-Sent Events (Streaming to React)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (type, data) => {
        res.write(JSON.stringify({ type, data }) + '\n');
    };

    try {
        // --- STEP 1: GEMMA 2 (GOOGLE) + Fallback ---
        sendEvent('status', 'Gemma 2 is analyzing the initial issue...');
        const gemmaRes = await callOpenRouter(
            ['google/gemma-2-9b-it:free', 'openrouter/free'], 
            'You are a helpful technical assistant. Solve the user\'s issue.',
            `Solve this technical issue: ${issue}`
        );
        const gemmaData = await gemmaRes.json();
        const gemmaOutput = gemmaData.choices[0].message.content;

        // --- STEP 2: LLAMA 3.1 (META) + Fallback ---
        sendEvent('status', 'Llama 3.1 is verifying and correcting the logic...');
        const llamaRes = await callOpenRouter(
            ['meta-llama/llama-3.1-8b-instruct:free', 'openrouter/free'], 
            'You are a senior engineer. Verify this solution. Make corrections and provide the updated output.',
            `Original Issue: ${issue}\n\nProposed Solution:\n${gemmaOutput}`
        );
        const llamaData = await llamaRes.json();
        const llamaOutput = llamaData.choices[0].message.content;

        // --- STEP 3: MISTRAL + Fallback ---
        sendEvent('status', 'Mistral is reviewing for efficiency and edge cases...');
        const mistralRes = await callOpenRouter(
            ['mistralai/mistral-7b-instruct:free', 'openrouter/free'],
            'You are a software architect. Verify this proposed solution for best practices. Output the refined solution.',
            `Original Issue: ${issue}\n\nProposed Solution:\n${llamaOutput}`
        );
        const mistralData = await mistralRes.json();
        const mistralOutput = mistralData.choices[0].message.content;
        
        // --- STEP 4: QWEN 2 + Fallback ---
        sendEvent('status', 'Qwen 2 is double-checking the code accuracy...');
        const qwenRes = await callOpenRouter(
            ['qwen/qwen-2-7b-instruct:free', 'openrouter/free'],
            'You are an expert coder. Verify all code snippets in this solution are syntactically perfect. Output the corrected version.',
            `Original Issue: ${issue}\n\nProposed Solution:\n${mistralOutput}`
        );
        const qwenData = await qwenRes.json();
        const qwenOutput = qwenData.choices[0].message.content;

        // --- STEP 5: PHI-3 (MICROSOFT) - STREAMING + Fallback ---
        sendEvent('status', 'Phi-3 is writing the final, polished response...');
        const phiRes = await callOpenRouter(
            ['microsoft/phi-3-mini-128k-instruct:free', 'openrouter/free'], 
            'You are the final reviewer. Verify the following technical solution. Ensure it is perfectly formatted in Markdown. Output only the final response.',
            `Original Issue: ${issue}\n\nProposed Solution:\n${qwenOutput}`,
            true // Enable streaming
        );

        // Read the stream and pipe it to React
        const reader = phiRes.body.getReader();
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));