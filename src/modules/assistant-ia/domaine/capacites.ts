/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APPEL GÉNÉRIQUE D'UNE CAPACITÉ — ses règles pures (lot J6, décision 0020). Zéro import.
 *
 * Une capacité du registre (`platform/ia/capacites/`) s'exécute par L'ACTION ELLE-MÊME (`lib/actions/executer.ts`),
 * sous la vraie session de la personne, avec ses gardes d'origine. Ce fichier dit ce qui ne dépend ni de la base ni
 * de la session : la forme de la charge gardée sur l'intention, ce qu'on ressaisit sur une carte renforcée, ce que la
 * carte montre d'un champ.
 *
 *   • R0 (lecture) : exécutée pendant le tour, la sortie encadrée si elle porte un contenu tiers ;
 *   • R1, R2 : une carte de confirmation (R2 la marque « sensible » : quelqu'un sera prévenu) ;
 *   • R3, R4 : une carte RENFORCÉE — la personne RESSAISIT la valeur demandée (`matchesConfirmText`, au socle).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const KIND_CAPACITE = "assistant_ia_capacite" as const;

/** Ce qu'une carte de capacité garde sur son intention — relu, rejugé, puis exécuté à la confirmation. */
export interface ChargeCapacite {
  kind: typeof KIND_CAPACITE;
  /** `fichier:fonction` — la clé du contrat. */
  id: string;
  /** L'entrée DÉJÀ résolue (un nom remplacé par l'identifiant de la fiche que la personne voit). */
  entree: Record<string, unknown>;
}

export function estChargeCapacite(v: unknown): v is ChargeCapacite {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<ChargeCapacite>;
  return c.kind === KIND_CAPACITE && typeof c.id === "string" && /^[\w.-]+:[\w$]+$/.test(c.id)
    && !!c.entree && typeof c.entree === "object" && !Array.isArray(c.entree);
}

/** Le niveau de la carte : rien pour R1, « sensible » pour R2, « critique » (ressaisie) pour R3 et R4. */
export function niveauDeCarte(risque: string): "SENSITIVE" | "CRITICAL" | undefined {
  if (risque === "R3" || risque === "R4") return "CRITICAL";
  if (risque === "R2") return "SENSITIVE";
  return undefined;
}

/** Les champs qui portent un MONTANT — la valeur à ressaisir quand il y en a un. */
const MONTANT = /^(amount|montant|total|prix|price|budget|valeur)/i;

/**
 * CE QUE LA PERSONNE RESSAISIT sur une carte renforcée : le montant s'il y en a un (on ne confirme pas un paiement
 * sans relire son chiffre), sinon le verbe du geste en capitales (« SUPPRIMER », « PUBLIER »).
 */
export function texteARessaisir(libelle: string, entree: Readonly<Record<string, unknown>>): string {
  for (const [cle, v] of Object.entries(entree)) {
    if (MONTANT.test(cle) && (typeof v === "number" || (typeof v === "string" && /\d/.test(v)))) return String(v);
  }
  const verbe = (libelle.split(/\s+/)[0] ?? "CONFIRMER").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  return verbe.length >= 3 ? verbe : "CONFIRMER";
}

/** La valeur d'un champ, telle que la carte la montre — tronquée, jamais un objet brut. */
export function valeurAffichee(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.map((x) => valeurAffichee(x)).join(", ").slice(0, 240);
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 240);
  return String(v).replace(/\s+/g, " ").slice(0, 240);
}

/** Une sortie d'action, bornée pour le modèle : au-delà, on le dit au lieu de couper en silence. */
export function sortieBornee(retour: unknown, max = 6000): string {
  let texte: string;
  try { texte = typeof retour === "string" ? retour : JSON.stringify(retour ?? null); } catch { texte = String(retour); }
  if (texte.length <= max) return texte;
  return `${texte.slice(0, max)}… [sortie tronquée : ${texte.length} caractères, ${max} montrés — demandez une lecture plus précise]`;
}

/**
 * LA CONFIGURATION D'UN RÔLE QUI NOMME LES ANCIENS OUTILS (`AssistantRoleConfig.allowedTools`) — avant J6, les écritures
 * métier étaient des outils empruntés à Adam (`create_task`, `hr_operation`…). Une configuration qui les autorisait
 * autorise désormais les CAPACITÉS du même métier (le préfixe de leur fichier d'actions) : rien n'est retiré à un rôle
 * par le changement de catalogue, et rien ne lui est ajouté hors de ce qu'il avait.
 */
export const ANCIENS_OUTILS: Readonly<Record<string, readonly string[]>> = {
  create_task: ["task__"], update_task: ["task__"], task_operation: ["task__"],
  send_message: ["messaging__"],
  create_hr_request: ["hr__", "hr-document__", "conge-discussion__"], hr_operation: ["hr__", "hr-document__", "conge-discussion__", "payroll-hr__"],
  create_admin_request: ["admin-request__"], request_operation: ["admin-request__"],
  update_regulatory_product: ["regulatory"], assign_regulatory_responsible: ["regulatory"], set_regulatory_step: ["regulatory"],
  request_regulatory_status_update: ["regulatory"], regulatory_operation: ["regulatory"],
  drive_operation: ["drive"],
};

/** Un outil est-il autorisé par une configuration de rôle (liste vide = tout) ? Son nom, ou l'ancien outil qu'il remplace. */
export function autoriseParLaConfig(nom: string, autorises: ReadonlySet<string> | null): boolean {
  if (!autorises) return true;
  if (autorises.has(nom)) return true;
  for (const ancien of autorises) {
    if ((ANCIENS_OUTILS[ancien] ?? []).some((prefixe) => nom.startsWith(prefixe))) return true;
  }
  return false;
}
