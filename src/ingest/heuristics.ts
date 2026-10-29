/**
 * Injection heuristics for the sentinel (spec §9): imperative instructions,
 * embedded 0x addresses, words like "system", "remember", "always", "ignore",
 * and payee-like nouns. Detection only proposes; the policy engine protects
 * payments regardless of what detection catches.
 */

export interface HeuristicHit {
  rule: string;
  weight: number;
  match: string;
}

const RULES: { rule: string; weight: number; re: RegExp }[] = [
  { rule: 'embedded-address', weight: 0.35, re: /0x[0-9a-fA-F]{8,64}/ },
  { rule: 'system-voice', weight: 0.3, re: /\b(system(\s+(note|message|prompt|notice))?|admin(istrator)?\s+notice|assistant:|developer\s+message)\b/i },
  { rule: 'memory-directive', weight: 0.3, re: /\b(remember|memori[sz]e|store this|save this|note that|from now on|going forward|always|never forget)\b/i },
  { rule: 'override', weight: 0.35, re: /\b(ignore|disregard|override|bypass|skip)\b.{0,40}\b(previous|prior|above|instructions?|checks?|rules?|policy|limits?|verification)\b/i },
  { rule: 'payee-change', weight: 0.4, re: /\b(new|updated|changed|different|moved)\b.{0,30}\b(wallet|address|account|payee|recipient)\b/i },
  { rule: 'payee-noun', weight: 0.2, re: /\b(landlord|rent|tuition|invoice|bill|utility|allowance|vendor|payroll|salary)\b/i },
  { rule: 'urgency', weight: 0.15, re: /\b(urgent|immediately|asap|right now|final notice|act now|pre-?approved|already approved)\b/i },
  { rule: 'payment-imperative', weight: 0.25, re: /\b(send|pay|transfer|wire)\b.{0,40}\b(to|into)\b/i },
  { rule: 'cap-change', weight: 0.3, re: /\b(raise|increase|lift|remove)\b.{0,30}\b(cap|limit|ceiling)\b/i },
];

export function scoreText(text: string): { score: number; hits: HeuristicHit[] } {
  const hits: HeuristicHit[] = [];
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) hits.push({ rule: r.rule, weight: r.weight, match: m[0].slice(0, 60) });
  }
  // Independent-evidence combination: 1 − Π(1 − w).
  const score = 1 - hits.reduce((acc, h) => acc * (1 - h.weight), 1);
  return { score, hits };
}
