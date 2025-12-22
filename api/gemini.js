import { GoogleGenAI } from '@google/genai';

// Rate limiting: userId → {count, resetTime}
const rateLimits = new Map();

// Límites por minuto
const FREE_LIMIT = 10;
const PREMIUM_LIMIT = 100;
const RESET_INTERVAL = 60000; // 60 segundos

// Contador global de requests para logs
let globalRequestNumber = 0;

export default async function handler(req, res) {
  // Manejar CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { userMessage, context, userId, isPremium } = req.body;

    // Validaciones
    if (!userMessage || userMessage.length > 2000) {
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
            ? `Has alcanzado tu límite de consultas por minuto. Como usuario premium, puedes hacer hasta 100 consultas por minuto. Intenta de nuevo en ${resetIn} segundos. ✨`
            : `Has alcanzado tu límite de consultas por minuto. Puedes hacer hasta 10 consultas por minuto. Considera actualizar a premium para obtener más consultas. Intenta de nuevo en ${resetIn} segundos. ✨`,
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

    // Verificar que la API key esté configurada
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY no está configurada');
      return res.status(500).json({
        error: 'Error de configuración del servidor',
        message: 'Por favor, intenta de nuevo.'
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

    // Llamar a Gemini con la nueva librería (usando gemini-2.5-flash)
    const ai = new GoogleGenAI({ 
      apiKey: process.env.GEMINI_API_KEY 
    });

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', // Usando el mismo modelo que funciona en la app
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens: 500, // Aumentado para respuestas más completas
          temperature: 0.7,
          topP: 0.8,
          topK: 25,
        }
      });
      
      // Extraer texto de la respuesta
      let responseText = '';
      if (typeof response.text === 'function') {
        responseText = await response.text();
      } else if (typeof response.text === 'string') {
        responseText = response.text;
      } else if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
        responseText = response.candidates[0].content.parts[0].text;
      } else {
        throw new Error('No se pudo extraer el texto de la respuesta');
      }

      console.log('✅ Respuesta de Gemini obtenida, longitud:', responseText.length);

      const currentLimitData = rateLimits.get(userId);
      const remainingRequests = limit - currentLimitData.count;

      // Devolver JSON directo (como funcionaba antes)
      return res.status(200).json({
        response: responseText,
        remainingRequests: remainingRequests >= 0 ? remainingRequests : 0,
        isPremium: userIsPremium
      });

    } catch (geminiError) {
      console.error('Error en Gemini API:', geminiError);
      console.error('Error details:', {
        message: geminiError.message,
        stack: geminiError.stack,
        name: geminiError.name
      });
      
      return res.status(500).json({
        error: 'Error al conectar con la guía espiritual',
        message: geminiError.message || 'Por favor, intenta de nuevo.'
      });
    }

  } catch (error) {
    console.error('Error en handler:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    return res.status(500).json({
      error: 'Error al conectar con la guía espiritual',
      message: error.message || 'Por favor, intenta de nuevo.'
    });
  }
}
