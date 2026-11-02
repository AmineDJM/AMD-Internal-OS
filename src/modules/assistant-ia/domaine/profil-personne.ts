/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * S1 (décision 0048) — LE PROFIL DE LA PERSONNE : à qui l'assistant parle. Règle PURE (aucune base) : le moteur la met
 * dans la consigne, l'écran d'accueil et « Ce que son assistant voit » la lisent.
 *
 * « Ouvert dans le compte d'un employé, il sait déjà à qui il s'adresse — connecté au collaborateur, à son contrat, à
 * son profil, à ses accès. » (Direction, 02/11). Le profil est construit par le SERVEUR, à chaque tour, depuis le compte
 * de la session et la fiche RH LIÉE à ce compte — jamais d'une mémoire, d'un historique ou d'une autre personne. Il est
 * petit (≈ 100–200 jetons) : une ligne par fait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { AvenantLu, PerimetreSensible } from "./perimetres";
import { LIBELLE_ORIGINE } from "./perimetres";
import { LIBELLE_FAMILLE, type FamilleIa } from "./acces-regles";

export type Adresse = "TU" | "VOUS";
export const adresseDe = (v: unknown): Adresse => (v === "TU" ? "TU" : "VOUS");

/**
 * Le prénom pour s'adresser à la personne : le premier mot du nom qui n'est pas un NOM en capitales (« Radia KEBIR »,
 * « KEBIR Radia » → « Radia ») ; à défaut, le premier mot.
 */
export function prenomDe(nom: string | null | undefined): string {
  const mots = (nom ?? "").trim().split(/\s+/).filter((m) => m && !/^_+/.test(m));
  const prenom = mots.find((m) => /\p{Ll}/u.test(m)) ?? mots[0] ?? "";
  return prenom.replace(/[,;.]+$/, "");
}

export interface ProfilPersonne {
  userId: string;
  nom: string;
  prenom: string;
  adresse: Adresse;
  role: string;
  roleSecondaire: string | null;
  /** NULL : aucune fiche RH liée au compte. */
  fiche: null | {
    poste: string | null;
    fonction: string | null;
    fonctionOrigine: "CONTRAT" | "AVENANT";
    departement: string | null;
    entite: string | null;
    responsable: string | null;
    contrat: { type: string | null; debut: string | null; fin: string | null; enVigueur: boolean };
    avenants: { objet: string; libelle: string; du: string; au: string | null }[];
  };
  famillesOuvertes: FamilleIa[];
  perimetres: PerimetreSensible[];
  superAdmin?: boolean;
}

const jour = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

/** Un avenant en une ligne lisible (« Délégation « Salaires & paie » — Pharmagène »). */
export function libelleAvenant(a: AvenantLu, entites: ReadonlyMap<string, string>): string {
  if (a.objet === "FONCTION") return `Changement de fonction : ${a.fonction ?? "—"}`;
  const famille = a.famille && a.famille in LIBELLE_FAMILLE ? LIBELLE_FAMILLE[a.famille as FamilleIa] : a.famille ?? "—";
  return `Délégation « ${famille} » — ${a.companyId ? entites.get(a.companyId) ?? "entité" : "entité non précisée (sans effet)"}`;
}

/** La section de la consigne : la SEULE source sur la personne. Un autre prénom n'y a pas sa place. */
export function sectionProfil(p: ProfilPersonne, entites: ReadonlyMap<string, string> = new Map()): string {
  const l: string[] = [
    "### INTERLOCUTEUR (profil construit par le serveur à partir de SON compte et de SA fiche RH — la seule source sur la personne)",
    `Tu parles à : ${p.nom}. Adresse-toi à cette personne par son prénom « ${p.prenom || p.nom} » — JAMAIS par un autre prénom, `
      + "même si la mémoire, l'historique ou un document en cite un autre.",
    p.adresse === "TU" ? "Adresse : tutoiement (la personne l'a choisi)." : "Adresse : vouvoiement.",
    `Rôle : ${p.role}${p.roleSecondaire ? ` (rôle secondaire : ${p.roleSecondaire})` : ""}`,
  ];
  const f = p.fiche;
  if (!f) {
    l.push("Fiche RH : AUCUNE n'est liée à son compte — ni paie, ni contrat « à soi » à lire ; cela n'ouvre rien d'autrui.");
  } else {
    const champs = [
      f.fonction && `Fonction : ${f.fonction}${f.fonctionOrigine === "AVENANT" ? " (par avenant)" : ""}`,
      f.departement && `Département : ${f.departement}`, f.entite && `Entité : ${f.entite}`, f.responsable && `Responsable : ${f.responsable}`,
    ].filter(Boolean);
    if (champs.length) l.push(champs.join(" · "));
    const c = f.contrat;
    l.push(`Contrat : ${c.type ?? "type non renseigné"}${c.debut ? ` depuis le ${c.debut}` : ""}${c.fin ? `, jusqu'au ${c.fin}` : ""}${c.enVigueur ? "" : " — NON EN VIGUEUR"}`);
    if (f.avenants.length) l.push(`Avenants en vigueur :\n${f.avenants.map((a) => `- ${a.libelle} (du ${a.du}${a.au ? ` au ${a.au}` : ""})`).join("\n")}`);
  }
  if (p.superAdmin) {
    l.push("Super Admin : tous les droits (connexion réelle).");
  } else if (p.perimetres.length) {
    l.push(`Périmètres sur les données d'autrui (seuls ceux-ci, datés) :\n${p.perimetres.map((x) => `- « ${LIBELLE_FAMILLE[x.famille]} » — ${x.companyId ? entites.get(x.companyId) ?? "une entité" : "entités qui lui sont ouvertes"} (${LIBELLE_ORIGINE[x.origine].toLowerCase()}${x.au ? `, jusqu'au ${jour(x.au)}` : ""})`).join("\n")}`);
  } else {
    l.push("Données d'autrui : AUCUN périmètre nominatif — hors droit applicatif de son rôle, rien d'une autre personne (paie, contrat, dossier RH).");
  }
  return l.join("\n");
}

/** L'accueil de l'écran, au prénom et dans l'adresse choisie. */
export function accueilPour(prenom: string, adresse: Adresse): string {
  const salut = `Bonjour${prenom ? ` ${prenom}` : ""} 👋`;
  return adresse === "TU"
    ? `${salut}\n\nJe suis ton assistant interne. Je lis ce que tes accès te permettent de voir — rien de plus, rien d'un collègue — et je prépare tes demandes (sponsoring, prise en charge, événement, matériel promotionnel…), tâches et messages : rien ne part sans ta confirmation.\n\nNotre conversation est gardée : tu peux quitter cet écran pendant que je travaille, je te préviens quand c'est prêt. Tu peux aussi m'écrire plusieurs messages d'affilée — je les traite dans l'ordre.\n\nQu'est-ce que je peux faire pour toi ?`
    : `${salut}\n\nJe suis votre assistant interne. Je lis ce que vos accès vous permettent de voir — rien de plus, rien d'un collègue — et je prépare vos demandes (sponsoring, prise en charge, événement, matériel promotionnel…), tâches et messages : rien ne part sans votre confirmation.\n\nNotre conversation est gardée : vous pouvez quitter cet écran pendant que je travaille, je vous préviens quand c'est prêt. Vous pouvez aussi m'écrire plusieurs messages d'affilée — je les traite dans l'ordre, sans en perdre aucun.\n\nComment puis-je vous aider ?`;
}

/** S1 — « Ce que son assistant voit » (console `/admin/ai/acces`) : le profil, la consigne exacte, l'historique des droits. */
export interface ApercuAssistant {
  profil: ProfilPersonne;
  /** La section « INTERLOCUTEUR » telle que le modèle la reçoit. */
  consigne: string;
  assistantOuvert: boolean;
  entites: { id: string; nom: string }[];
  avenants: { id: string; objet: string; fonction: string | null; famille: string | null; companyId: string | null; effetLe: string; finLe: string | null; motif: string; revoqueLe: string | null }[];
  droits: { id: string; famille: string; companyId: string | null; du: string; au: string | null; motif: string; revoqueLe: string | null }[];
}
