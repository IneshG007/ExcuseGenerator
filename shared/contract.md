# API Contract: Excuse Report Card

POST /api/excuse

Request body:
{
  "situation": string,
  "settings": {
    "escalation": 1-10,
    "audience": string (must be one of options.json audiences),
    "style": string (must be one of options.json styles),
    "truth": 0-100
  }
}

Response (200):
{
  "excuse": string (under 70 words),
  "report": {
    "overall_believability": 0-100,
    "ratings": [ { "label": string, "value": string } ],  // exactly 5; value is display-ready, e.g. "71%" or "Suspiciously High"
    "verdict": string  // one short punchy line
  }
}

Error (any non-200):
{ "error": string }

GET /api/health
Response (200): { "ok": true }

Rules: field names are exact and case-sensitive. Neither side may change this contract without telling the other.