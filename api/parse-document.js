// Vercel serverless function: POST { kind: 'invoice'|'pos', filename, data (base64 PDF) }
// Returns: { doc_date, items: [{ code, name, qty, unit_cost }] }
// Sends the PDF directly to Claude as a native document input — no separate PDF-parsing library.

const PROMPTS = {
  invoice: `You are extracting data from a wholesale grocery invoice (a shipment received from a wholesaler). The invoice PDF is attached.

Return ONLY a JSON object, nothing else, in this exact shape:
{ "doc_date": "YYYY-MM-DD or null if no date is found on the document", "items": [ { "code": string, "name": string, "qty": number, "unit_cost": number or null } ] }
"doc_date" should be the invoice's own date or shipment date as printed on the document — not today's date, not a due date. qty is the quantity shipped/received. unit_cost is the cost PER UNIT (not the line total) that this store was charged — if the invoice only shows a line total, divide it by qty to get unit_cost.
Skip totals, subtotals, taxes, headers, footers from items. If a field is missing, use null, but always try to give a numeric qty.
Respond with ONLY the JSON object.`,
  pos: `You are extracting data from a POS (point of sale) daily sales report for a grocery store. The report PDF is attached.

Return ONLY a JSON object, nothing else, in this exact shape:
{ "doc_date": "YYYY-MM-DD or null if no date is found on the document", "items": [ { "code": string, "name": string, "qty": number, "unit_cost": number or null } ] }
"doc_date" should be the date this sales report covers, as printed on the document — not today's date. qty is the quantity SOLD.
Skip totals, subtotals, taxes, payment summaries, headers, footers from items. If a field is missing, use null, but always try to give a numeric qty.
Respond with ONLY the JSON object.`
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }
  try {
    const { data, kind } = req.body;
    if (!data) { res.status(400).json({ error: 'No file data provided' }); return; }
    if (!PROMPTS[kind]) { res.status(400).json({ error: 'kind must be invoice or pos' }); return; }

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
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
            { type: 'text', text: PROMPTS[kind] }
          ]
        }]
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      res.status(502).json({ error: 'AI extraction failed', detail: errText });
      return;
    }

    const aiData = await aiRes.json();
    const textBlock = aiData.content.find(b => b.type === 'text');
    let extracted;
    try {
      const cleaned = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, '');
      extracted = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse AI response as JSON', raw: textBlock.text });
      return;
    }

    res.status(200).json({ doc_date: extracted.doc_date || null, items: extracted.items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unknown server error' });
  }
};
