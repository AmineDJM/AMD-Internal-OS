/**
 * LA FICHE DE DEMANDE DE CONGÉ — ce que le formulaire papier portait, et que l'écran perdait.
 *
 * Une demande de congé se lit par trois personnes qui ne connaissent pas le demandeur de la même
 * façon : le responsable sait qui il est, les RH ont besoin de sa date de recrutement et de sa
 * direction, la direction générale veut savoir qui tient la place et où le joindre. L'écran
 * n'affichait que « type, dates, motif » — le reste se demandait par téléphone, à chaque marche.
 *
 * ── CE QUI SE LIT PLUTÔT QUE DE SE RECOPIER ─────────────────────────────────────────────────
 *
 * Nom, prénom, fonction, date de recrutement et direction viennent de la FICHE EMPLOYÉ. Les
 * recopier dans la demande en ferait une seconde vérité : le jour où quelqu'un change de
 * direction, ses demandes de l'an dernier afficheraient encore l'ancienne, et personne ne
 * saurait laquelle croire. Seul le TÉLÉPHONE est porté par la demande — on ne part pas en congé
 * avec son poste de bureau.
 *
 * ── LA DATE DE REPRISE N'EST PAS LA DATE DE FIN ─────────────────────────────────────────────
 *
 * Le congé finit le dimanche ; la reprise est le lundi. Les afficher comme une seule date est
 * l'erreur qui fait qu'on attend quelqu'un un jour trop tôt — la fiche porte les deux.
 *
 * Module PUR : ni base, ni import lourd. Testé.
 */

export interface LeaveSheetEmployee {
  fullName: string;
  position?: string | null;
  hireDate?: Date | string | null;
  /** Libellé de la direction / du département de rattachement. */
  department?: string | null;
  phone?: string | null;
}

export interface LeaveSheetRequest {
  createdAt: Date | string;
  startDate: Date | string;
  endDate: Date | string;
  days: number;
  /** Téléphone saisi à la demande — prime sur celui de la fiche employé. */
  phone?: string | null;
  /** Nom de l'intérimaire désigné, s'il y en a un. */
  standInName?: string | null;
  standInStatus?: string | null;
}

export interface LeaveSheetLine {
  label: string;
  value: string;
}

const MANQUANT = "—";

function fr(d: Date | string | null | undefined): string {
  if (!d) return MANQUANT;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? MANQUANT : date.toLocaleDateString("fr-FR");
}

/**
 * NOM et PRÉNOM à partir du nom complet.
 *
 * La base ne connaît que `fullName` — les scinder au moment de la saisie aurait supposé de
 * ressaisir 200 fiches, et la moitié des noms composés seraient tombés du mauvais côté. La
 * convention retenue est celle des formulaires RH algériens tels qu'ils sont remplis ici :
 * **le premier mot est le nom de famille**, le reste le prénom (« BENALI Mohamed Amine »).
 *
 * Un nom d'un seul mot ne se coupe pas : on le donne comme nom, et le prénom reste vide plutôt
 * que d'inventer. Deviner est pire que dire qu'on ne sait pas — la personne corrige à l'écran.
 */
export function splitFullName(fullName: string): { nom: string; prenom: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nom: "", prenom: "" };
  if (parts.length === 1) return { nom: parts[0], prenom: "" };
  return { nom: parts[0], prenom: parts.slice(1).join(" ") };
}

/**
 * LA DATE DE REPRISE : le lendemain du dernier jour de congé. Calculée en UTC pour ne pas
 * glisser d'un jour au passage à l'heure d'été — une reprise décalée d'un jour est exactement
 * le genre d'erreur qu'on ne voit qu'une fois la personne absente.
 */
export function resumeDate(endDate: Date | string): Date {
  const end = endDate instanceof Date ? new Date(endDate) : new Date(endDate);
  return new Date(end.getTime() + 86_400_000);
}

/** L'état de l'intérim, dit en clair — « désigné » ne veut pas dire « accepté par les RH ». */
export function describeStandIn(name: string | null | undefined, status: string | null | undefined): string {
  if (!name) return "Aucun intérimaire désigné";
  switch (status) {
    case "APPROVED":
      return `${name} (validé par les RH)`;
    case "REJECTED":
      return `${name} (refusé par les RH)`;
    case "PENDING":
      return `${name} (en attente de validation RH)`;
    default:
      return name;
  }
}

/**
 * LA FICHE COMPLÈTE, dans l'ordre du formulaire — c'est cet ordre que les RH lisent depuis
 * toujours, et le changer obligerait à réapprendre un document qu'ils connaissent par cœur.
 * Une valeur absente s'affiche « — » : un champ vide se voit, une ligne masquée ne se voit pas.
 */
export function buildLeaveSheet(
  employee: LeaveSheetEmployee,
  request: LeaveSheetRequest,
): LeaveSheetLine[] {
  const { nom, prenom } = splitFullName(employee.fullName);
  return [
    { label: "Nom", value: nom || MANQUANT },
    { label: "Prénom", value: prenom || MANQUANT },
    { label: "Fonction", value: employee.position?.trim() || MANQUANT },
    { label: "Date de recrutement", value: fr(employee.hireDate) },
    { label: "Direction", value: employee.department?.trim() || MANQUANT },
    { label: "Date de la demande", value: fr(request.createdAt) },
    { label: "Nombre de jours demandés", value: `${request.days}` },
    { label: "Date de départ", value: fr(request.startDate) },
    { label: "Date de reprise", value: fr(resumeDate(request.endDate)) },
    { label: "N° de téléphone", value: (request.phone ?? employee.phone)?.trim() || MANQUANT },
    { label: "Intérim choisi", value: describeStandIn(request.standInName, request.standInStatus) },
  ];
}

/** La même fiche en texte — pour une notification, un export ou un e-mail. */
export function leaveSheetText(employee: LeaveSheetEmployee, request: LeaveSheetRequest): string {
  return buildLeaveSheet(employee, request).map((l) => `${l.label}: ${l.value}`).join("\n");
}
