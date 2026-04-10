async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.body && typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.Gemini_API_Key;
  if (!apiKey) return res.status(500).json({ error: 'Gemini_API_Key non configurata' });

  if (req.method === 'GET') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const d = await r.json();
    const models = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name);
    return res.status(200).json({ available: models, total: models.length });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const body = await readBody(req);
  console.log('[ai_checker] Body keys:', body ? Object.keys(body).join(',') : 'null');

  if (!body) return res.status(400).json({ error: 'Body non leggibile' });

  // ── Costruisci le parts Gemini accettando DUE formati ──────────
  // Formato A (index.html attuale): { problem: string, image: base64string }
  // Formato B (vecchio):            { messages: [{type, ...}] }
  const parts = [];

  if (body.messages && Array.isArray(body.messages)) {
    // Formato B
    for (const block of body.messages) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'image') {
        parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
      }
    }
  } else if (body.problem) {
    // Formato A — quello che manda il tuo index.html
    const ex = body.problem;
    parts.push({ text: `Esamina lo svolgimento dello studente per il seguente esercizio di Telecomunicazioni:\n\n${ex}\n\nRispondi SOLO con JSON: {"correct": true/false, "score": 1-10, "feedback": "commento in italiano"}` });

    if (body.image) {
      // L'immagine può arrivare come data URL "data:image/jpeg;base64,..." oppure base64 puro
      let b64 = body.image;
      let mime = 'image/jpeg';
      if (b64.startsWith('data:')) {
        const mimeMatch = b64.match(/data:(image\/\w+);base64,/);
        if (mimeMatch) mime = mimeMatch[1];
        b64 = b64.split(',')[1];
      }
      parts.push({ inlineData: { mimeType: mime, data: b64 } });
    }
  } else {
    console.error('[ai_checker] Formato body sconosciuto:', JSON.stringify(body).substring(0, 200));
    return res.status(400).json({ error: 'Body non valido: mancano sia messages che problem', keys: Object.keys(body) });
  }

  console.log('[ai_checker] Parts:', parts.length, parts.map(p => p.text ? 'text' : 'image').join(','));

  try {
    const systemInstruction = {
      parts: [{ text: `Sei un professore di Telecomunicazioni che corregge esercizi scolastici italiani.
Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown.
Struttura: {"correct": boolean, "score": intero 1-10, "feedback": "stringa italiana max 3 frasi"}` }]
    };

    const requestBody = {
      system_instruction: systemInstruction,
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: 'application/json' }
    };

    const CANDIDATES = [
      'models/gemini-2.0-flash',
      'models/gemini-2.0-flash-lite',
      'models/gemini-2.5-flash',
      'models/gemini-flash-latest',
      'models/gemini-2.5-pro',
    ];

    let geminiResp = null;
    let lastErr = '';
    for (const model of CANDIDATES) {
      const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      if (r.ok) { console.log('[ai_checker] Modello OK:', model); geminiResp = r; break; }
      lastErr = await r.text();
      console.warn('[ai_checker] Modello fallito:', model, r.status, lastErr.substring(0, 80));
    }

    if (!geminiResp) throw new Error('Tutti i modelli falliti: ' + lastErr.substring(0, 200));

    const data = await geminiResp.json();
    const rawText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    console.log('[ai_checker] Raw:', rawText.substring(0, 300));
    if (!rawText) throw new Error('Risposta Gemini vuota');

    // Parsing a 3 livelli
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch {}
    if (!parsed) { const m = rawText.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
    if (!parsed) {
      const ok = /"(?:correct|isCorrect)"\s*:\s*true/.test(rawText);
      const sc = rawText.match(/"score"\s*:\s*(\d+)/);
      const fb = rawText.match(/"feedback"\s*:\s*"([^"]{5,})/);
      parsed = { correct: ok, score: sc ? parseInt(sc[1]) : (ok ? 8 : 4), feedback: fb ? fb[1] : 'Correzione elaborata.' };
    }

    const isOk = Boolean(parsed.correct ?? parsed.isCorrect ?? false);

    // Risposta compatibile con ENTRAMBI i formati che showResult() può aspettarsi
    return res.status(200).json({
      correct:   isOk,
      isCorrect: isOk,
      score:     Math.min(10, Math.max(1, Number(parsed.score ?? (isOk ? 8 : 4)))),
      feedback:  String(parsed.feedback ?? parsed.correction ?? 'Correzione completata.'),
      correction: String(parsed.feedback ?? parsed.correction ?? '')
    });

  } catch (err) {
    console.error('[ai_checker] Errore handler:', err.message);
    return res.status(500).json({ correct: false, isCorrect: false, score: 0, feedback: 'Errore: ' + err.message });
  }
}
