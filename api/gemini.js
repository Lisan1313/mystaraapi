import { GoogleGenerativeAI } from '@google/generative-ai';

// Configurar Edge Runtime
export const runtime = 'edge';

// Rate limiting: userId → {count, resetTime}
const rateLimits = new Map();

// Límites por minuto
const FREE_LIMIT = 10;
const PREMIUM_LIMIT = 100;
const RESET_INTERVAL = 60000; // 60 segundos

// Contador global de requests para logs
let globalRequestNumber = 0;

export default async function handler(request) {
  // Manejar CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Método no permitido' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  try {
    const body = await request.json();
    const { userMessage, context, userId, isPremium } = body;

    if (!userMessage || userMessage.length > 2000) {
      return new Response(
        JSON.stringify({ error: 'Mensaje inválido' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'User ID requerido' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
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

        return new Response(
          JSON.stringify({
            error: 'Límite alcanzado',
            mensaje: userIsPremium 
              ? 'Has alcanzado tu límite de consultas por minuto. Como usuario premium, puedes hacer hasta 100 consultas por minuto. Intenta de nuevo en unos momentos. ✨'
              : 'Has alcanzado tu límite de consultas por minuto. Puedes hacer hasta 10 consultas por minuto. Considera actualizar a premium para obtener más consultas. ✨',
            resetIn
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
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
      const blockedStream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const data = JSON.stringify({ text: 'Solo puedo ayudarte con tarot y rituales ✨' });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      
      return new Response(blockedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
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

    // Verificar que existe la API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY no está configurada');
      return new Response(
        JSON.stringify({
          error: 'Error de configuración',
          message: 'Por favor, contacta al administrador.'
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Llamar a Gemini con streaming
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      }
    });

    // Generar contenido con streaming
    const result = await model.generateContentStream(fullPrompt);
    const stream = result.stream;

    // Convertir el stream de Gemini a formato SSE (Server-Sent Events)
    // Compatible 100% con Edge Runtime
    const encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              // Enviar cada chunk como evento SSE
              const data = JSON.stringify({ text: chunkText });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }
          
          // Enviar metadata final con remainingRequests
          const currentLimitData = rateLimits.get(userId);
          const remainingRequests = limit - currentLimitData.count;
          const metadata = JSON.stringify({
            done: true,
            remainingRequests: remainingRequests >= 0 ? remainingRequests : 0,
            isPremium: userIsPremium
          });
          controller.enqueue(encoder.encode(`data: ${metadata}\n\n`));
          
          // Señal de finalización
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (streamError) {
          console.error('Error en el stream:', streamError);
          try {
            const errorData = JSON.stringify({
              error: 'Error al generar la respuesta',
              message: 'Por favor, intenta de nuevo.'
            });
            controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (closeError) {
            console.error('Error al cerrar stream:', closeError);
          }
          controller.close();
        }
      },
      cancel() {
        // Manejar cancelación del stream
        console.log('Stream cancelado por el cliente');
      }
    });

    // Retornar el stream directamente con Response estándar (Edge Runtime compatible)
    return new Response(readableStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });

  } catch (error) {
    console.error('Error en Gemini API:', error);
    return new Response(
      JSON.stringify({
        error: 'Error al conectar con la guía espiritual',
        message: 'Por favor, intenta de nuevo.'
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}
