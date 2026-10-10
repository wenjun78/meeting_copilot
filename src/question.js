'use strict';
// Decides whether something the other side said is asking for a response.

const LEAD = /^(?:so|and|ok(?:ay)?|right|well|now|also|but|alright|great|cool|then|um+|uh+|yeah|yes|sure|thanks|thank you|[,.\s])*\s*(what|what's|whats|why|how|how's|when|where|which|who|whose|whom|can|could|would|will|should|shall|do|does|did|is|are|was|were|have|has|had|may|might|any|anything|am)\b/i;
const REQUEST = /\b(tell (?:me|us)|walk (?:me|us) through|talk (?:me |us )?through|talk (?:to (?:me|us) )?about|take (?:me|us) through|give (?:me|us) (?:an?|some|your)|share (?:your|an? example|some)|help (?:me|us) understand|i(?:'d| would) (?:like|love) to (?:know|hear|understand)|i(?:'m| am| was) (?:curious|wondering)|curious (?:about|how|what|why)|wondering (?:if|how|what|why|whether)|your (?:thoughts|view|opinion|take) on|could you|can you|would you|do you (?:know|have|think)|have you (?:ever|worked|used)|are you (?:able|familiar|comfortable))\b|(?:^|[.!?,]\s+|\bplease\s+|\byou\s+)(?:explain|describe|elaborate)\b/i;
const NUDGE = /\b(what about|how about|any (?:questions|concerns|thoughts|updates?)|thoughts\b|let(?:'s| us) (?:talk about|discuss|hear))/i;
const SMALLTALK = /^(?:(?:ok(?:ay)?|so|hi|hello|hey|sorry|alright)[,.\s]+)*(?:can (?:you|everyone|everybody|you all|you guys) (?:hear|see) (?:me|us|my screen|this|that|it)\b[^?]{0,20}|(?:is|are) (?:everyone|everybody|we|you) (?:here|ready|there)|(?:are )?you there|hello|hi|(?:how are you|how(?:'s| is) it going|how(?:'s| is) everyone)(?: doing)?(?: today| all| guys)*)[\s.!?]*$/i;
const CJK_Q = /[？吗嗎呢]|什么|什麼|怎么|怎麼|为什么|為什麼|如何|多少|哪个|哪個|哪些|能不能|可不可以|是不是|有没有|有沒有|请问|請問|介绍一下|介紹一下|说说|說說|讲讲|講講/;
const MALAY_Q = /\b(apa|apakah|bagaimana|macam mana|kenapa|mengapa|bila|di mana|siapa|berapa|boleh(?:kah)?|adakah|ceritakan|terangkan|jelaskan)\b/i;

// -> { ask: boolean, score: 0..1 }
function detectQuestion(text) {
  const all = String(text || '').trim().split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  // "Can you hear me?" and friends are dropped before scoring, wherever they appear.
  const sentences = all.filter(s => !SMALLTALK.test(s.trim()));
  const t = sentences.join(' ');
  if (!t) return { ask: false, score: 0 };
  const words = t.split(/\s+/).length;
  const last = sentences.slice(-2).join(' ');
  let score = 0;
  if (/[?？]\s*$/.test(t)) score += 0.7;
  else if (/[?？]/.test(last)) score += 0.6;
  else if (/[?？]/.test(t)) score += 0.35;
  if (sentences.some(s => LEAD.test(s))) score += 0.35;
  if (REQUEST.test(t)) score += 0.65;
  if (NUDGE.test(t)) score += 0.45;
  if (CJK_Q.test(t)) score += 0.6;
  if (MALAY_Q.test(t)) score += 0.3;
  if (words < 3 && !CJK_Q.test(t)) score -= 0.4;   // "Right?" "Okay?"
  score = Math.max(0, Math.min(1, score));
  return { ask: score >= 0.6, score };
}

module.exports = { detectQuestion };
