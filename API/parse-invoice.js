// Vercel serverless function: POST { filename, data (base64 PDF) }
// Returns: { items: [{ code, name, qty }] }
const pdfParse = require('pdf-parse');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { data } = req.body; // base64 string
    if (!data) {
      res.status(400).json({ error: 'No file data provided' });
      return;
    }

    const buffer = Buffer.from(data, 'base64');
    const parsed = await pdfParse(buffer);
    const rawText = parsed.text;

    if (!rawText || rawText.trim().length < 20) {
      res.status(422).json({
        error: 'Could not read text from this PDF. It may be a scanned image rather than a text-based document.'
      });
      return;
    }

    const prompt = `You are extracting line items from a wholesale grocery invoice. Below is the raw text extracted from a PDF invoice (formatting like columns and spacing may be imperfect).

Return ONLY a JSON array, nothing else before or after it. Each item in the array should be an object with exactly these fields:
- "code": the product/SKU code as it appears on the invoice (string)
- "name": the product description/name (string)
- "qty": the quantity shipped, as a number (not a string)

Skip any lines that are totals, subtotals, taxes, headers, footers, or anything that isn't an actual product line item. If a field is genuinely not present for a line, use null for that field, but always include "qty" as a number if at all determinable.

Invoice text:
"""
${rawText}
"""

Respond with ONLY the JSON array.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      res.status(502).json({ error: 'AI extraction failed', detail: errText });
      return;
    }

    const aiData = await aiRes.json();
    const textBlock = aiData.content.find(b => b.type === 'text');
    let items;
    try {
      const cleaned = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, '');
      items = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse AI response as JSON', raw: textBlock.text });
      return;
    }

    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unknown server error' });
  }
};
