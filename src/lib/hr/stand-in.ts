import { PERMISSIONS, MODULES, type Action, type Module } from "@/lib/rbac";

/**
 * L'INTÉRIMAIRE D'UN CONGÉ — quelqu'un tient la place, le temps de l'absence.
 *
 * Une personne part trois semaines. Ses validations s'empilent, ses dossiers dorment, et l'on
 * découvre au retour qu'une demande attendait depuis quinze jours. La parade habituelle — donner
 * le mot de passe à un collègue, ou demander au Super Admin d'ouvrir un accès « pour cette fois »
 * — est exactement ce qu'on veut éviter : elle ne laisse aucune trace, elle ne s'arrête jamais,
 * et personne ne sait qui a signé quoi.
 *
 * D'où une délégation EXPLICITE, portée par la demande de congé elle-même :
 *
 *   ①  L'ABSENT DÉSIGNE son intérimaire — il est le seul à savoir qui peut réellement le
 *      remplacer sur son métier.
 *   ②  Les RH VALIDENT ce choix. Sans cette marche, chacun pourrait se choisir un remplaçant
 *      complaisant, et la délégation deviendrait un moyen de contourner un circuit.
 *   ③  La délégation NE VIT QUE PENDANT LE CONGÉ. Elle s'ouvre à la date de début, se ferme à la
 *      date de fin, et personne n'a rien à révoquer : c'est le calendrier qui la termine, pas la
 *      mémoire de quelqu'un.
 *
 * Deux bornes qui font toute la différence entre une intérim et un compte partagé :
 *
 *   • l'intérimaire ne reçoit QUE les modules choisis, jamais tout le compte. Un directeur qui
 *     part en congé délègue ses validations, pas la lecture de ses courriels ;
 *   • il ne reçoit jamais PLUS que ce que l'absent DÉTIENT. Pas la matrice de son rôle : ce que son
 *     rôle, son « autre rôle » et la console lui donnent réellement (`accesAttribue`) — un module que
 *     l'administrateur lui a bloqué, un accès personnalisé plus étroit que son rôle, un module retiré
 *     de la plateforme ne passent pas par l'intérim (§118.196, lot E4 — audit 360°, M13). Une
 *     délégation qui ajouterait des droits serait une promotion déguisée, et le retour du titulaire
 *     ne la retirerait pas.
 *
 * Module PUR — testé, sans base de données.
 */

export type StandInStatus = "PENDING" | "APPROVED" | "REJECTED";

export const STAND_IN_LABEL: Record<StandInStatus, string> = {
  PENDING: "Intérimaire proposé — en attente des RH",
  APPROVED: "Intérimaire validé",
  REJECTED: "Intérimaire refusé",
};

/**
 * Les modules qu'on peut déléguer — et ceux qu'on ne prête JAMAIS, chacun avec sa raison.
 *
 * On exclut ce qui n'a AUCUN sens à déléguer, et le dire vaut mieux que de laisser quelqu'un
 * cocher une case qui ne produira rien :
 *   • `ADMIN`, `ADVENTUM_BRAIN`, `PROCESS_INTELLIGENCE` — la souveraineté du Super Admin (comptes,
 *     rôles, accès, IA) ne se prête pas. Les deux derniers ne sont gardés que par leur module :
 *     prêtés par un Super Admin absent, ils s'ouvraient réellement à son intérimaire ;
 *   • `DRIVE`, `MESSAGING`, `WORKSPACE`, `NOTIFICATIONS`, `ASSISTANT_IA` — ce sont les espaces
 *     PERSONNELS de l'absent. Remplacer quelqu'un, ce n'est pas lire son Drive privé, sa messagerie
 *     ni parler à son assistant, qui agit en son nom ;
 *   • `PAYMENT_CENTRE`, `VALIDATION_CENTRE`, `AD_PRO_CENTRE`, `CHIEF_OF_STAFF` — des SIÈGES : un rôle
 *     ou une désignation nominative les donne, pas le module (`sitsOnPaymentCentre`,
 *     `sitsOnValidationCentre`, `siegeAuCentreAdPro`, `peutVoirAdam`). L'intérim ne prête aucun rôle
 *     (§118.185) : la case ouvrait une entrée de menu menant à une page refusée. Prêter un siège est
 *     une décision de la Direction, pas une case à cocher (§118.196) ;
 *   • `MY_TEAM`, `DIRECTORIES` — des portes accordées à tous : il n'y a rien à prêter.
 */
const NEVER_DELEGATED: readonly Module[] = [
  "ADMIN", "ADVENTUM_BRAIN", "PROCESS_INTELLIGENCE",
  "DRIVE", "MESSAGING", "WORKSPACE", "NOTIFICATIONS", "ASSISTANT_IA",
  "PAYMENT_CENTRE", "VALIDATION_CENTRE", "AD_PRO_CENTRE", "CHIEF_OF_STAFF",
  "MY_TEAM", "DIRECTORIES",
];

export function isDelegatable(module: string): module is Module {
  return (MODULES as readonly string[]).includes(module)
    && !(NEVER_DELEGATED as readonly string[]).includes(module);
}

/** Nettoie une liste de modules venue d'un formulaire : on garde ce qui est délégable. */
export function normalizeDelegated(raw: readonly unknown[]): Module[] {
  return [...new Set(raw.map((v) => String(v ?? "").trim()).filter(isDelegatable))] as Module[];
}

export interface StandInLeave {
  /** Le congé lui-même doit être ACCORDÉ : on ne remplace pas quelqu'un qui est là. */
  leaveApproved: boolean;
  standInId: string | null;
  standInStatus: StandInStatus | null;
  standInModules: readonly string[];
  startDate: Date | string;
  endDate: Date | string;
}

function day(v: Date | string): number {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? NaN : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * La délégation est-elle ACTIVE aujourd'hui ?
 *
 * Quatre conditions, et aucune n'est superflue : le congé accordé, un intérimaire désigné, les RH
 * d'accord, et la date dans la fenêtre. On compare des JOURS, pas des instants : un congé du 3 au
 * 10 couvre le 10 tout entier — s'arrêter à minuit laisserait le dernier jour sans personne.
 */
export function isDelegationActive(leave: StandInLeave, now: Date = new Date()): boolean {
  if (!leave.leaveApproved) return false;
  if (!leave.standInId || leave.standInStatus !== "APPROVED") return false;
  const from = day(leave.startDate);
  const to = day(leave.endDate);
  const today = day(now);
  if (Number.isNaN(from) || Number.isNaN(to) || Number.isNaN(today)) return false;
  return today >= from && today <= to;
}

/** Pourquoi la délégation ne joue pas — dit en clair, plutôt qu'un refus muet. */
export function inactiveReason(leave: StandInLeave, now: Date = new Date()): string | null {
  if (isDelegationActive(leave, now)) return null;
  if (!leave.standInId) return "Aucun intérimaire n'est désigné.";
  if (leave.standInStatus === "REJECTED") return "Les RH ont refusé cet intérimaire.";
  if (leave.standInStatus !== "APPROVED") return "Les RH n'ont pas encore validé cet intérimaire.";
  if (!leave.leaveApproved) return "Le congé n'est pas encore accordé.";
  const today = day(now);
  if (today < day(leave.startDate)) return "L'intérim commencera au premier jour du congé.";
  return "L'intérim a pris fin avec le congé.";
}

/**
 * CE QUE L'ABSENT DÉTIENT — la seule source des droits prêtés (§118.196, lot E4 — audit 360°, M13).
 *
 * `role` est son rôle PRINCIPAL : la matrice de ce rôle reste une BORNE. C'est tout ce que la règle
 * d'avant prêtait, et prêter davantage — son « autre rôle », un accès personnalisé plus large que son
 * rôle, un accès implicite — serait un élargissement que la Direction n'a pas décidé. `detient` est
 * son accès ATTRIBUÉ (`accesAttribue` : rôle, « autre rôle », console — la règle même de
 * `getAccess`) : ce qu'il a réellement, blocages et modules retirés compris.
 */
export interface Detenteur {
  role: string;
  detient: ReadonlyMap<Module, { actions: ReadonlySet<Action> }>;
}

/**
 * Les droits que l'intérimaire reçoit sur un module — ce que l'absent DÉTIENT, borné par la matrice de
 * son rôle principal, sans la SUPPRESSION : un remplaçant ne détruit pas, c'est le genre de geste qui
 * se découvre au retour et qui ne se répare pas.
 *
 * `null` quand il n'y a rien à prêter — un module qu'on ne prête jamais, un module que l'absent ne voit
 * pas, ou que la console lui a retiré : une délégation ne crée pas un droit, elle en prête un.
 */
export function delegatedActions(absent: Detenteur, module: Module): Action[] | null {
  if (!isDelegatable(module)) return null;
  const parRole = PERMISSIONS[absent.role as keyof typeof PERMISSIONS]?.[module];
  const detenu = absent.detient.get(module)?.actions;
  if (!parRole?.includes("VIEW") || !detenu?.has("VIEW")) return null;
  return parRole.filter((a) => a !== "DELETE" && detenu.has(a));
}

export interface Delegation {
  module: Module;
  actions: Action[];
}

/** Ce que l'intérimaire obtient réellement, module par module. */
export function delegationsFor(absent: Detenteur, modules: readonly string[]): Delegation[] {
  const out: Delegation[] = [];
  for (const m of normalizeDelegated(modules)) {
    const actions = delegatedActions(absent, m);
    if (actions) out.push({ module: m, actions });
  }
  return out;
}

/**
 * Ce qu'une personne peut PRÊTER — la liste que l'écran de déclaration propose, et la seule que
 * l'action accepte : une case qui ne prêterait rien ne s'affiche pas (§118.196).
 */
export function modulesPretables(absent: Detenteur): Module[] {
  return MODULES.filter((m) => delegatedActions(absent, m) !== null);
}

/** Les modules choisis que la délégation NE transmettrait PAS — à dire, jamais à taire. */
export function modulesNonPretes(absent: Detenteur, choisis: readonly string[]): string[] {
  return [...new Set(choisis.map((m) => String(m ?? "").trim()))]
    .filter((m) => m.length > 0 && delegatedActions(absent, m as Module) === null);
}

/**
 * Ce congé est-il TERMINÉ ? On compare des JOURS, comme `isDelegationActive` : le dernier jour reste
 * ouvert. Un congé terminé n'a plus de place à tenir — la liste ne propose plus d'y désigner quelqu'un,
 * et l'action le refuse.
 */
export function congeTermine(endDate: Date | string, now: Date = new Date()): boolean {
  const fin = day(endDate);
  const today = day(now);
  return !Number.isNaN(fin) && !Number.isNaN(today) && today > fin;
}

function jourMois(v: Date | string): string | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(d);
}

/**
 * Cette personne remplace-t-elle CET absent en ce moment ?
 *
 * Sert aux gardes d'action : décider une validation adressée à l'absent, ouvrir un dossier qui
 * lui était confié. On ne se remplace pas soi-même — le cas paraît absurde, mais il naît tout
 * seul le jour où quelqu'un se désigne par erreur, et il ferait passer une auto-validation pour
 * une intérim.
 */
export function actsFor(
  leave: StandInLeave & { absenteeUserId: string },
  viewerId: string,
  now: Date = new Date(),
): boolean {
  if (viewerId === leave.absenteeUserId) return false;
  return leave.standInId === viewerId && isDelegationActive(leave, now);
}

/** « Vous remplacez Karim Saïdi jusqu'au 12 septembre. » */
export function delegationNotice(absenteeName: string, endDate: Date | string): string {
  const d = endDate instanceof Date ? endDate : new Date(endDate);
  const when = Number.isNaN(d.getTime())
    ? "pendant son congé"
    : `jusqu'au ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(d)}`;
  return `Vous remplacez ${absenteeName} ${when} : ses validations en attente vous sont ouvertes.`;
}

/**
 * LA NOTIFICATION DE L'INTÉRIMAIRE QUAND LES RH VALIDENT (§118.196, lot E4).
 *
 * Elle disait « Vous remplacez X : ses validations en attente vous sont ouvertes » le jour de la
 * validation — souvent des semaines avant le congé, parfois avant même qu'il soit accordé : la phrase
 * était fausse au moment exact où on la lisait. Elle dit maintenant QUAND l'intérim s'ouvrira, et ce
 * qu'il transmettra.
 */
export function annonceDeValidation(
  absentNom: string,
  conge: { leaveApproved: boolean; startDate: Date | string; endDate: Date | string },
  modulesPretes: readonly string[],
  now: Date = new Date(),
): string {
  const prete = modulesPretes.length ? ` Modules prêtés : ${modulesPretes.join(", ")}.` : "";
  const actif = isDelegationActive({ ...conge, standInId: "intérimaire", standInStatus: "APPROVED", standInModules: [] }, now);
  if (actif) return `${delegationNotice(absentNom, conge.endDate)} Elles sont réunies dans « Mon espace ».${prete}`;
  const du = jourMois(conge.startDate);
  const au = jourMois(conge.endDate);
  const periode = du && au ? ` (congé du ${du} au ${au})` : "";
  const quand = conge.leaveApproved
    ? "L'intérim s'ouvrira de lui-même au premier jour du congé"
    : "Le congé n'est pas encore accordé : s'il l'est, l'intérim s'ouvrira de lui-même au premier jour";
  return `Les RH ont validé votre désignation comme intérimaire de ${absentNom}${periode}. ${quand}, et ses décisions en attente vous seront alors réunies dans « Mon espace ».${prete}`;
}

/**
 * LE BANDEAU DE L'INTÉRIMAIRE — qui l'on remplace, jusqu'à quand, et ce qui en vient (§118.196, lot E4).
 * La phrase qu'il lit là où il agit : sans elle, rien ne distingue un module prêté d'un droit propre,
 * ni une décision prise au nom d'un absent d'une décision ordinaire.
 */
export function bandeauInterim(
  i: { absentNom: string; jusquau: Date | string; modules: readonly string[] },
  libelles: Readonly<Record<string, string>>,
): string {
  const au = jourMois(i.jusquau);
  const mods = i.modules.length ? ` (${i.modules.map((m) => libelles[m] ?? m).join(", ")})` : "";
  return `Intérim : vous remplacez ${i.absentNom}${au ? ` jusqu'au ${au}` : " pendant son congé"}${mods} — ce que vous tranchez pour cette personne est enregistré à votre nom.`;
}
