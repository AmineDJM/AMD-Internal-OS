/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GABARIT DES MAILS DE L'ASSISTANT (lot P1, décision 0047) — règles PURES, zéro import.
 *
 * Direction, 02/11 : « le mail, quand il est fait, il doit faire de BEAUX mails ». Le modèle ne rédige JAMAIS du HTML :
 * il rend un CONTENU STRUCTURÉ (salutation, paragraphes, liste, tableau, clôture) que ce gabarit met en page côté
 * serveur — HTML responsive « à l'ancienne » (tables, styles en ligne, 600 px, lisible sur iPhone, Gmail, Outlook), aux
 * couleurs de la société d'envoi (registre de marque), avec la SIGNATURE de la personne qui envoie, et sa version TEXTE
 * jointe (multipart). Tout texte est échappé ; seul `**gras**` est permis (une échéance, une date).
 * L'aperçu de la carte est CE rendu — ce que la personne voit est ce qui part.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ContenuMail {
  salutation: string;
  paragraphes: string[];
  /** Une liste à puces (étapes, points) — facultative. */
  liste?: string[];
  /** Un tableau propre (dates, tâches, responsables) — facultatif. */
  tableau?: { colonnes: string[]; lignes: string[][] };
  /** Paragraphes APRÈS la liste ou le tableau (rappel, prochaine étape). */
  apres?: string[];
  cloture: string;
}

export interface SignatureMail { nom: string; fonction: string | null; societe: string; telephone: string | null; email: string | null }

export interface CharteMail {
  societe: string;
  /** Hexadécimal sans dièse. */
  accent: string;
  texteSurAccent: string;
  police: string;
  coordonnees: string[];
  mentions: string[];
}

export const BORNES_MAIL = { paragraphes: 8, liste: 15, colonnes: 6, lignes: 30, cellule: 200, texte: 1_500 } as const;

const chaine = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const chaines = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => chaine(x, max)).filter(Boolean).slice(0, n) : []);

/** LIRE le contenu rendu par le modèle — borné, nettoyé ; ce qui manque est NOMMÉ (jamais inventé). */
export function lireContenuMail(brut: unknown): { ok: true; contenu: ContenuMail } | { ok: false; manque: string[] } {
  const o = brut && typeof brut === "object" && !Array.isArray(brut) ? (brut as Record<string, unknown>) : {};
  const salutation = chaine(o.salutation, 120);
  const paragraphes = chaines(o.paragraphes, BORNES_MAIL.paragraphes, BORNES_MAIL.texte);
  const liste = chaines(o.liste, BORNES_MAIL.liste, 400);
  const apres = chaines(o.apres, 4, BORNES_MAIL.texte);
  const cloture = chaine(o.cloture, 200);
  const t = o.tableau && typeof o.tableau === "object" ? (o.tableau as Record<string, unknown>) : null;
  const colonnes = t ? chaines(t.colonnes, BORNES_MAIL.colonnes, 60) : [];
  const lignes = t && Array.isArray(t.lignes)
    ? t.lignes.slice(0, BORNES_MAIL.lignes).map((l) => (Array.isArray(l) ? l.slice(0, colonnes.length).map((c) => chaine(String(c ?? ""), BORNES_MAIL.cellule)) : [])).filter((l) => l.some(Boolean))
    : [];
  const manque = [...(paragraphes.length || liste.length || lignes.length ? [] : ["le corps du mail (au moins un paragraphe)"])];
  if (manque.length) return { ok: false, manque };
  return {
    ok: true,
    contenu: {
      salutation: salutation || "Bonjour,",
      paragraphes, cloture: cloture || "Bien cordialement,",
      ...(liste.length ? { liste } : {}), ...(apres.length ? { apres } : {}),
      ...(colonnes.length && lignes.length ? { tableau: { colonnes, lignes: lignes.map((l) => colonnes.map((_, i) => l[i] ?? "")) } } : {}),
    },
  };
}

const echapper = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Le seul balisage permis : `**gras**` (une échéance), rendu après échappement. */
const enLigne = (t: string) => echapper(t).replace(/\*\*([^*]{1,200})\*\*/g, "<strong>$1</strong>");
const sansGras = (t: string) => t.replace(/\*\*([^*]{1,200})\*\*/g, "$1");
const hex = (h: string, defaut: string) => (/^[0-9A-Fa-f]{6}$/.test(h) ? `#${h.toUpperCase()}` : defaut);

/** LE RENDU HTML — tables et styles en ligne (Outlook), 600 px, fluide sous 600 px (iPhone). */
export function rendreMailHtml(c: ContenuMail, s: SignatureMail, ch: CharteMail, objet: string): string {
  const accent = hex(ch.accent, "#087084");
  const surAccent = hex(ch.texteSurAccent, "#FFFFFF");
  const police = `${echapper(ch.police)}, Calibri, Arial, Helvetica, sans-serif`;
  const p = (t: string) => `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#1F2933;">${enLigne(t)}</p>`;
  const liste = c.liste?.length
    ? `<ul style="margin:0 0 16px 0;padding:0 0 0 20px;">${c.liste.map((x) => `<li style="margin:0 0 6px 0;font-size:15px;line-height:1.5;color:#1F2933;">${enLigne(x)}</li>`).join("")}</ul>`
    : "";
  const tableau = c.tableau
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 18px 0;font-size:14px;">
<tr>${c.tableau.colonnes.map((col) => `<th align="left" style="background:${accent};color:${surAccent};padding:9px 10px;font-weight:600;border:1px solid ${accent};">${echapper(col)}</th>`).join("")}</tr>
${c.tableau.lignes.map((l, i) => `<tr>${l.map((cell) => `<td style="padding:8px 10px;border:1px solid #D9E2EC;color:#1F2933;background:${i % 2 ? "#F5F8FA" : "#FFFFFF"};vertical-align:top;">${enLigne(cell)}</td>`).join("")}</tr>`).join("\n")}
</table>`
    : "";
  const signature = [
    `<strong style="color:#102A43;">${echapper(s.nom)}</strong>`,
    s.fonction ? echapper(s.fonction) : null,
    `<span style="color:${accent};font-weight:600;">${echapper(s.societe)}</span>`,
    [s.telephone, s.email].filter(Boolean).map((x) => echapper(x!)).join(" · ") || null,
  ].filter(Boolean).join("<br>");
  const pied = [...ch.coordonnees, ...ch.mentions].filter(Boolean).map(echapper).join("<br>");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${echapper(objet)}</title>
<style>@media only screen and (max-width:620px){.conteneur{width:100%!important}.marge{padding:20px 16px!important}}</style></head>
<body style="margin:0;padding:0;background:#EEF2F5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F5;"><tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="conteneur" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:${police};">
<tr><td style="background:${accent};padding:18px 28px;"><span style="font-size:18px;font-weight:700;letter-spacing:.2px;color:${surAccent};">${echapper(ch.societe)}</span></td></tr>
<tr><td class="marge" style="padding:28px 28px 8px 28px;">
${p(c.salutation)}
${c.paragraphes.map(p).join("\n")}
${liste}
${tableau}
${(c.apres ?? []).map(p).join("\n")}
${p(c.cloture)}
<p style="margin:18px 0 0 0;font-size:14px;line-height:1.5;color:#334E68;border-top:2px solid ${accent};padding-top:12px;">${signature}</p>
</td></tr>
${pied ? `<tr><td style="padding:14px 28px 22px 28px;font-size:11.5px;line-height:1.5;color:#829AB1;">${pied}</td></tr>` : ""}
</table></td></tr></table></body></html>`;
}

/** LA VERSION TEXTE (la partie text/plain du multipart) — la même lecture, sans mise en page. */
export function rendreMailTexte(c: ContenuMail, s: SignatureMail, ch: CharteMail): string {
  const blocs: string[] = [sansGras(c.salutation), ...c.paragraphes.map(sansGras)];
  if (c.liste?.length) blocs.push(c.liste.map((x) => `• ${sansGras(x)}`).join("\n"));
  if (c.tableau) {
    // Pas de tableau « en pipes » (illisible dans une boîte texte, relevé par le banc d'audit) : une ligne par rangée.
    const cols = c.tableau.colonnes;
    blocs.push(c.tableau.lignes.map((l) => `• ${l.map((v, i) => (i === 0 ? sansGras(v) : `${cols[i]} : ${sansGras(v)}`)).join(" — ")}`).join("\n"));
  }
  blocs.push(...(c.apres ?? []).map(sansGras), sansGras(c.cloture));
  blocs.push(["--", s.nom, s.fonction, s.societe, [s.telephone, s.email].filter(Boolean).join(" · ") || null].filter(Boolean).join("\n"));
  const pied = [...ch.coordonnees, ...ch.mentions].filter(Boolean);
  if (pied.length) blocs.push(pied.join("\n"));
  return blocs.join("\n\n");
}

/** Le prénom d'un nom complet — pour une salutation par défaut (« Bonjour Redouane, »). */
export const prenomDe = (nom: string): string => nom.trim().split(/\s+/)[0] ?? nom;
