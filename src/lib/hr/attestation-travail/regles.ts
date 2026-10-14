/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATTESTATION DE TRAVAIL — LES RÈGLES (Direction, 10/2026).
 *
 * « En cas de demande d'attestation de travail, dans les demandes RH, ça doit proposer la génération aux RH comme les
 * ordres de missions. Luna doit utiliser le contrat de travail de la personne. Le RH écrit le signataire à la fin en le
 * sélectionnant. (Modification manuelle possible) »
 *
 * Ce module dit COMMENT on remplit le document : la civilité et ses accords (« né » / « née », « employé » / « employée »),
 * les dates à la française (« 24 janvier 2004 », « 01/07/2025 »), la phrase de naissance, ce qui manque pour générer, et
 * surtout LA FUSION DU PRÉREMPLISSAGE : pour chaque champ, la fiche RH d'abord (la source de vérité), puis ce qui a été lu
 * dans le CONTRAT DE TRAVAIL (par Luna, ou par la lecture déterministe quand l'IA est coupée), puis la société, puis un
 * défaut — chaque valeur garde sa PROVENANCE, pour que l'écran dise « lu dans le contrat » et que les RH relisent.
 *
 * PUR, SANS AUCUN IMPORT : le formulaire (navigateur) et le serveur lisent la même règle (CLAUDE.md, frontière client).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Civilite = "Monsieur" | "Madame";
export const CIVILITES: readonly Civilite[] = ["Monsieur", "Madame"];

/** Ce que porte le document. Les dates sont en `AAAA-MM-JJ`. */
export interface ChampsAttestation {
  /** « 041/DG/2026 » — vide hors registre : la ligne de référence ne s'imprime pas. */
  reference: string;
  civilite: Civilite | "";
  /** Tel qu'imprimé — « DJOUAMAI Mohamed Amine ». */
  salarie: string;
  dateNaissance: string;
  lieuNaissance: string;
  /** La dénomination du corps du texte — « SARL ADVENTUM PHARMA ». */
  societe: string;
  /** Celle qui suit « Pour » — « ADVENTUM PHARMA ». */
  societeSignature: string;
  poste: string;
  dateEmbauche: string;
  signataireCivilite: Civilite | "";
  signataire: string;
  signataireFonction: string;
  lieuSignature: string;
  dateSignature: string;
}

export const CHAMPS_ATTESTATION = [
  "reference", "civilite", "salarie", "dateNaissance", "lieuNaissance", "societe", "societeSignature", "poste", "dateEmbauche",
  "signataireCivilite", "signataire", "signataireFonction", "lieuSignature", "dateSignature",
] as const satisfies readonly (keyof ChampsAttestation)[];

/** D'où vient une valeur préremplie — l'écran le dit à côté du champ. */
export type ProvenanceChamp = "fiche" | "contrat" | "luna" | "societe" | "defaut" | "vide";

export const LIBELLE_PROVENANCE: Record<ProvenanceChamp, string> = {
  fiche: "fiche RH",
  contrat: "lu dans le contrat",
  luna: "lu dans le contrat (Luna)",
  societe: "identité légale de la société",
  defaut: "par défaut",
  vide: "à compléter",
};

/** Les champs que le CONTRAT peut fournir (Luna ou lecture déterministe). */
export interface LuDansLeContrat {
  civilite?: Civilite;
  dateNaissance?: string;
  lieuNaissance?: string;
  poste?: string;
  dateEmbauche?: string;
}
export const CHAMPS_DU_CONTRAT = ["civilite", "dateNaissance", "lieuNaissance", "poste", "dateEmbauche"] as const;

// ─────────────────────────── Les dates ───────────────────────────

export const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Une date `AAAA-MM-JJ` qui existe au calendrier. */
export function estDateIso(s: string | null | undefined): s is string {
  const m = ISO.exec((s ?? "").trim());
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** `2004-01-24` → « 24 janvier 2004 » ; le jour sur deux chiffres, comme le modèle (« 03 juin 2026 »). Autre chose : rendu tel quel. */
export function dateLongueFr(iso: string): string {
  const s = (iso ?? "").trim();
  if (!estDateIso(s)) return s;
  const [a, m, j] = s.split("-");
  return `${j} ${MOIS_FR[Number(m) - 1]} ${a}`;
}

/** `2025-07-01` → « 01/07/2025 ». */
export function dateCourteFr(iso: string): string {
  const s = (iso ?? "").trim();
  if (!estDateIso(s)) return s;
  const [a, m, j] = s.split("-");
  return `${j}/${m}/${a}`;
}

/** Une `Date` (ou une chaîne ISO complète) → `AAAA-MM-JJ` À ALGER (UTC+1, sans heure d'été). */
export function isoAlger(d: Date | string | null | undefined): string {
  if (d == null || d === "") return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return new Date(date.getTime() + 3_600_000).toISOString().slice(0, 10);
  }
}

/**
 * Une date LUE dans un texte → `AAAA-MM-JJ` : « 24/01/2004 », « 24-01-2004 », « 24.01.2004 », « 24 janvier 2004 »,
 * « 1er juillet 2025 », ou déjà « 2004-01-24 ». `null` si ce n'en est pas une.
 */
export function dateDepuisTexte(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLowerCase();
  if (!t) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const verifie = (a: number, m: number, j: number) => {
    const iso = `${a}-${pad(m)}-${pad(j)}`;
    return estDateIso(iso) ? iso : null;
  };
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return verifie(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})/.exec(t);
  if (m) return verifie(Number(m[3]), Number(m[2]), Number(m[1]));
  const sansAccent = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  m = /(\d{1,2})\s*(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})/.exec(sansAccent);
  if (m) {
    const mois = MOIS_FR.map((x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "")).indexOf(m[2] as never) + 1;
    return mois > 0 ? verifie(Number(m[3]), mois, Number(m[1])) : null;
  }
  return null;
}

// ─────────────────────────── La civilité ───────────────────────────

/** Une civilité saisie ou lue, ramenée à « Monsieur » / « Madame » — `null` si elle n'en dit rien. */
export function civiliteDe(s: string | null | undefined): Civilite | null {
  const t = (s ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\.$/, "");
  if (!t) return null;
  if (["monsieur", "m", "mr", "homme", "masculin", "h", "male"].includes(t)) return "Monsieur";
  if (["madame", "mme", "mademoiselle", "mlle", "femme", "feminin", "f", "female"].includes(t)) return "Madame";
  return null;
}

/** Les accords du texte selon la civilité — le masculin quand elle n'est pas dite (le modèle de la Direction). */
export function accords(c: Civilite | "" | null | undefined): { ne: string; employe: string; interesse: string; soussigne: string } {
  const f = c === "Madame";
  return {
    ne: f ? "née" : "né",
    employe: f ? "employée" : "employé",
    interesse: f ? "l'intéressée" : "l'intéressé",
    soussigne: f ? "soussignée" : "soussigné",
  };
}

/** « , né le 24 janvier 2004 à HAMMAMET Alger » — ce qui manque ne s'imprime pas ; rien du tout sans date ni lieu. */
export function phraseNaissance(c: Pick<ChampsAttestation, "civilite" | "dateNaissance" | "lieuNaissance">): string {
  const date = c.dateNaissance.trim();
  const lieu = c.lieuNaissance.trim();
  if (!date && !lieu) return "";
  const { ne } = accords(c.civilite);
  return `, ${ne}${date ? ` le ${dateLongueFr(date)}` : ""}${lieu ? ` à ${lieu}` : ""}`;
}

/**
 * UN CHAMP PERSONNALISÉ DE LA FICHE (Administration › champs personnalisés, `Employee.custom`) dont la CLÉ répond au motif —
 * « lieuNaissance », « lieu_de_naissance », « civilite »… La fiche n'a pas de colonne pour le lieu de naissance ni la
 * civilité : quand l'administration les a ajoutés, on les lit.
 */
export function champPersonnalise(custom: unknown, motif: RegExp): string | null {
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  for (const [cle, v] of Object.entries(custom as Record<string, unknown>)) {
    const k = cle.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
    if (motif.test(k) && typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
export const MOTIF_LIEU_NAISSANCE = /^(lieudenaissance|lieunaissance|birthplace|placeofbirth)$/;
export const MOTIF_CIVILITE = /^(civilite|sexe|genre|gender)$/;

// ─────────────────────────── La société ───────────────────────────

const FORMES = /^(sarl|spa|eurl|snc|sas|sa|scs|ei|eurl\.?)$/i;

/** « SARL ADVENTUM PHARMA » (corps du texte) et « ADVENTUM PHARMA » (après « Pour ») depuis l'identité légale. */
export function societeImprimee(i: { legalName?: string | null; legalForm?: string | null; name?: string | null }): { societe: string; societeSignature: string } {
  const nom = (i.legalName ?? "").trim() || (i.name ?? "").trim();
  if (!nom) return { societe: "", societeSignature: "" };
  const forme = (i.legalForm ?? "").trim();
  const mots = nom.split(/\s+/);
  const sansForme = mots.filter((m, k) => !(FORMES.test(m) && (k === 0 || k === mots.length - 1))).join(" ") || nom;
  const dejaForme = mots.some((m) => FORMES.test(m)) || (forme && nom.toLowerCase().includes(forme.toLowerCase()));
  return {
    societe: forme && !dejaForme ? `${forme.toUpperCase()} ${nom}` : nom,
    societeSignature: sansForme,
  };
}

// ─────────────────────────── La lecture DÉTERMINISTE du contrat ───────────────────────────

const nettoyerFragment = (s: string): string => s.replace(/\s+/g, " ").replace(/^[\s:–—-]+|[\s,;.:–—-]+$/g, "").trim();
/** Un lieu s'arrête où la phrase passe à autre chose (« … demeurant à », « … de nationalité »). */
const lieuSeul = (s: string): string =>
  nettoyerFragment(nettoyerFragment(s).split(/\s+(?:et\s+)?(?:demeurant|domicili|de\s+nationalit|titulaire|ci-apr|n°|nin\b)/i)[0] ?? "");
const DATE_TEXTE = String.raw`(\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{4}|\d{1,2}\s*(?:er)?\s+[a-zéû]+\s+\d{4}|\d{4}-\d{2}-\d{2})`;

/**
 * LA LECTURE SANS IA — ce qu'un contrat de travail algérien dit presque toujours de la même façon : « né(e) le … à … »,
 * « Date / Lieu de naissance : … », « en qualité de … », « Poste : … », « à compter du … », « Date d'effet : … ».
 * Elle ne devine rien : une forme non reconnue laisse le champ vide, et les RH le complètent.
 */
export function lireContratDeterministe(texte: string | null | undefined): LuDansLeContrat {
  const t = (texte ?? "").replace(/\r/g, "").replace(/[\u00a0\u202f]/g, " ");
  if (!t.trim()) return {};
  const lu: LuDansLeContrat = {};

  const naissance = new RegExp(String.raw`\bn[ée](e?)\s*\(?e?\)?\s+le\s*:?\s*${DATE_TEXTE}(?:\s*,?\s*à\s+([^\n,;]+))?`, "i").exec(t);
  if (naissance) {
    const d = dateDepuisTexte(naissance[2]);
    if (d) lu.dateNaissance = d;
    if (naissance[3]) { const l = lieuSeul(naissance[3]); if (l && l.length <= 80) lu.lieuNaissance = l; }
    if (/n[ée]e\s+le/i.test(naissance[0])) lu.civilite = "Madame";
    else if (/n[ée]\s+le/i.test(naissance[0])) lu.civilite = "Monsieur";
  }
  if (!lu.dateNaissance) {
    const m = new RegExp(String.raw`date\s+de\s+naissance\s*:?\s*${DATE_TEXTE}`, "i").exec(t);
    const d = m ? dateDepuisTexte(m[1]) : null;
    if (d) lu.dateNaissance = d;
  }
  if (!lu.lieuNaissance) {
    const m = /lieu\s+de\s+naissance\s*:?\s*([^\n;]+)/i.exec(t);
    if (m) { const l = lieuSeul(m[1]); if (l && l.length <= 80) lu.lieuNaissance = l; }
  }
  const poste = posteDuContrat(t);
  if (poste) lu.poste = poste;
  const embauche = new RegExp(String.raw`(?:[àa]\s+compter\s+du|[àa]\s+partir\s+du|prend\s+effet\s+le|date\s+d['’]effet|date\s+d['’]embauche|date\s+de\s+recrutement|date\s+d['’]entr[ée]e(?:\s+en\s+fonction)?)\s*:?\s*${DATE_TEXTE}`, "i").exec(t);
  if (embauche) { const d = dateDepuisTexte(embauche[1]); if (d) lu.dateEmbauche = d; }
  return lu;
}

/**
 * Le poste : un libellé (« Poste : », « Fonction : », « Emploi : ») d'abord ; à défaut, « en qualité de … » — sauf celui
 * de l'EMPLOYEUR (« représentée par M. X en qualité de gérant »), qui ouvre presque tout contrat.
 */
function posteDuContrat(t: string): string | null {
  const ok = (p: string | undefined) => {
    const v = nettoyerFragment(p ?? "");
    return v && v.length <= 80 && !/^(employeur|g[ée]rant|repr[ée]sentant)/i.test(v) ? v : null;
  };
  const libelle = /(?:poste\s+(?:occup[ée]\s*)?|fonction|emploi|intitul[ée]\s+du\s+poste)\s*:\s*([^\n,;.()]+)/i.exec(t);
  if (libelle && ok(libelle[1])) return ok(libelle[1]);
  const dernier = (s: string, re: RegExp): number => {
    let pos = -1;
    for (const x of s.matchAll(re)) pos = x.index ?? pos;
    return pos;
  };
  for (const m of t.matchAll(/en\s+qualit[ée]\s+d(?:e\s+|['’]\s*)([^\n,;.()]+)/gi)) {
    // L'employeur est nommé plus près que le salarié : c'est SA qualité, pas le poste.
    const avant = t.slice(Math.max(0, (m.index ?? 0) - 160), m.index ?? 0);
    const employeur = dernier(avant, /repr[ée]sent|employeur|g[ée]rant/gi);
    const salarie = dernier(avant, /autre\s+part|recrut|salari|engag|embauch|\bet\s+(?:m\.|mr|mme|madame|monsieur|mademoiselle)\b/gi);
    if (employeur > salarie) continue;
    const v = ok(m[1]);
    if (v) return v;
  }
  return null;
}

/**
 * LA RÉPONSE DE LUNA, RELUE STRICTEMENT : chaque clé est vérifiée (une date doit exister, un texte rester court) ; ce qui
 * ne passe pas est ignoré, jamais « corrigé ». Luna ne fournit que ce qu'elle a lu — elle n'écrase jamais la fiche RH.
 */
export function lireReponseLuna(data: unknown): LuDansLeContrat {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const o = data as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim() : "");
  const lu: LuDansLeContrat = {};
  const civ = civiliteDe(s("civilite"));
  if (civ) lu.civilite = civ;
  for (const k of ["dateNaissance", "dateEmbauche"] as const) {
    const v = s(k);
    const d = estDateIso(v) ? v : dateDepuisTexte(v);
    if (d) lu[k] = d;
  }
  for (const k of ["lieuNaissance", "poste"] as const) {
    const v = s(k);
    if (v && v.length <= 80) lu[k] = v;
  }
  return lu;
}

// ─────────────────────────── La fusion du préremplissage ───────────────────────────

export interface SourcesPrefill {
  /** La fiche RH — la source de vérité. */
  fiche: Partial<ChampsAttestation>;
  /** Ce que le contrat a dit, et qui l'a lu. */
  contrat: LuDansLeContrat;
  /** Les champs du contrat que LUNA a lus (les autres : la lecture déterministe). */
  parLuna?: readonly string[];
  /** L'identité légale de la société (dénomination, représentant légal). */
  societe: Partial<ChampsAttestation>;
  /** Les défauts (date du jour à Alger, « Alger », référence prévue…). */
  defauts: Partial<ChampsAttestation>;
}

export interface Prefill {
  champs: ChampsAttestation;
  provenance: Record<keyof ChampsAttestation, ProvenanceChamp>;
}

const plein = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** POUR CHAQUE CHAMP : fiche → contrat → société → défaut. La provenance suit la valeur retenue. */
export function fusionnerPrefill(s: SourcesPrefill): Prefill {
  const champs = {} as Record<keyof ChampsAttestation, string>;
  const provenance = {} as Record<keyof ChampsAttestation, ProvenanceChamp>;
  const contrat = s.contrat as Partial<Record<keyof ChampsAttestation, string>>;
  for (const k of CHAMPS_ATTESTATION) {
    const ordre: [ProvenanceChamp, unknown][] = [
      ["fiche", s.fiche[k]],
      [s.parLuna?.includes(k) ? "luna" : "contrat", (CHAMPS_DU_CONTRAT as readonly string[]).includes(k) ? contrat[k] : undefined],
      ["societe", s.societe[k]],
      ["defaut", s.defauts[k]],
    ];
    const trouve = ordre.find(([, v]) => plein(v));
    champs[k] = trouve ? (trouve[1] as string).trim() : "";
    provenance[k] = trouve ? trouve[0] : "vide";
  }
  const c = champs as unknown as ChampsAttestation;
  c.civilite = civiliteDe(c.civilite) ?? "";
  c.signataireCivilite = civiliteDe(c.signataireCivilite) ?? "";
  return { champs: c, provenance };
}

/** Les champs du contrat qui MANQUENT à la fiche — ce que Luna (ou la lecture déterministe) doit chercher. */
export function champsAChercherDansLeContrat(fiche: Partial<ChampsAttestation>): (typeof CHAMPS_DU_CONTRAT)[number][] {
  return CHAMPS_DU_CONTRAT.filter((k) => !plein(fiche[k]));
}

// ─────────────────────────── Avant de générer ───────────────────────────

/** Ce qu'il manque pour générer — `null` si tout y est. La référence est l'affaire du serveur (registre). */
export function refusAttestation(c: ChampsAttestation): string | null {
  const manque: string[] = [];
  if (!c.civilite) manque.push("la civilité du salarié");
  if (!c.salarie.trim()) manque.push("le nom du salarié");
  if (c.dateNaissance.trim() && !estDateIso(c.dateNaissance)) manque.push("une date de naissance valide");
  if (!c.societe.trim()) manque.push("la société");
  if (!c.poste.trim()) manque.push("le poste");
  if (!estDateIso(c.dateEmbauche)) manque.push("la date d'embauche");
  if (!c.signataire.trim()) manque.push("le signataire");
  if (!c.signataireFonction.trim()) manque.push("la fonction du signataire");
  if (!c.lieuSignature.trim()) manque.push("le lieu (« Fait à »)");
  if (!estDateIso(c.dateSignature)) manque.push("la date (« Fait à … le »)");
  return manque.length > 0 ? `Pour générer l'attestation, indiquez ${manque.join(", ")}.` : null;
}

/** Le nom du fichier : « Attestation de travail 041-DG-2026 — DJOUAMAI Mohamed Amine (v2) ». */
export function nomAttestation(reference: string, salarie: string, version = 1): string {
  const ref = reference.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const qui = salarie.replace(/[\\/:*?"<>|]+/g, "").trim();
  return `Attestation de travail${ref ? ` ${ref}` : ""}${qui ? ` — ${qui}` : ""}${version > 1 ? ` (v${version})` : ""}`;
}

/** Les valeurs des marqueurs du modèle — tout ce qui s'imprime, calculé ici, testé ici. */
export function valeursDuModele(c: ChampsAttestation): Record<string, string> {
  const a = accords(c.civilite);
  const s = accords(c.signataireCivilite);
  return {
    REFERENCE_LIGNE: c.reference.trim() ? `Réf. : ${c.reference.trim()}` : "",
    SOUSSIGNE: s.soussigne,
    SIGNATAIRE_CIVILITE: c.signataireCivilite ? `${c.signataireCivilite} ` : "",
    SIGNATAIRE: c.signataire.trim(),
    SIGNATAIRE_FONCTION: c.signataireFonction.trim(),
    CIVILITE: c.civilite ? `${c.civilite} ` : "",
    SALARIE: c.salarie.trim(),
    NAISSANCE: phraseNaissance(c),
    EMPLOYE: a.employe,
    SOCIETE: c.societe.trim(),
    POSTE: c.poste.trim(),
    DATE_EMBAUCHE: dateCourteFr(c.dateEmbauche),
    INTERESSE: a.interesse,
    LIEU_SIGNATURE: c.lieuSignature.trim(),
    DATE_SIGNATURE: dateLongueFr(c.dateSignature),
    SOCIETE_SIGNATURE: (c.societeSignature.trim() || c.societe.trim()),
  };
}
