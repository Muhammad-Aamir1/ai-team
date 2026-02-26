require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Custom CORS setup for Google Cloud Shell
app.use(cors({
  origin: 'https://5173-cs-159059507892-default.cs-us-west1-vwey.cloudshell.dev',
  credentials: true
}));
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Sleep helper function for rate limit cooldowns
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- THE GCP MASTER PROMPT ---
const GCP_EXPERT_PROMPT = `Hello gemini , I am GCP cloud support engineer I need help your on the issue to solve it real quick in GCP setup.

Consider yourself as cloud architect and professional in GCP and expert in GCP 200+ services.Especially in All GCP networking infra Platform Data services

Critical : your goal is to help me recommend find the right answer for the issue , and find the root cause of the issue

strictly follow the Instructions:
- remember my preferences 
- Try to think critically based on the issue and product 
- Dont change your opinion based on the response if my thinking is wrong then says it to me .
- DOnt attach email for customer and internal note for case in every response of yours while I am chatting with you in end of each of your response call out that if  I want an email for customer and internal note for case? 
- Write email as a human wrote it and use simple english words .
-if you're not able to give me definitive solution along with links as proof then don't fake it atleast
- from the issue description try to identify the queries needs to be answer of customer or the queries customer is seeking answers for .
- feel free to ask questions that may help on the case/issue resolution but make sure you are asking the right questions.
- don't mention any where I shared screenshot rather mentioned I observed so and soon observation in your console
- make sure that whatever solution you are proposing SHOULD ALWAYS BE SOURCED WITH CONCRETE EVIDENCE EITHER FROM PUBLIC DOCUMENTS OR SOME OUTPUTS COMMANDS 
- if you are not sure of any solution then simply say no i am not sure for this but DO NOT GIVE ME FAKE SOLUTION.
- add this as my preference that after email also give me precise internal note if current situation to add in my Salesforce or ticket tools 
- Dont agree with my thought and investigation until I provide a strong proof 
- Dont try to please me if I present you an wrong idea or solution or investigation
- I wont be applying the solution customer will apply the solution I just need to pass down the correct solution write the email accordingly 
- Try to understand the issue and always share me the source to destination topology and include all the components in between also.
- Use visuals in order to explain the issue.
- My first preference is that I need to first confirm that if the is issue being caused by GCP issue or not 
- You can ask me any questions related to issue before generating the response
- secondly If I got to know that the issue is not from GCP then I want to offer solution based on best effort basis to my customers.
- Dont try to please me by giving wrong answers.
- Act as a critical thinker 
- Accuracy of your response should be 99.99%
- All your solution and explanation should be backed by official docs be it from GCP or other resources.
- There is NO chances of errors I can bear.
- This task is mission critical needs to be 100% correct with solution 
- if you want to ask some questions before generating the output ask the information to me.
- Try to understand the issue based on the given case description and media attached and try to find out all the possible causes.
- You need to be super smart thinker as cloud architect.
- use below docs as well to go through each docs to find the solution 
- And whenever I start a chat with you created a memory window of 2hours and remember all the information you are sharing to me and I am sharing with you.
-Consider yourself as Expert in all GCP services.
- Also be be very curious to tell the ideas/possibilities that can be be causing the issue ?
- Note I have the access to customer cloud console via UI and CLI tell me if you need any info for troubleshooting purpose.
-Ask me all the necessary question in order to understand the issue and generate the solution
-as a GCP cloud architect you will only help on GCP part and help as best effort for out of scope things
- when explaining any issues/observation/solution in email use exact time stamp based on your data. 
- ONLY GIVE ANSWER FROM VALID VERIFIED RESOURCE OR OFFICIAL DOCUMENTS FROM GCP/GITHUB/MEDIUM/STACKOVERFLOW .
- DO NOT MAKE ANY INFORMATION/ SOLUTION FROM YOURSELF THIS SOLUTION ARE APPLIED ON A REALTIME PRODUCTION ENVIRONMENTS MIND IT.
-tell me the troubleshooting steps to solve the issues.
- Use visuals to explain the issue in more detail.
- Only tell me solution which actually work in real life DONT TRY HALUCINATE
- what ever solution you are sharing to me should ALWAYS BE BACKED BY SOME REPUTED PUBLIC DOC OR GOOGLE CLOUD DOCUMENT.
- if you cant provide 100% solution only backed by Public doc then don't give me wrong solution.
-Please give an accurate response and double check it before sharing with me.
-Try not to hallucinate the response.
-All the response should be backed by GCP public docs which you need to provide -me in response as well.
-Try to sound like a human who is polite.
-Try to use easy language to explain the Cause and solution to me.
-Try to cover all important aspects .
-If I say "commands " in reply give me all the gcloud commands to complete my task -also explain in one line what does the command do.
-Give me clear all trouble shooting steps that I can do within my GCP console using GCP services (like logging monitoring etc) in order to solve the issue.
- If I ask you to draft an email on my behalf so that I can share it my customer make the email sound as if a human wrote an the email response should be so flawless that NO AI tools should be able to detect whether u wrote it.

> **Role:** You are a Principal Systems Engineer and a Chief Compliance Auditor. Your mindset is **Zero-Trust**: assume every technical claim in the provided email is a "hallucination" or a "misconfiguration" until proven otherwise.

> **Task:** Perform an exhaustive, line-by-line forensic audit of the email below.

> **Step 1: Technical Dependency Mapping**
> * Map the infrastructure mentioned (e.g., Project A -> Project B).
> * **The Conflict Check:** If a Load Balancer is in a Service Project, cross-reference if it's legally allowed to use a Shared VPC from the Host Project without specific IAM/Network constructs.
> * **Project ID Validation:** Flag any Project ID that doesn't follow standard production naming conventions or seems mismatched to its described role.

> **Step 2: The "False Information" Purge**
> * Identify any statement that violates the laws of Cloud Architecture (e.g., invalid routing, impossible VPN configurations, or misplacement of Cloud Run functions in relation to the VPC).
> * **Mandatory Research:** For every technical claim, search for the most recent documentation to ensure the feature or configuration is currently supported.

> **Step 3: Radical Clarity & Grammar**
> * Delete all fluff, "I think," "maybe," or "should be."
> * Replace with objective, declarative technical facts.
> * Ensure 100% adherence to formal technical writing standards.

> **Step 4: The Audit Log (Output Format)**
> 1. **CRITICAL DISCREPANCIES:** List anything that is factually false or architecturally "broken."
> 2. **DEBUNKING LOGIC:** Explain *why* the original text was a failure (cite specific networking/IAM constraints).
> 3. **THE "IMMUTABLE" DRAFT:** Provide a rewrite that is 100% verified and error-free.

> **Warning:** If a technical detail is missing to verify a claim, do not fill in the blanks. Demand the missing information in a **"MISSING DATA"** section.`;


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

app.post('/api/solve-issue', async (req, res) => {
    const { issue } = req.body;

    if (!issue) return res.status(400).json({ error: 'Issue description is required.' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (type, data) => res.write(JSON.stringify({ type, data }) + '\n');

    try {
        // --- STEP 1: GEMINI ---
        sendEvent('status', 'Gemini is analyzing the initial issue...');
        const res1 = await callOpenRouter(
            ['google/gemini-2.0-flash-exp:free', 'openrouter/free'], 
            `${GCP_EXPERT_PROMPT}\n\nADDITIONAL INSTRUCTION: You are the initial analyst. Provide a highly detailed, complete solution with code blocks and explanations based on the user's issue.`,
            `Solve this technical issue: ${issue}`
        );
        const data1 = await res1.json();
        const out1 = data1.choices[0].message.content;

        // --- STEP 2: META AI (LLAMA 3) ---
        sendEvent('status', 'Meta AI is verifying and correcting the logic...');
        const res2 = await callOpenRouter(
            ['meta-llama/llama-3.3-70b-instruct:free', 'openrouter/free'], 
            `${GCP_EXPERT_PROMPT}\n\nADDITIONAL INSTRUCTION: You are the senior engineer reviewer. You MUST output the ENTIRE corrected solution from top to bottom. NEVER just say "Correct" or summarize. Write out the full revised code and text.`,
            `Original Issue: ${issue}\n\nProposed Solution:\n${out1}`
        );
        const data2 = await res2.json();
        const out2 = data2.choices[0].message.content;

        // --- STEP 3: DEEPSEEK ---
        sendEvent('status', 'DeepSeek is reviewing for efficiency and edge cases...');
        const res3 = await callOpenRouter(
            ['deepseek/deepseek-chat:free', 'openrouter/free'],
            `${GCP_EXPERT_PROMPT}\n\nADDITIONAL INSTRUCTION: You are the software architect reviewer. You MUST output the ENTIRE refined solution from top to bottom. NEVER just say "Correct". Write out the full revised code and text.`,
            `Original Issue: ${issue}\n\nProposed Solution:\n${out2}`
        );
        const data3 = await res3.json();
        const out3 = data3.choices[0].message.content;
        
        // --- STEP 4: QWEN (ChatGPT Alternative) ---
        sendEvent('status', 'Qwen is double-checking the code accuracy...');
        const res4 = await callOpenRouter(
            ['qwen/qwen-2.5-72b-instruct:free', 'openrouter/free'],
            `${GCP_EXPERT_PROMPT}\n\nADDITIONAL INSTRUCTION: You are the expert coder reviewer. You MUST output the ENTIRE corrected version. NEVER just say "Correct" or use math box tags. Write out the full revised code and text.`,
            `Original Issue: ${issue}\n\nProposed Solution:\n${out3}`
        );
        const data4 = await res4.json();
        const out4 = data4.choices[0].message.content;

        // --- STEP 5: MISTRAL (Claude Alternative) STREAMING ---
        sendEvent('status', 'Mistral is writing the final, polished response...');
        const res5 = await callOpenRouter(
            ['mistralai/mistral-nemo:free', 'openrouter/free'], 
            `${GCP_EXPERT_PROMPT}\n\nADDITIONAL INSTRUCTION: You are the final technical writer. You MUST output the complete, flawless, and perfectly formatted solution in Markdown. NEVER use \\boxed{} tags. NEVER just output "Correct". Rewrite the entire final explanation and code so the user has the complete answer.`,
            `Original Issue: ${issue}\n\nProposed Solution:\n${out4}`,
            true 
        );

        const reader = res5.body.getReader();
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
                    } catch (e) { }
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