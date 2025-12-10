import { GoogleGenerativeAI } from '@google/generative-ai';

// Rate limiting: userId → {count, resetTime}
const rateLimits = new Map();

// Límites por minuto
const FREE_LIMIT = 10;
const PREMIUM_LIMIT = 100;
const RESET_INTERVAL = 60000; // 60 segundos

// Contador global de requests para logs
let globalRequestNumber = 0;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { userMessage, context, userId, isPremium } = req.body;

    if (!userMessage || userMessage.length > 1000) {
      return res.status(400).json({ error: 'Mensaje inválido' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID requerido' });
    }

    // Validar isPremium (debe ser boolean)
    const userIsPremium = Boolean(isPremium);
    const limit = userIsPremium ? PREMIUM_LIMIT : FREE_LIMIT;

    // Rate limiting por minuto
    const now = Date.now();
    const userLimit = rateLimits.get(userId);

    if (userLimit) {
      // Si ha pasado el intervalo de reset, reiniciar contador
      if (now >= userLimit.resetTime) {
        userLimit.count = 0;
        userLimit.resetTime = now + RESET_INTERVAL;
      }

      // Verificar si excedió el límite
      if (userLimit.count >= limit) {
        const resetIn = Math.ceil((userLimit.resetTime - now) / 1000);
        
        // Log del límite excedido
        globalRequestNumber++;
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          userId,
          messageLength: userMessage.length,
          isPremium: userIsPremium,
          requestNumber: globalRequestNumber,
          event: 'RATE_LIMIT_EXCEEDED',
          limit,
          currentCount: userLimit.count
        }));

        return res.status(429).json({
          error: 'Límite alcanzado',
          mensaje: userIsPremium 
            ? 'Has alcanzado tu límite de consultas por minuto. Como usuario premium, puedes hacer hasta 100 consultas por minuto. Intenta de nuevo en unos momentos. ✨'
            : 'Has alcanzado tu límite de consultas por minuto. Puedes hacer hasta 10 consultas por minuto. Considera actualizar a premium para obtener más consultas. ✨',
          resetIn
        });
      }

      // Incrementar contador
      userLimit.count++;
    } else {
      // Primera petición del usuario
      rateLimits.set(userId, {
        count: 1,
        resetTime: now + RESET_INTERVAL
      });
    }

    // Limpiar map si crece demasiado
    if (rateLimits.size > 10000) {
      rateLimits.clear();
    }

    // Log de la petición
    globalRequestNumber++;
    const currentLimit = rateLimits.get(userId);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      userId,
      messageLength: userMessage.length,
      isPremium: userIsPremium,
      requestNumber: globalRequestNumber,
      event: 'REQUEST_PROCESSED',
      currentCount: currentLimit.count,
      limit
    }));

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

    const currentLimitData = rateLimits.get(userId);
    const remainingRequests = limit - currentLimitData.count;

    return res.status(200).json({
      response: responseText,
      remainingRequests: remainingRequests >= 0 ? remainingRequests : 0,
      isPremium: userIsPremium
    });

  } catch (error) {
    console.error('Error en Gemini API:', error);
    return res.status(500).json({
      error: 'Error al conectar con la guía espiritual',
      message: 'Por favor, intenta de nuevo.'
    });
  }
}
