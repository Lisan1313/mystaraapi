import { GoogleGenAI } from '@google/genai';

// Rate limiting: userId → {count, resetTime}
const rateLimits = new Map();

// Límites por minuto
const FREE_LIMIT = 10;
const PREMIUM_LIMIT = 100;
const RESET_INTERVAL = 60000; // 60 segundos

// Contador global de requests para logs
let globalRequestNumber = 0;

// Función helper para enviar respuesta en formato SSE
function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Función helper para enviar error en formato SSE
function sendSSEError(res, error, message) {
  sendSSE(res, { error, message });
  sendSSE(res, '[DONE]');
  res.end();
}

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

  // Configurar headers para streaming SSE ANTES de cualquier validación
  // Esto asegura que siempre devolvamos un stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Enviar headers inmediatamente (si está disponible)
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  try {
    const { userMessage, context, userId, isPremium } = req.body;

    // Validaciones - pero devolver en formato SSE
    if (!userMessage || userMessage.length > 2000) {
      return sendSSEError(res, 'Mensaje inválido', 'El mensaje debe tener entre 1 y 2000 caracteres.');
    }

    if (!userId) {
      return sendSSEError(res, 'User ID requerido', 'Se requiere un ID de usuario.');
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

        return sendSSEError(
          res,
          'Límite alcanzado',
          userIsPremium 
            ? `Has alcanzado tu límite de consultas por minuto. Como usuario premium, puedes hacer hasta 100 consultas por minuto. Intenta de nuevo en ${resetIn} segundos. ✨`
            : `Has alcanzado tu límite de consultas por minuto. Puedes hacer hasta 10 consultas por minuto. Considera actualizar a premium para obtener más consultas. Intenta de nuevo en ${resetIn} segundos. ✨`
        );
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
      sendSSE(res, { text: 'Solo puedo ayudarte con tarot y rituales ✨' });
      sendSSE(res, '[DONE]');
      return res.end();
    }

    // Verificar que la API key esté configurada
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY no está configurada');
      return sendSSEError(res, 'Error de configuración del servidor', 'Por favor, intenta de nuevo.');
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

    // Llamar a Gemini con la nueva librería (usando gemini-1.5-flash que es más estable)
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

      // Enviar respuesta en formato SSE (streaming)
      // Dividir el texto en chunks para simular streaming
      const chunkSize = 20; // Caracteres por chunk
      for (let i = 0; i < responseText.length; i += chunkSize) {
        const chunk = responseText.slice(i, i + chunkSize);
        sendSSE(res, { text: chunk });
        
        // Pequeña pausa para simular streaming real
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Enviar señal de finalización
      sendSSE(res, '[DONE]');
      res.end();

    } catch (geminiError) {
      console.error('Error en Gemini API:', geminiError);
      console.error('Error details:', {
        message: geminiError.message,
        stack: geminiError.stack,
        name: geminiError.name
      });
      
      return sendSSEError(
        res,
        'Error al conectar con la guía espiritual',
        geminiError.message || 'Por favor, intenta de nuevo.'
      );
    }

  } catch (error) {
    console.error('Error en handler:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    return sendSSEError(
      res,
      'Error al conectar con la guía espiritual',
      error.message || 'Por favor, intenta de nuevo.'
    );
  }
}
