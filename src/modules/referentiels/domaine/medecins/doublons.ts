/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES MÉDECINS EN DOUBLE — la détection, PURE (lot T2, décision 0061).
 *
 * Décision de la Direction (03/11/2026) : « Oui, on fusionne les fiches médecins en double, mais c'est à moi de le faire,
 * pas à toi. Toi, tu me proposes juste tout. Évidemment, tu proposes ça qu'à l'administrateur. Et après, moi, j'ai juste
 * à cliquer une croix ou une validation et ça valide. »
 *
 * Deux fiches sont PROPOSÉES comme doublon quand leur nom désigne la même personne (mêmes mots, ordre, casse, accents et
 * titres ignorés — « Dr BENSALEM Karima » ≡ « Karima Bensalem ») ET qu'aucun fait ne les sépare (deux wilayas renseignées
 * et différentes, deux spécialités renseignées et différentes) ; ou quand elles partagent un téléphone ou un e-mail et un
 * mot du nom. La fiche GARDÉE est la plus complète (puis la plus visitée) ; chaque champ vide de la fiche gardée reçoit
 * la valeur de l'autre. L'EMPREINTE d'une paire résume l'état des deux fiches : une paire écartée ne revient que si l'une
 * d'elles change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FicheMedecinComparee {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  wilaya: string | null;
  specialite: string | null;
  etablissement: string | null;
  delegue: string | null;
  /** Ce qui est rattaché à la fiche (visites, rapports terrain, demandes Ad & Pro, segmentation…). */
  rattaches: Record<string, number>;
}

export interface PropositionFusionMedecin {
  cle: string;
  garde: FicheMedecinComparee;
  absorbee: FicheMedecinComparee;
  raisons: string[];
  /** Les champs que la fiche gardée recevra de la fiche absorbée (vides chez elle). */
  champsRecus: Partial<Record<ChampFusion, string>>;
  empreinte: string;
}

export const CHAMPS_FUSION = ["phone", "email", "wilaya", "specialite", "etablissement"] as const;
export type ChampFusion = (typeof CHAMPS_FUSION)[number];
/** Le champ du formulaire de l'écran (`updateDoctor`) qui porte chaque champ reçu par la fiche gardée. */
export const COLONNE_FORMULAIRE_FUSION: Record<ChampFusion, string> = { phone: "phone", email: "email", wilaya: "wilaya", specialite: "specialty", etablissement: "institution" };
export const LIBELLE_CHAMP_FUSION: Record<ChampFusion, string> = { phone: "téléphone", email: "e-mail", wilaya: "wilaya", specialite: "spécialité", etablissement: "établissement" };

const TITRES = new Set(["dr", "docteur", "pr", "professeur", "mme", "madame", "m", "mr", "monsieur", "mlle"]);
const plier = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const mots = (nom: string) => plier(nom).split(/[^a-z0-9]+/).filter((m) => m.length >= 2 && !TITRES.has(m));
export const cleDeNom = (nom: string) => [...new Set(mots(nom))].sort().join(" ");
const chiffres = (s: string | null) => (s ?? "").replace(/\D/g, "");
const diffAvecValeurs = (a: string | null, b: string | null) => !!plier(a).trim() && !!plier(b).trim() && plier(a).trim() !== plier(b).trim();

/** La clé d'une paire : les deux identifiants triés. */
export const clePaire = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function hacher(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** L'empreinte d'une paire : ce qui, s'il change, fait revenir une proposition écartée. */
export function empreintePaire(a: FicheMedecinComparee, b: FicheMedecinComparee): string {
  const f = (x: FicheMedecinComparee) => [x.id, plier(x.name), chiffres(x.phone), plier(x.email), plier(x.wilaya), plier(x.specialite), plier(x.etablissement)].join("¦");
  return hacher([a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map(f).join("‖"));
}

const remplis = (x: FicheMedecinComparee) => CHAMPS_FUSION.filter((c) => !!x[c]?.trim()).length;
const total = (r: Record<string, number>) => Object.values(r).reduce((s, n) => s + n, 0);

function raisonsDe(a: FicheMedecinComparee, b: FicheMedecinComparee): string[] | null {
  if (diffAvecValeurs(a.wilaya, b.wilaya) || diffAvecValeurs(a.specialite, b.specialite)) {
    // Deux faits contraires : deux praticiens homonymes, sauf si un téléphone commun dit le contraire.
    if (!(chiffres(a.phone).length >= 8 && chiffres(a.phone) === chiffres(b.phone))) return null;
  }
  const r: string[] = [];
  if (cleDeNom(a.name) === cleDeNom(b.name)) r.push("même nom");
  if (chiffres(a.phone).length >= 8 && chiffres(a.phone) === chiffres(b.phone)) r.push("même téléphone");
  if (plier(a.email).trim() && plier(a.email).trim() === plier(b.email).trim()) r.push("même e-mail");
  if (!r.length) return null;
  if (!r.includes("même nom") && !mots(a.name).some((m) => mots(b.name).includes(m))) return null;
  if (plier(a.wilaya).trim() && plier(a.wilaya).trim() === plier(b.wilaya).trim()) r.push("même wilaya");
  if (plier(a.specialite).trim() && plier(a.specialite).trim() === plier(b.specialite).trim()) r.push("même spécialité");
  return r;
}

/** Les paires proposées, la fiche gardée devant (la plus complète, puis la plus rattachée, puis la plus ancienne). */
export function proposerFusionsMedecins(fiches: readonly FicheMedecinComparee[]): PropositionFusionMedecin[] {
  const groupes = new Map<string, FicheMedecinComparee[]>();
  const ajouter = (k: string, f: FicheMedecinComparee) => { if (k) groupes.set(k, [...(groupes.get(k) ?? []), f]); };
  for (const f of fiches) {
    ajouter(`nom:${cleDeNom(f.name)}`, f);
    if (chiffres(f.phone).length >= 8) ajouter(`tel:${chiffres(f.phone)}`, f);
    if (plier(f.email).trim()) ajouter(`mail:${plier(f.email).trim()}`, f);
  }
  const vues = new Set<string>();
  const out: PropositionFusionMedecin[] = [];
  for (const g of groupes.values()) {
    if (g.length < 2 || g.length > 20) continue; // un nom très répandu n'est pas un doublon à proposer en masse
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const [a, b] = [g[i]!, g[j]!];
      const cle = clePaire(a.id, b.id);
      if (vues.has(cle)) continue;
      const raisons = raisonsDe(a, b);
      if (!raisons) continue;
      vues.add(cle);
      const [garde, absorbee] = [a, b].sort((x, y) => remplis(y) - remplis(x) || total(y.rattaches) - total(x.rattaches) || (x.id < y.id ? -1 : 1));
      const champsRecus: PropositionFusionMedecin["champsRecus"] = {};
      for (const c of CHAMPS_FUSION) if (!garde![c]?.trim() && absorbee![c]?.trim()) champsRecus[c] = absorbee![c]!;
      out.push({ cle, garde: garde!, absorbee: absorbee!, raisons, champsRecus, empreinte: empreintePaire(a, b) });
    }
  }
  return out.sort((x, y) => x.garde.name.localeCompare(y.garde.name, "fr"));
}
