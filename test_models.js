require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    // Actually, in the standard SDK, there's no native listModels exposed easily, 
    // but we can fetch it via REST.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    console.log(data.models.map(m => m.name).filter(n => n.includes('flash')));
}

listModels();
