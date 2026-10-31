/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UN COURRIER ENTRANT (lot K6, décision 0036) — côté socle, zéro import.
 *
 * Le webhook `/api/mail/inbound` (signature vérifiée AVANT) remet la charge du fournisseur ; on en tire les
 * DESTINATAIRES (pour reconnaître l'adresse de l'assistant) et les PIÈCES quand le fournisseur en envoie le contenu :
 *   • Postmark : `Attachments[{ Name, Content (base64), ContentType, ContentLength }]` ;
 *   • forme générique (Resend, Brevo, passerelles) : `attachments[{ filename|name, content (base64), content_type }]`.
 * Une pièce dont le contenu n'est pas dans la charge est RENDUE quand même (sans octets) : la réception le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PieceDeCourrier {
  nom: string;
  mime: string | null;
  /** Nul : le fournisseur n'a pas transmis le contenu dans le webhook. */
  octets: Buffer | null;
  taille: number | null;
}

const objet = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texte = (v: unknown): string => (typeof v === "string" ? v : "");
const ADRESSE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Tous les destinataires (À, Cc, transferts), en minuscules et sans doublon. */
export function destinatairesDuCourrier(charge: unknown): string[] {
  const racine = objet(charge);
  const p = Object.keys(objet(racine.data)).length ? objet(racine.data) : racine;
  const brut = JSON.stringify([p.To, p.ToFull, p.Cc, p.CcFull, p.to, p.cc, p.OriginalRecipient, p.recipients, p.envelope].filter((x) => x !== undefined));
  return [...new Set((brut.match(ADRESSE) ?? []).map((a) => a.toLowerCase()))];
}

/** Les en-têtes utiles à la détection d'un expéditeur automatique (Postmark : `Headers[{Name, Value}]`). */
export function entetesDuCourrier(charge: unknown): Record<string, string> {
  const racine = objet(charge);
  const p = Object.keys(objet(racine.data)).length ? objet(racine.data) : racine;
  const out: Record<string, string> = {};
  for (const h of tableau(p.Headers ?? p.headers)) {
    const o = objet(h);
    const nom = texte(o.Name ?? o.name).toLowerCase();
    if (nom) out[nom] = texte(o.Value ?? o.value);
  }
  const brut = objet(p.headers);
  for (const [k, v] of Object.entries(brut)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

function base64(v: string): Buffer | null {
  const s = v.replace(/\s+/g, "");
  if (!s || /[^A-Za-z0-9+/=_-]/.test(s)) return null;
  try {
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

export function piecesDuCourrier(charge: unknown, maxPieces = 10): PieceDeCourrier[] {
  const racine = objet(charge);
  const p = Object.keys(objet(racine.data)).length ? objet(racine.data) : racine;
  const out: PieceDeCourrier[] = [];
  for (const a of [...tableau(p.Attachments), ...tableau(p.attachments)].slice(0, maxPieces)) {
    const o = objet(a);
    const nom = (texte(o.Name) || texte(o.filename) || texte(o.name) || "piece-jointe").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
    const mime = texte(o.ContentType) || texte(o.content_type) || texte(o.contentType) || null;
    const octets = base64(texte(o.Content) || texte(o.content));
    const taille = Number(o.ContentLength ?? o.size ?? o.content_length);
    out.push({ nom, mime, octets, taille: octets ? octets.length : Number.isFinite(taille) ? taille : null });
  }
  return out;
}
