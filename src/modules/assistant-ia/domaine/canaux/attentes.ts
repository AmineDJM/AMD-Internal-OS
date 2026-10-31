/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES REÇUES PAR WHATSAPP ET PAR MAIL — LES RÈGLES PURES (lot K6, décision 0036).
 *
 * Direction, 31/10/2026 : « Si je suis en appel avec l'assistant et que je lui dis "attends, je vais t'envoyer les pièces
 * jointes", par mail ou par WhatsApp, il s'attend à les recevoir. Il garde ce contexte en tête, sans inonder les requêtes
 * de jetons. »
 *
 *   • UNE ATTENTE DE PIÈCES est courte et structurée : quoi (« lettre de demande du Dr Mansouri »), pour quelle fiche,
 *     par quel canal, jusqu'à quand (48 h par défaut, `ASSISTANT_IA_ATTENTE_HEURES`).
 *   • Elle n'entre dans la consigne QUE si elle est ouverte : une ligne d'au plus ~40 jetons, trois au plus.
 *   • Une pièce arrivée la marque REÇUE ; elle reste rattachable 30 min (WhatsApp envoie une pièce par message).
 *   • L'expéditeur est reconnu par son numéro (neuf derniers chiffres) ou son adresse ; un inconnu reçoit un refus poli
 *     et rien n'est stocké. Une pièce sensible (identité, banque, paie) est rangée en CONFIDENTIEL.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type CanalEntrant = "WHATSAPP" | "MAIL" | "GMAIL";

export const LIBELLE_CANAL: Record<CanalEntrant, string> = { WHATSAPP: "WhatsApp", MAIL: "mail", GMAIL: "mail" };

export const DUREE_ATTENTE_H_DEFAUT = 48;
/** Après la première pièce : encore 30 min pour les suivantes (une par message sur WhatsApp). */
export const RATTACHABLE_APRES_RECEPTION_MS = 30 * 60_000;
export const ATTENTES_EN_CONSIGNE_MAX = 3;
export const DESCRIPTION_MAX = 200;
/** Borne propre aux canaux, sous celle du Drive (réglage) : un document scanné tient largement. */
export const TAILLE_MAX_CANAL_OCTETS = 25 * 1024 * 1024;

export function dureeAttenteHeures(brut: string | undefined | null): number {
  const n = Number(brut);
  return Number.isFinite(n) && n >= 1 && n <= 24 * 14 ? Math.round(n) : DUREE_ATTENTE_H_DEFAUT;
}

export const expirationAttente = (maintenant: Date, heures: number): Date => new Date(maintenant.getTime() + heures * 3_600_000);

/** « whatsapp », « mail », « WhatsApp ou mail », [] → la liste des canaux (vide : l'un ou l'autre). */
export function canauxAttendus(brut: unknown): ("WHATSAPP" | "MAIL")[] {
  const s = (Array.isArray(brut) ? brut.join(" ") : typeof brut === "string" ? brut : "").toLowerCase();
  const out: ("WHATSAPP" | "MAIL")[] = [];
  if (/whats|wa\b|t[ée]l[ée]phone/.test(s)) out.push("WHATSAPP");
  if (/mail|courriel|gmail|e-?mail/.test(s)) out.push("MAIL");
  return out;
}

export interface AttenteVue {
  id: string;
  description: string;
  canaux: string[];
  cibleLibelle: string | null;
  etat: string;
  expireLe: Date;
  recueLe: Date | null;
}

/** Une attente encore rattachable à cet instant (ouverte et non expirée, ou reçue il y a moins de 30 min). */
export function attenteRattachable(a: Pick<AttenteVue, "etat" | "expireLe" | "recueLe">, maintenant: Date): boolean {
  if (a.expireLe.getTime() <= maintenant.getTime()) return false;
  if (a.etat === "OUVERTE") return true;
  return a.etat === "RECUE" && !!a.recueLe && maintenant.getTime() - a.recueLe.getTime() <= RATTACHABLE_APRES_RECEPTION_MS;
}

/** L'attente d'un canal donné : celle qui l'accepte (canaux vides = tous), la plus récente d'abord. */
export function attentePourCanal<T extends AttenteVue & { createdAt: Date }>(attentes: T[], canal: CanalEntrant, maintenant: Date): T | null {
  const voulu = canal === "GMAIL" ? "MAIL" : canal;
  const ok = attentes
    .filter((a) => attenteRattachable(a, maintenant))
    .filter((a) => !a.canaux.length || a.canaux.includes(voulu))
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  return ok[0] ?? null;
}

const heureAlger = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Algiers", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(d);
const court = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * LA SECTION DE LA CONSIGNE — seulement les attentes ouvertes, une ligne chacune, trois au plus. Vide : rien
 * (aucun jeton). Le texte est celui de l'attente, borné : il vient de la personne ou du modèle, jamais d'un tiers.
 */
export function sectionAttentes(attentes: AttenteVue[], maintenant: Date): string | null {
  const ouvertes = attentes.filter((a) => attenteRattachable(a, maintenant)).slice(0, ATTENTES_EN_CONSIGNE_MAX);
  if (!ouvertes.length) return null;
  const lignes = ouvertes.map((a) => {
    const canaux = a.canaux.length ? a.canaux.map((c) => LIBELLE_CANAL[c as CanalEntrant] ?? c).join(" ou ") : "WhatsApp ou mail";
    const pour = a.cibleLibelle ? ` → ${court(a.cibleLibelle, 60)}` : "";
    const etat = a.etat === "RECUE" ? "reçue" : `attendue par ${canaux}, jusqu'à ${heureAlger(a.expireLe)}`;
    return `- ${court(a.description, 90)}${pour} (${etat})`;
  });
  return [
    "### PIÈCES ATTENDUES",
    ...lignes,
    "Une pièce reçue arrive dans la conversation avec sa carte de rangement : ne redemande pas une pièce déjà reçue.",
  ].join("\n");
}

// ─────────────────────────────── La reconnaissance de l'expéditeur ───────────────────────────────

/** La clé d'un numéro : ses neuf derniers chiffres (« 0555 12 34 56 », « +213 555 123 456 », « 213555123456 »). */
export function cleTelephone(brut: string | null | undefined): string | null {
  const chiffres = (brut ?? "").replace(/\D/g, "");
  if (chiffres.length < 9 || /^(\d)\1+$/.test(chiffres)) return null;
  return chiffres.slice(-9);
}

/** Un expéditeur journalisé sans être révélé : « +213•••••4567 », « a•••@exemple.dz ». */
export function masquerExpediteur(brut: string): string {
  const s = brut.trim();
  if (s.includes("@")) {
    const [local, domaine] = s.split("@");
    return `${(local ?? "").slice(0, 1)}•••@${domaine ?? ""}`;
  }
  const c = s.replace(/\D/g, "");
  return c.length > 4 ? `+${c.slice(0, Math.min(3, c.length - 4))}•••••${c.slice(-4)}` : "•••";
}

// ─────────────────────────────── Les bornes d'une pièce reçue ───────────────────────────────

/** Ce qu'aucune pièce reçue ne peut être : un exécutable ou un script (il n'a rien à faire dans un dossier). */
const FORMAT_REFUSE = /\.(exe|bat|cmd|com|scr|msi|dll|js|jse|vbs|vbe|ps1|psm1|sh|jar|apk|app|lnk|hta|reg)$/i;

/** Le refus d'une pièce reçue, dit en clair — ou `null`. Bornes : `maxMo` (réglage du Drive) et 25 Mo (canal). */
export function refusPieceRecue(nom: string, octets: number, maxMo: number): string | null {
  if (octets <= 0) return "fichier vide";
  if (FORMAT_REFUSE.test(nom.trim())) return "format refusé (exécutable ou script)";
  const max = Math.min(TAILLE_MAX_CANAL_OCTETS, Math.max(1, maxMo) * 1024 * 1024);
  if (octets > max) return `fichier trop volumineux (${Math.ceil(octets / 1024 / 1024)} Mo, ${Math.floor(max / 1024 / 1024)} Mo au plus)`;
  return null;
}

// ─────────────────────────────── La confidentialité ───────────────────────────────

const PIECE_SENSIBLE = /(passe?port|\brib\b|iban|relev[ée].?bancaire|carte.?d.?identit|\bcni\b|\bnin\b|bulletin.?de.?paie|fiche.?de.?paie|salaire|contrat.?de.?travail|certificat.?m[ée]dical|arr[êe]t.?maladie)/i;
const CIBLES_RH = new Set(["EMPLOYEE", "PAYROLL", "HR_REQUEST", "SALARY_ADVANCE", "LEAVE_REQUEST"]);

/** Une pièce RH ou « du coffre » (identité, banque, paie, santé) : rangée en CONFIDENTIEL, jamais lue au modèle d'office. */
export function pieceConfidentielle(nom: string, cibleType: string | null | undefined): boolean {
  return PIECE_SENSIBLE.test(nom.normalize("NFD").replace(/[̀-ͯ]/g, "")) || CIBLES_RH.has((cibleType ?? "").toUpperCase());
}

/** « lettre de demande du Dr X » → la catégorie de document (libellé de l'ERP) à proposer, sinon « Autre ». */
export function categorieProposee(description: string, explicite?: string | null): string {
  if (explicite?.trim()) return explicite.trim();
  const d = description.toLowerCase();
  if (/lettre|courrier|demande/.test(d)) return "Lettre de demande";
  if (/devis/.test(d)) return "Devis";
  if (/facture/.test(d)) return "Facture";
  if (/programme/.test(d)) return "Programme";
  return "Autre";
}

// ─────────────────────────────── Ce que l'assistant dit ───────────────────────────────

export const REFUS_INCONNU_WHATSAPP =
  "Bonjour, ce numéro n'est pas reconnu par l'assistant d'Adventum Pharma : rien n'a été enregistré. "
  + "Si vous êtes collaborateur, faites ajouter ce numéro à votre fiche dans l'ERP.";
export const ACCUSE_WHATSAPP = "Bien reçu — la pièce est dans votre conversation avec l'Assistant IA.";

export function messageDeReception(d: {
  canal: CanalEntrant; noms: string[]; description?: string | null; cibleLibelle?: string | null; carte: boolean;
  confidentiel: boolean; refusees: string[];
}): string {
  const canal = LIBELLE_CANAL[d.canal];
  const quoi = d.description?.trim() ? d.description.trim() : d.noms.length > 1 ? `${d.noms.length} pièces` : `« ${d.noms[0] ?? "la pièce"} »`;
  const lignes: string[] = [];
  if (d.noms.length) {
    lignes.push(`J'ai reçu ${quoi} par ${canal}${d.description && d.noms.length ? ` (« ${d.noms.join(" », « ")} »)` : ""} ; elle est dans votre Drive (dossier « Assistant IA — pièces reçues »).`);
    if (d.carte && d.cibleLibelle) lignes.push(`Je l'ajoute à ${d.cibleLibelle} ? Confirmez la carte ci-dessous.`);
    else if (d.description) lignes.push("Où dois-je la ranger dans l'ERP ? Donnez-moi la fiche (référence ou nom).");
    else lignes.push("À quoi la rattacher ?");
    if (d.confidentiel) lignes.push("Pièce sensible : elle sera rangée en confidentiel, et je ne la lis pas sans votre demande.");
  }
  if (d.refusees.length) lignes.push(`Non reçue${d.refusees.length > 1 ? "s" : ""} : ${d.refusees.join(" ; ")}.`);
  return lignes.join("\n");
}
