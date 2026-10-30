/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTENU D'UNE RECETTE (J10, décision 0028) — pur.
 *
 * Une recette dit « comment on fait chez nous » : les étapes dans l'ordre, qui valide chacune, les pièces habituelles,
 * les seuils (« la DG signe au-delà de… »), la durée médiane, les pièges fréquents. Elle est TIRÉE des dossiers réels,
 * jamais écrite d'avance ; le responsable du processus la relit, la corrige, la valide.
 *
 * Ce qu'une recette NE PORTE JAMAIS : un dossier nommé, un identifiant, un montant d'un dossier, le nom d'un
 * validateur. Des RÔLES, des fréquences, des durées, des seuils de CONFIGURATION ou des seuils observés arrondis, et des
 * motifs de renvoi qui se répètent d'un dossier à l'autre (chiffres masqués). C'est ce qui la rend montrable à qui voit
 * le circuit sans lui ouvrir les dossiers d'autrui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EtapeRecette {
  cle: string;
  libelle: string;
  /** Les rôles qui valident (codes `UserRole`) — la définition du circuit d'abord, sinon ce qu'on a observé. */
  validateurs: string[];
  /** La part des dossiers acceptés qui passent par cette étape (0 à 1). */
  frequence: number;
  dureeMedianeJours: number | null;
  /** « franchie automatiquement jusqu'à 200 000 DZD », « seulement au-delà d'environ 1 M DZD (observé) »… */
  condition: string | null;
  /** Ajoutée par le responsable. */
  note?: string | null;
}

export interface SeuilRecette {
  etape: string;
  libelle: string;
  montant: number;
  /** DEFINITION = le réglage du circuit ; OBSERVE = tiré des dossiers (arrondi). */
  source: "DEFINITION" | "OBSERVE";
  texte: string;
}

/** Une étape du plan de travail tiré d'une recette (forme du plan J2 — `missions/travaux/plan.ts`). */
export interface EtapePlanRecette {
  cle: string;
  titre: string;
  type: "LECTURE" | "ANALYSE" | "LOTS" | "GESTE" | "ATTENTE" | "LIVRABLE";
  apres?: string[];
  outil?: string;
  consigne?: string;
  attente?: { evenement?: string; jours?: number; minutes?: number };
  si?: { etape: string; issue: string };
}

export interface ContenuRecette {
  titre: string;
  resume: string;
  etapes: EtapeRecette[];
  pieces: { nature: string; frequence: number }[];
  validationFinale: { libelle: string; validateurs: string[] } | null;
  seuils: SeuilRecette[];
  duree: { medianeJours: number | null; p90Jours: number | null; dossiers: number };
  pieges: { texte: string; occurrences: number }[];
  tauxRenvoi: number | null;
  tauxRefus: number | null;
  motsCles: string;
  /** Combien de dossiers réels, sur quelle période (dates ISO, jour seulement). */
  observation: { occurrences: number; du: string; au: string };
  /** Les recettes de TRAVAUX portent leur forme de plan (les étapes qui ont réussi) ; les autres en dérivent une. */
  formePlan?: EtapePlanRecette[] | null;
  /** Le mot du responsable. */
  note?: string | null;
}

/** Une empreinte courte et stable (FNV-1a 32 bits, deux passes) — sans `crypto` : le domaine reste pur. */
export function empreinte(texte: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * LA SIGNATURE D'UN CONTENU : ce qui, s'il change, mérite une nouvelle proposition. La STRUCTURE (étapes, qui valide,
 * conditions, pièces habituelles, seuils, forme de plan) et la durée médiane arrondie au jour — pas les pièges ni les
 * dates d'observation, qui bougent à chaque passage sans rien changer à la façon de faire.
 */
export function signatureContenu(c: ContenuRecette): string {
  return empreinte(JSON.stringify({
    e: c.etapes.map((e) => [e.cle, [...e.validateurs].sort(), e.condition ?? "", e.frequence >= 0.95]),
    p: c.pieces.map((p) => p.nature).sort(),
    s: c.seuils.map((s) => [s.etape, s.montant, s.source]),
    f: c.validationFinale?.libelle ?? "",
    d: c.duree.medianeJours === null ? null : Math.round(c.duree.medianeJours),
    pl: (c.formePlan ?? []).map((e) => [e.cle, e.type, e.outil ?? ""]),
  }));
}

const txt = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Relit un contenu enregistré (JSON de la base) — défensif : une colonne ancienne ou abîmée ne fait pas tomber l'écran. */
export function lireContenu(brut: unknown): ContenuRecette | null {
  const o = obj(brut);
  if (!o || !Array.isArray(o.etapes)) return null;
  return o as unknown as ContenuRecette;
}

/**
 * LA CORRECTION DU RESPONSABLE — ce qu'il peut changer : le titre, le résumé, le libellé et la note de chaque étape,
 * l'ordre et la présence des étapes, les pièces habituelles, les pièges, les mots-clés, sa note. Les CHIFFRES observés
 * (fréquences, durées, occurrences) ne se corrigent pas : ils disent ce qui s'est passé. Une correction rend la liste
 * de ses fautes plutôt que d'enregistrer un contenu bancal.
 */
export function corrigerContenu(base: ContenuRecette, brut: unknown): { ok: true; contenu: ContenuRecette } | { ok: false; fautes: string[] } {
  const o = obj(brut);
  if (!o) return { ok: false, fautes: ["Correction illisible."] };
  const fautes: string[] = [];
  const titre = txt(o.titre, 120) || base.titre;
  const resume = txt(o.resume, 1200) || base.resume;
  let etapes = base.etapes;
  if (Array.isArray(o.etapes)) {
    const parCle = new Map(base.etapes.map((e) => [e.cle, e]));
    etapes = [];
    for (const b of o.etapes) {
      const e = obj(b);
      const cle = txt(e?.cle, 60);
      const origine = parCle.get(cle);
      if (!origine) { fautes.push(`Étape « ${cle || "?"} » inconnue : une étape ne s'invente pas, elle se tire des dossiers.`); continue; }
      etapes.push({ ...origine, libelle: txt(e?.libelle, 160) || origine.libelle, note: txt(e?.note, 500) || null });
    }
    if (etapes.length === 0) fautes.push("Une recette garde au moins une étape.");
  }
  const pieces = Array.isArray(o.pieces)
    ? [...new Set(o.pieces.map((p) => txt(p, 40).toUpperCase()).filter(Boolean))].map((nature) => base.pieces.find((p) => p.nature === nature) ?? { nature, frequence: 0 })
    : base.pieces;
  const pieges = Array.isArray(o.pieges)
    ? o.pieges.map((p) => txt(p, 200)).filter(Boolean).slice(0, 8).map((texte) => base.pieges.find((p) => p.texte === texte) ?? { texte, occurrences: 0 })
    : base.pieges;
  if (fautes.length) return { ok: false, fautes };
  return {
    ok: true,
    contenu: {
      ...base, titre, resume, etapes, pieces, pieges,
      motsCles: typeof o.motsCles === "string" ? txt(o.motsCles, 600) : base.motsCles,
      note: typeof o.note === "string" ? txt(o.note, 1000) || null : base.note ?? null,
    },
  };
}

/** « 4,5 j », « 12 j », « < 1 j ». */
export function jours(d: number | null | undefined): string {
  if (d === null || d === undefined || Number.isNaN(d)) return "—";
  if (d < 1) return "< 1 j";
  if (d >= 10) return `${Math.round(d)} j`;
  return `${(Math.round(d * 10) / 10).toString().replace(".", ",")} j`;
}

/** « 1 200 000 DZD », « 1,5 M DZD ». */
export function montantLisible(m: number): string {
  if (m >= 1_000_000 && m % 100_000 === 0) return `${(m / 1_000_000).toString().replace(".", ",")} M DZD`;
  return `${Math.round(m).toLocaleString("fr-FR").replace(/ | /g, " ")} DZD`;
}

export const pourcent = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);
