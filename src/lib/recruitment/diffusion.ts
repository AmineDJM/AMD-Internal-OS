/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DIFFUSION D'UNE OFFRE — les canaux, leurs états, et le post LinkedIn (Direction, 07/10).
 *
 * « Les différents canaux s'affichent et les RH décident le ou lesquels » : le site (l'offre JobPosting — seule
 * source de vérité de ce canal), LinkedIn (un post préparé en un clic, publié à la main : aucune API n'est
 * configurée, on ne prétend jamais avoir publié), Emploitic (quand sa clé d'API existera), et « Autre ».
 *
 * Module PUR — aucun import : l'écran (client), les actions et le rédacteur Luna (`recrutement-diffusion.ts`, hors
 * des domaines parce qu'il appelle un fournisseur) le lisent tous.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CANAUX = ["SITE_WEB", "LINKEDIN", "EMPLOITIC", "AUTRE"] as const;
export type Canal = (typeof CANAUX)[number];

export const CANAL_LABEL: Record<Canal, string> = {
  SITE_WEB: "Site web",
  LINKEDIN: "LinkedIn",
  EMPLOITIC: "Emploitic",
  AUTRE: "Autre",
};

export function estCanal(v: string | null | undefined): v is Canal {
  return (CANAUX as readonly string[]).includes(v ?? "");
}

export type TonPastille = "neutral" | "info" | "success" | "warning" | "danger";

/** La pastille d'un canal : « Préparé », « Publié le 7 oct. », « Retiré », « Échec » — ou « — » s'il n'a rien. */
export function pastilleCanal(statut: string | null | undefined, publieLe: Date | string | null | undefined): { libelle: string; ton: TonPastille } {
  switch (statut) {
    case "PREPARE": return { libelle: "Préparé", ton: "info" };
    case "PUBLIE": {
      const d = publieLe ? new Date(publieLe) : null;
      const jour = d && !Number.isNaN(d.getTime())
        ? d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Algiers" })
        : null;
      return { libelle: jour ? `Publié le ${jour}` : "Publié", ton: "success" };
    }
    case "RETIRE": return { libelle: "Retiré", ton: "neutral" };
    case "ECHEC": return { libelle: "Échec", ton: "danger" };
    default: return { libelle: "—", ton: "neutral" };
  }
}

// ───────────────────────────── Emploitic ─────────────────────────────

/** La clé d'API Emploitic est-elle posée ? Tant qu'elle manque, le canal s'affiche « API à configurer ». */
export function emploiticConfigure(env: Record<string, string | undefined>): boolean {
  return Boolean((env.EMPLOITIC_API_KEY ?? "").trim());
}

export const RAISON_EMPLOITIC_NON_CONFIGURE =
  "L'API Emploitic n'est pas configurée : la variable EMPLOITIC_API_KEY manque (Render de l'ERP).";

// ───────────────────────────── LinkedIn ─────────────────────────────

/** LinkedIn coupe un post au-delà ; on reste en dessous, lien et mots-dièse compris. */
export const LIMITE_POST_LINKEDIN = 3000;

/** Ce que porte la demande et son offre — et RIEN d'autre : le post n'invente aucune information. */
export interface ContenuPostLinkedIn {
  /** La société de la demande (son nom court de préférence). */
  societe: string | null;
  poste: string;
  departement: string | null;
  lieu: string | null;
  /** « CDI », « CDD »… */
  contrat: string | null;
  resume: string | null;
  missions: string[];
  profil: string[];
  /** Ce que l'offre PUBLIÉE propose (avantages, rémunération si elle y figure) — vide sinon. */
  avantages: string[];
  /** La page de l'offre sur le site (confirmée par le site), ou la page carrières ; `null` si aucune. */
  lien: string | null;
}

/** Le lien de partage LinkedIn, texte prérempli — ouvert dans un nouvel onglet, la personne publie elle-même. */
export function lienPartageLinkedIn(texte: string): string {
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(texte)}`;
}

const sansAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Un mot-dièse lisible depuis un libellé : « Délégué médical » → « #DelegueMedical ». */
export function motDiese(libelle: string): string | null {
  const mots = sansAccents(libelle).replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (mots.length === 0) return null;
  const s = mots.map((m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()).join("").slice(0, 40);
  return `#${s}`;
}

/** Les mots-dièse sans IA : le poste, la société, puis des génériques du secteur — 3 à 5, sans doublon. */
export function motsDieseDeSecours(c: ContenuPostLinkedIn): string[] {
  const candidats = [motDiese(c.poste), c.societe ? motDiese(c.societe) : null, "#Recrutement", "#Emploi", "#Pharma", "#Algerie"];
  const out: string[] = [];
  for (const h of candidats) if (h && !out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h);
  return out.slice(0, 5);
}

const puce = (s: string) => `• ${s.trim()}`;

/**
 * LE POST SANS IA — quand Luna se tait, tarde ou se trompe. Sobre, professionnel, et fait UNIQUEMENT de ce que
 * la demande et l'offre portent : pas de salaire (sauf s'il figure dans l'offre publiée, via `avantages`).
 */
export function postLinkedInDeSecours(c: ContenuPostLinkedIn): string {
  const qui = c.societe ? `${c.societe} recrute` : "Nous recrutons";
  const precisions = [c.contrat, c.lieu, c.departement].filter((x): x is string => Boolean(x && x.trim()));
  const lignes: string[] = [
    `${qui} : ${c.poste.trim()}${precisions.length ? ` (${precisions.join(" · ")})` : ""}.`,
  ];
  if (c.resume?.trim()) lignes.push("", c.resume.trim());
  if (c.missions.length) lignes.push("", "Vos missions :", ...c.missions.slice(0, 5).map(puce));
  if (c.profil.length) lignes.push("", "Votre profil :", ...c.profil.slice(0, 5).map(puce));
  if (c.avantages.length) lignes.push("", "Ce que nous offrons :", ...c.avantages.slice(0, 4).map(puce));
  lignes.push("", c.lien ? `Pour postuler : ${c.lien}` : "Intéressé(e) ? Écrivez-nous en message privé.");
  lignes.push("", motsDieseDeSecours(c).join(" "));
  return borner(lignes.join("\n"));
}

function borner(texte: string): string {
  return texte.length <= LIMITE_POST_LINKEDIN ? texte : `${texte.slice(0, LIMITE_POST_LINKEDIN - 1).trimEnd()}…`;
}

const MONNAIE = /\b(dzd|da|dinars?|salaire|r[ée]mun[ée]ration|k ?da)\b/i;

/**
 * LE POST DE LUNA, JUGÉ AVANT D'ÊTRE RETENU — `null` s'il ne tient pas : un objet `{ texte, motsDiese }`, un texte
 * non vide qui nomme le poste, 3 à 5 mots-dièse, aucune rémunération si l'offre publiée n'en dit rien. Le lien de
 * candidature est ajouté s'il manque ; les mots-dièse sont posés en fin de post.
 */
export function postLinkedInValide(brut: unknown, c: ContenuPostLinkedIn): string | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as { texte?: unknown; motsDiese?: unknown };
  if (typeof o.texte !== "string" || !Array.isArray(o.motsDiese)) return null;
  let texte = o.texte.trim();
  if (texte.length < 40) return null;
  const poste = sansAccents(c.poste).toLowerCase().split(/\s+/).filter((m) => m.length > 3);
  const corps = sansAccents(texte).toLowerCase();
  if (poste.length && !poste.some((m) => corps.includes(m))) return null;
  const offreParleArgent = c.avantages.some((a) => MONNAIE.test(a));
  if (!offreParleArgent && MONNAIE.test(texte)) return null;
  const motsDiese = (o.motsDiese as unknown[])
    .filter((h): h is string => typeof h === "string")
    .map((h) => (h.trim().startsWith("#") ? h.trim() : `#${h.trim()}`).replace(/\s+/g, ""))
    .filter((h) => /^#[\p{L}\p{N}_]{2,40}$/u.test(h));
  const uniques = motsDiese.filter((h, i) => motsDiese.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i);
  if (uniques.length < 3) return null;
  // Les mots-dièse que Luna aurait laissés dans le corps sont retirés : ils sont posés une fois, en fin de post.
  texte = texte.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1").replace(/[ \t]+\n/g, "\n").trim();
  if (c.lien && !texte.includes(c.lien)) texte = `${texte}\n\nPour postuler : ${c.lien}`;
  return borner(`${texte}\n\n${uniques.slice(0, 5).join(" ")}`);
}
