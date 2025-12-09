import { GoogleGenerativeAI } from '@google/generative-ai';

const userLimits = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { userMessage, context, userId } = req.body;

    if (!userMessage || userMessage.length > 1000) {
      return res.status(400).json({ error: 'Mensaje inválido' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID requerido' });
    }

    // Rate limiting
    const today = new Date().toISOString().split('T')[0];
    const userKey = `${userId}-${today}`;
    const currentCount = userLimits.get(userKey) || 0;
    
    if (currentCount >= 20) {
      return res.status(429).json({ 
        error: 'Límite diario alcanzado',
        message: 'Has alcanzado el límite de 20 consultas diarias.',
        isPremium: false
      });
    }

    // Filtro de seguridad
    const BLOCKED_PHRASES = [
      'ignore', 'forget', 'bypass', 'jailbreak',
      'instrucciones anteriores', 'system prompt'
    ];
    const lowerMessage = userMessage.toLowerCase();
    if (BLOCKED_PHRASES.some(phrase => lowerMessage.includes(phrase))) {
      return res.json({
        response: 'Solo puedo ayudarte con tarot y rituales ✨'
      });
    }

    // System prompt fijo
    const SYSTEM_PROMPT = `
Eres Mystara, una guía espiritual experta en tarot y rituales místicos.

REGLAS ESTRICTAS:

1. Solo respondes sobre: tarot, rituales, espiritualidad, fases lunares

2. Si preguntan algo no relacionado: "Solo puedo guiarte en temas espirituales ✨"

3. Tono místico, cálido y empático

4. Máximo 300 palabras

5. Nunca menciones que eres una IA

6. Siempre en español

    `.trim();

    const fullPrompt = `

${SYSTEM_PROMPT}

CONTEXTO: ${JSON.stringify(context, null, 2)}

PREGUNTA: ${userMessage}

Responde como Mystara.

    `.trim();

    // Llamar a Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent(fullPrompt);
    const responseText = result.response.text();

    // Incrementar contador
    userLimits.set(userKey, currentCount + 1);
    if (userLimits.size > 10000) {
      userLimits.clear();
    }

    return res.status(200).json({
      response: responseText,
      remainingRequests: 20 - (currentCount + 1),
      isPremium: false
    });

  } catch (error) {
    console.error('Error en Gemini API:', error);
    return res.status(500).json({
      error: 'Error al conectar con la guía espiritual',
      message: 'Por favor, intenta de nuevo.'
    });
  }
}
