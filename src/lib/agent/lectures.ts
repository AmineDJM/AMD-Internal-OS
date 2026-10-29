import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { derniersMessagesParConversation } from "@/lib/queries/messaging";
import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { REFUS_SECONDE_CARTE, type PropositionCarte } from "@/lib/agent/operations";
import { userCan } from "@/lib/rbac";
import { entitePermisePourFiche, ficheScopedWhere } from "@/lib/company";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { getBlob } from "@/lib/drive-storage";
import { formatMontant, toNumber } from "@/lib/utils";
import { HR_DOCUMENT_CATEGORY, ROLE_LABELS } from "@/lib/labels";
import { DEPENDANCES_REELLES } from "@/lib/agent/lecture/pieces";
import { CARACTERES_PAR_PIECE, couper, extensionDe, nomAnnonceLeCoffre, REFUS_COFFRE } from "@/lib/agent/lecture/regles";
import { natureSensible, REFUS_IDENTITE, REFUS_PAIE } from "@/lib/agent/operations/documents-lus";
import { familleExplicite, familleOuverte, refusFamille, type AccesIa, type FamilleIa } from "@/lib/agent/acces-regles";
import { jetonnerMontants, jetonnerTexte, jetonOuMasque, type CoffretDuTour } from "@/lib/agent/filtre-confidentialite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES DU QUOTIDIEN — CE QUI EST À LA PERSONNE, et rien d'autre.
 *
 *   • mes_conversations : SES conversations (elle en est membre), le dernier message de chacune,
 *     ce qu'elle n'a pas lu — pour savoir à quoi répondre ;
 *   • mes_demandes_en_attente : SES demandes de validation en attente, et qui doit trancher —
 *     pour relancer ;
 *   • mes_brouillons : ce qu'ELLE a commencé et pas fini — événements en brouillon, postes en
 *     brouillon, cartes de l'assistant jamais confirmées. Reprendre une carte la RÉAFFICHE
 *     (même intention : rien n'est rejoué, rien n'est dupliqué).
 *
 * Chaque requête filtre sur l'identifiant de la personne ; aucune ne lit au-delà.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const def = (name: string, description: string, properties: Record<string, unknown> = {}) =>
  ({ name, description, input_schema: { type: "object", properties } }) as PowerTool["def"];

export function lecturesQuotidien(user: CurrentUser, propositions: PropositionCarte[]): PowerTool[] {
  const a_moi = (u: CurrentUser) => u.id === user.id;
  return [
    {
      def: def("mes_conversations", "Tes conversations internes récentes : interlocuteurs, dernier message, non lus. À lire avant de répondre à un message.", {
        avec: { type: "string", description: "Filtrer par interlocuteur ou nom de groupe (facultatif)." },
      }),
      allowed: a_moi,
      label: "Conversations consultées",
      run: async (entree) => {
        const filtre = typeof entree.avec === "string" ? entree.avec.trim().toLowerCase() : "";
        const membres = await prisma.conversationMember.findMany({
          where: { userId: user.id, leftAt: null },
          select: {
            lastReadAt: true,
            conversation: {
              select: {
                id: true, title: true,
                members: { where: { leftAt: null, userId: { not: user.id } }, select: { user: { select: { name: true } } }, take: 6 },
              },
            },
          },
          take: 200,
        });
        // Les 3 derniers messages de chaque conversation, BORNÉS EN SQL : un `messages: { take: 3 }` imbriqué
        // ici rapatriait tout l'historique des 200 conversations, corps compris (audit performance PERF-08).
        const derniers = await derniersMessagesParConversation(membres.map((m) => m.conversation.id), 3);
        const lignes = membres
          .map((m) => {
            const c = m.conversation;
            const libelle = c.title || c.members.map((x) => x.user.name).join(", ") || "Conversation";
            const messages = derniers.get(c.id) ?? [];
            const dernier = messages[0];
            return {
              conversation: libelle,
              dernierMessage: dernier ? { de: dernier.senderId === user.id ? "vous" : dernier.senderName ?? "—", le: dernier.createdAt.toISOString().slice(0, 16).replace("T", " "), texte: dernier.body.slice(0, 300) } : null,
              nonLu: Boolean(dernier && dernier.senderId !== user.id && (!m.lastReadAt || dernier.createdAt > m.lastReadAt)),
              precedents: messages.slice(1).map((x) => `${x.senderId === user.id ? "vous" : x.senderName ?? "—"} : ${x.body.slice(0, 160)}`),
              _date: dernier?.createdAt.getTime() ?? 0,
            };
          })
          .filter((l) => l.dernierMessage && (!filtre || l.conversation.toLowerCase().includes(filtre)))
          .sort((a, b) => b._date - a._date)
          .slice(0, 12)
          .map(({ _date, ...l }) => l);
        return JSON.stringify({ conversations: lignes, count: lignes.length });
      },
    },
    {
      def: def("mes_demandes_en_attente", "Tes demandes de validation en attente : référence, objet, depuis quand, qui doit trancher. À lire avant une relance."),
      allowed: a_moi,
      label: "Demandes en attente consultées",
      run: async () => {
        const d = await prisma.validationRequest.findMany({
          where: { requesterId: user.id, status: "PENDING" },
          select: { reference: true, title: true, createdAt: true, steps: { where: { status: "PENDING" }, orderBy: { order: "asc" }, take: 1, select: { validator: { select: { name: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        });
        return JSON.stringify({
          demandes: d.map((x) => ({ reference: x.reference, objet: x.title, depuis: x.createdAt.toISOString().slice(0, 10), enAttenteDe: x.steps[0]?.validator.name ?? null })),
          count: d.length,
        });
      },
    },
    {
      def: def("mes_brouillons", "Ce que TU as commencé sans le finir : événements en brouillon, postes en brouillon, cartes de l'assistant jamais confirmées. Avec `reprendre` (l'identifiant d'une carte), la carte est réaffichée pour être confirmée.", {
        reprendre: { type: "string", description: "Identifiant d'une carte non confirmée à réafficher (facultatif)." },
      }),
      allowed: a_moi,
      label: "Brouillons consultés",
      run: async (entree) => {
        const reprendre = typeof entree.reprendre === "string" ? entree.reprendre.trim() : "";
        if (reprendre) {
          if (propositions.length > 0) return REFUS_SECONDE_CARTE;
          const i = await prisma.assistantActionIntent.findFirst({
            where: { id: reprendre, userId: user.id, status: "PROPOSED" },
            select: { id: true, kind: true, title: true, summary: true, payload: true, level: true, confirmText: true },
          });
          if (!i) return JSON.stringify({ statut: "REFUS", raison: "Carte introuvable, déjà confirmée ou annulée." });
          propositions.push({ intentId: i.id, proposition: { kind: i.kind, title: i.title, fields: [{ label: "Résumé", value: i.summary ?? i.title }], payload: i.payload, ...(i.level === "CRITICAL" && i.confirmText ? { level: "CRITICAL" as const, confirmText: i.confirmText } : {}) } });
          return JSON.stringify({ statut: "EN_ATTENTE_DE_CONFIRMATION", titre: i.title, consigne: "La carte est réaffichée : rien n'est rejoué avant la confirmation." });
        }
        const depuis = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        const [evenements, postes, cartes] = await Promise.all([
          prisma.event.findMany({ where: { createdById: user.id, status: "DRAFT", requestStatus: null }, select: { id: true, name: true, createdAt: true }, take: 10, orderBy: { createdAt: "desc" } }),
          prisma.adProItem.findMany({ where: { createdById: user.id, status: "DRAFT" }, select: { id: true, label: true, createdAt: true }, take: 10, orderBy: { createdAt: "desc" } }),
          prisma.assistantActionIntent.findMany({ where: { userId: user.id, status: "PROPOSED", proposedAt: { gte: depuis } }, select: { id: true, title: true, proposedAt: true }, take: 10, orderBy: { proposedAt: "desc" } }),
        ]);
        return JSON.stringify({
          evenementsEnBrouillon: evenements.map((x) => ({ nom: x.name, lien: `/events/${x.id}`, depuis: x.createdAt.toISOString().slice(0, 10) })),
          postesEnBrouillon: postes.map((x) => ({ poste: x.label, depuis: x.createdAt.toISOString().slice(0, 10) })),
          cartesNonConfirmees: cartes.map((x) => ({ identifiant: x.id, titre: x.title, depuis: x.proposedAt.toISOString().slice(0, 10) })),
          count: evenements.length + postes.length + cartes.length,
        });
      },
    },
  ];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES RH DE L'ASSISTANT IA — fiche, paie, documents d'un employé (décision 0012).
 *
 * Direction, 28/10/2026, connectée en Super Admin : « c'est quoi le salaire d'Assia ? » → « je ne peux pas
 * consulter ni communiquer le salaire individuel » ; « donne-moi son contrat » → « je n'ai pas accès ».
 * L'Assistant IA n'avait aucune de ces lectures. Elles s'ouvrent ici AVEC LES DROITS DE LA PERSONNE,
 * rien de plus, rien de moins — chacune REVÉRIFIÉE à l'exécution, quel que soit l'outil offert :
 *
 *   • FICHE : qui lit le module RH (`userCan RH VIEW`), dans une société permise (`ficheScopedWhere`) —
 *     ou la personne elle-même. Sans rémunération.
 *   • PAIE : qui GÈRE les RH (`voitLesSalaires`), dans une société permise — ou la personne elle-même.
 *     Les montants partent au modèle en REPÈRES (`⟦S1⟧`) : la révélation, au moment d'afficher, rejuge
 *     avec la politique du coffre et journalise (`fil/tour.ts` — `Revelateur`).
 *   • DOCUMENTS : la règle de la route qui les sert (`/api/rh/document/[id]`) — la personne pour ses pièces
 *     marquées visibles, ou qui gère les RH dans une société permise. L'outil rend un LIEN (la route garde
 *     ses propres contrôles) ; il peut LIRE un contrat, un avenant, une attestation — jamais un bulletin,
 *     un relevé des émoluments, une domiciliation, une pièce d'identité ni un certificat médical (le
 *     coffre, décision 0011) ; tout MONTANT lu dans la pièce devient un repère.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const dzd = (v: Parameters<typeof toNumber>[0]): string => `${formatMontant(Math.round(toNumber(v)))} DZD`;
const jour = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;
const refus = (raison: string) => JSON.stringify({ statut: "REFUS", raison });

/** Les catégories qu'on peut LIRE pour le modèle — le reste est une pièce du coffre (ou de santé). */
const CATEGORIES_LISIBLES: ReadonlySet<string> = new Set(["CONTRACT", "AMENDMENT", "WORK_CERTIFICATE", "CNAS_CERTIFICATE", "DIPLOMA", "OTHER"]);

const SELECTION = {
  id: true, fullName: true, userId: true, companyId: true, position: true, isActive: true,
} satisfies Prisma.EmployeeSelect;
type EmployeTrouve = Prisma.EmployeeGetPayload<{ select: typeof SELECTION }>;

/** « moi », « mon », vide : la personne elle-même. */
const designeSoi = (nom: string) => !nom || /^(moi|moi-m[eê]me|mon|ma|mes|je)$/i.test(nom);

/**
 * L'EMPLOYÉ DÉSIGNÉ — la personne elle-même, ou un nom cherché DANS LES SOCIÉTÉS PERMISES. Plusieurs
 * correspondances : on demande de préciser (les noms ne sont listés qu'à qui lit le module RH).
 */
async function employeDesigne(user: CurrentUser, nom: string): Promise<EmployeTrouve | { erreur: string }> {
  if (designeSoi(nom)) {
    const soi = await prisma.employee.findFirst({ where: { userId: user.id }, select: SELECTION });
    return soi ?? { erreur: "Aucune fiche RH n'est rattachée à votre compte." };
  }
  if (nom.length < 2) return { erreur: "Donnez le nom de l'employé." };
  const mots = nom.split(/\s+/).filter((m) => m.length >= 2);
  const where = await ficheScopedWhere(user.id, { AND: mots.map((m) => ({ fullName: { contains: m, mode: "insensitive" as const } })) } as Prisma.EmployeeWhereInput);
  const trouves = await prisma.employee.findMany({ where, select: SELECTION, take: 6, orderBy: [{ isActive: "desc" }, { fullName: "asc" }] });
  if (!trouves.length) return { erreur: `Aucun employé « ${nom} » dans le registre RH qui vous est ouvert.` };
  const exact = trouves.find((e) => e.fullName.toLowerCase() === nom.toLowerCase());
  if (exact) return exact;
  if (trouves.length > 1) {
    return userCan(user, "RH", "VIEW")
      ? { erreur: `Plusieurs employés correspondent à « ${nom} » : ${trouves.map((e) => e.fullName).join(", ")}. Précisez le nom complet.` }
      : { erreur: `« ${nom} » désigne plusieurs personnes : précisez le nom complet.` };
  }
  return trouves[0]!;
}

const estSoi = (user: CurrentUser, e: EmployeTrouve) => !!e.userId && e.userId === user.id;

/** Gérer les RH dans la société de la fiche — la règle des salaires et des pièces (`voitLesSalaires`, S5/S6). */
async function gereLesRhDe(user: CurrentUser, e: EmployeTrouve): Promise<boolean> {
  return voitLesSalaires(user) && (await entitePermisePourFiche(user.id, e.companyId));
}

/**
 * LE DROIT SUR LE DOSSIER D'AUTRUI — la famille de l'assistant d'abord (réglée par la Direction : un refus dit
 * laquelle et qui l'ouvre), la société de la fiche ensuite, puis le droit applicatif — ou l'ouverture EXPLICITE
 * de la famille par la Direction, qui peut aller au-delà. `null` : accordé.
 */
async function droitSurAutrui(u: CurrentUser, e: EmployeTrouve, acces: AccesIa, famille: FamilleIa, droitApplicatif: boolean, refusRegle: string): Promise<string | null> {
  if (!familleOuverte(acces, famille)) return refusFamille(famille);
  if (!(await entitePermisePourFiche(u.id, e.companyId))) return refusRegle;
  return droitApplicatif || familleExplicite(acces, famille) ? null : refusRegle;
}

export const REFUS_PAIE_AUTRUI = "La paie d'un autre salarié n'est lue que par qui gère les RH (modifier ou valider le module) dans sa société — la même règle que l'écran de la paie.";
export const REFUS_DOCUMENTS_AUTRUI = "Les documents RH d'un autre salarié ne sont ouverts qu'à qui gère les RH dans sa société — la même règle que leur téléchargement.";
export const REFUS_FICHE = "Le registre RH ne vous est pas ouvert : vous ne pouvez consulter que votre propre fiche.";

export function lecturesRh(user: CurrentUser, coffret: CoffretDuTour | null | undefined, acces: AccesIa): PowerTool[] {
  const fiche: PowerTool = {
    def: {
      name: "lire_fiche_rh",
      description:
        "Lit la FICHE RH d'un employé (ou la tienne : nom vide ou « moi ») : poste, département, responsable, société, type et dates de contrat, "
        + "embauche, solde de congés, statut, nombre de documents RH. SANS la paie (→ lire_paie). Pour « qui est le N+1 de X ? », « quand finit son contrat ? ».",
      input_schema: { type: "object", properties: { nom: { type: "string", description: "Nom (ou fragment) de l'employé ; vide = soi." } } },
    },
    allowed: (u) => u.id === user.id,
    label: "Fiche RH consultée",
    run: async (entree, u) => {
      const e = await employeDesigne(u, str(entree, "nom"));
      if ("erreur" in e) return refus(e.erreur);
      const nonFiche = estSoi(u, e) ? null : await droitSurAutrui(u, e, acces, "FICHES", userCan(u, "RH", "VIEW"), REFUS_FICHE);
      if (nonFiche) return refus(nonFiche);
      const f = await prisma.employee.findUniqueOrThrow({
        where: { id: e.id },
        select: {
          hireDate: true, contractType: true, contractStart: true, contractEnd: true, leaveBalanceDays: true, iban: true, nationalId: true,
          departmentRef: { select: { name: true } }, manager: { select: { fullName: true } },
          company: { select: { shortName: true, name: true } }, user: { select: { role: true } },
          _count: { select: { documents: true } },
        },
      });
      const titulaire = e.userId ?? null;
      return JSON.stringify({
        nom: e.fullName, poste: e.position, actif: e.isActive,
        departement: f.departmentRef?.name ?? null, responsable: f.manager?.fullName ?? null,
        entite: f.company?.shortName ?? f.company?.name ?? null,
        role: f.user ? ROLE_LABELS[f.user.role] ?? f.user.role : null,
        embaucheLe: jour(f.hireDate), contrat: f.contractType, contratDu: jour(f.contractStart),
        contratAu: jour(f.contractEnd) ?? "indéterminé / non renseigné",
        soldeCongesJours: Number(f.leaveBalanceDays),
        // Les colonnes du COFFRE : un repère, que la révélation juge et journalise.
        ...(f.iban ? { iban: jetonOuMasque(coffret, { valeur: f.iban, nature: "IBAN", titulaireUserId: titulaire, origine: { modele: "Employee", id: e.id, champ: "iban", brut: f.iban } }) } : {}),
        ...(f.nationalId ? { nin: jetonOuMasque(coffret, { valeur: f.nationalId, nature: "NIN", titulaireUserId: titulaire, origine: { modele: "Employee", id: e.id, champ: "nationalId", brut: f.nationalId } }) } : {}),
        documentsRh: f._count.documents,
        lien: `/rh/${e.id}`,
      });
    },
  };

  const paie: PowerTool = {
    def: {
      name: "lire_paie",
      description:
        "Lit la PAIE : avec `nom` (vide ou « moi » = soi), le salaire actuel d'une personne (base, brut, net à payer, coût employeur) et ses 6 derniers mois ; "
        + "avec `mois` (AAAA-MM), la masse salariale de ce mois. Les montants te sont rendus en REPÈRES ⟦S…⟧ : recopie-les tels quels dans ta réponse. "
        + "Réservé à qui gère les RH (et à chacun pour sa propre paie) — un refus se dit tel quel.",
      input_schema: {
        type: "object",
        properties: {
          nom: { type: "string", description: "Nom de l'employé (détail individuel) ; vide ou « moi » = soi." },
          mois: { type: "string", description: "Mois AAAA-MM (masse salariale du mois)." },
        },
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Paie consultée",
    run: async (entree, u) => {
      const mois = str(entree, "mois");
      if (mois && !str(entree, "nom")) {
        if (!familleOuverte(acces, "SALAIRES")) return refus(refusFamille("SALAIRES"));
        if (!voitLesSalaires(u) && !familleExplicite(acces, "SALAIRES")) return refus("La masse salariale n'est lue que par qui gère les RH.");
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mois)) return refus("Mois illisible (AAAA-MM).");
        const [y, m] = mois.split("-").map(Number);
        const employe = await ficheScopedWhere(u.id, {} as Prisma.EmployeeWhereInput);
        const lignes = await prisma.payrollEntry.findMany({ where: { year: y, month: m, employee: employe }, select: { employerCost: true, gross: true, net: true, status: true } });
        if (!lignes.length) return JSON.stringify({ mois, salaries: 0, constat: `Aucune ligne de paie sur ${mois} dans les sociétés qui vous sont ouvertes.` });
        const masse = lignes.reduce((s, l) => s + toNumber(l.employerCost ?? l.gross), 0);
        const net = lignes.reduce((s, l) => s + toNumber(l.net), 0);
        return JSON.stringify({
          mois, salaries: lignes.length, payes: lignes.filter((l) => l.status === "PAID").length,
          montants: { masseSalariale: jetonOuMasque(coffret, { valeur: dzd(masse), nature: "SALAIRE", titulaireUserId: null }), totalNet: jetonOuMasque(coffret, { valeur: dzd(net), nature: "SALAIRE", titulaireUserId: null }) },
          lien: "/rh/paie",
        });
      }
      const e = await employeDesigne(u, str(entree, "nom"));
      if ("erreur" in e) return refus(e.erreur);
      const nonPaie = estSoi(u, e) ? null : await droitSurAutrui(u, e, acces, "SALAIRES", voitLesSalaires(u), REFUS_PAIE_AUTRUI);
      if (nonPaie) return refus(nonPaie);
      const p = await prisma.employee.findUniqueOrThrow({
        where: { id: e.id },
        select: {
          baseSalary: true, grossSalary: true, netToPay: true, employerCost: true,
          payrolls: { orderBy: [{ year: "desc" }, { month: "desc" }], take: 6, select: { id: true, year: true, month: true, net: true, employerCost: true, gross: true, status: true, paidDate: true } },
        },
      });
      const titulaire = e.userId ?? null;
      const colonne = (champ: "baseSalary" | "grossSalary" | "netToPay" | "employerCost") => {
        const v = p[champ];
        if (v == null) return null;
        return jetonOuMasque(coffret, { valeur: dzd(v), nature: "SALAIRE", titulaireUserId: titulaire, origine: { modele: "Employee", id: e.id, champ, brut: String(v) } });
      };
      const montant = (v: Parameters<typeof dzd>[0], id: string) =>
        jetonOuMasque(coffret, { valeur: dzd(v), nature: "SALAIRE", titulaireUserId: titulaire, source: { modele: "PayrollEntry", id } });
      return JSON.stringify({
        nom: e.fullName, poste: e.position,
        ficheActuelle: { salaireBase: colonne("baseSalary"), salaireBrut: colonne("grossSalary"), salaireNet: colonne("netToPay"), employerCost: colonne("employerCost") },
        derniersMois: p.payrolls.map((l) => ({
          mois: `${l.year}-${String(l.month).padStart(2, "0")}`,
          salaireNet: montant(l.net, l.id), employerCost: montant(l.employerCost ?? l.gross, l.id),
          statut: l.status, payeLe: jour(l.paidDate),
        })),
        lien: `/rh/${e.id}`,
      });
    },
  };

  const documents: PowerTool = {
    def: {
      name: "documents_rh",
      description:
        "Les DOCUMENTS RH d'un employé (contrat, avenants, attestations, bulletins…) : liste avec, pour chacun, un LIEN de téléchargement à donner tel quel "
        + "(« donne-moi son contrat » → le lien du contrat, en lien Markdown « [Contrat de travail](/api/rh/document/…?dl=1) »). Avec `documentId` et `lire: true`, LIT le contenu d'un contrat, avenant ou attestation "
        + "(jamais un bulletin, une pièce d'identité, un RIB ni un certificat médical) — les montants y sont des REPÈRES ⟦S…⟧. Nom vide ou « moi » = soi.",
      input_schema: {
        type: "object",
        properties: {
          nom: { type: "string", description: "Nom de l'employé ; vide ou « moi » = soi." },
          nature: { type: "string", description: "Filtre facultatif : contrat, avenant, attestation, bulletin, diplôme…" },
          documentId: { type: "string", description: "Identifiant d'un document de la liste, à LIRE." },
          lire: { type: "boolean", description: "true pour lire le contenu du document `documentId`." },
        },
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Documents RH consultés",
    run: async (entree, u) => {
      const documentId = str(entree, "documentId");
      if (documentId) return lireDocumentRh(u, documentId, entree.lire === true || entree.lire === "true", coffret, acces);
      const e = await employeDesigne(u, str(entree, "nom"));
      if ("erreur" in e) return refus(e.erreur);
      const nonDocs = estSoi(u, e) ? null : await droitSurAutrui(u, e, acces, "CONTRATS_RH", voitLesSalaires(u), REFUS_DOCUMENTS_AUTRUI);
      if (nonDocs) return refus(nonDocs);
      // Ses propres pièces : celles qui lui sont visibles ; le dossier d'autrui : tout (la règle de l'écran RH).
      const gere = !estSoi(u, e) || (await gereLesRhDe(u, e));
      const filtre = categoriesDe(str(entree, "nature"));
      const docs = await prisma.employeeDocument.findMany({
        where: { employeeId: e.id, ...(gere ? {} : { visibleToEmployee: true }), ...(filtre ? { category: { in: filtre as never } } : {}) },
        select: { id: true, name: true, category: true, period: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 30,
      });
      return JSON.stringify({
        employe: e.fullName,
        documents: docs.map((d) => ({
          documentId: d.id, nom: d.name, nature: HR_DOCUMENT_CATEGORY[d.category] ?? d.category,
          ...(d.period ? { periode: d.period } : {}), deposeLe: jour(d.createdAt),
          lien: `/api/rh/document/${d.id}?dl=1`, lisible: CATEGORIES_LISIBLES.has(d.category),
        })),
        ...(docs.length ? {} : { constat: filtre ? "Aucun document de cette nature dans le dossier." : "Aucun document dans le dossier RH." }),
      });
    },
  };

  return [fiche, paie, documents];
}

const NATURES_DEMANDEES: [RegExp, string[]][] = [
  [/contrat/i, ["CONTRACT"]], [/avenant/i, ["AMENDMENT"]], [/attestation|cnas/i, ["WORK_CERTIFICATE", "CNAS_CERTIFICATE"]],
  [/bulletin|paie|fiche de paie/i, ["PAYSLIP"]], [/[ée]molument|relev/i, ["SALARY_STATEMENT"]], [/domicili|rib/i, ["DOMICILIATION"]],
  [/identit|passeport|cni/i, ["ID_DOCUMENT"]], [/dipl[oô]me/i, ["DIPLOMA"]], [/m[ée]dical/i, ["MEDICAL"]],
];
function categoriesDe(nature: string): string[] | null {
  if (!nature) return null;
  return NATURES_DEMANDEES.find(([re]) => re.test(nature))?.[1] ?? null;
}

/** LIRE une pièce du dossier RH — les droits de la route, puis les portes du coffre, puis une lecture LOCALE. */
async function lireDocumentRh(u: CurrentUser, id: string, lire: boolean, coffret: CoffretDuTour | null | undefined, acces: AccesIa): Promise<string> {
  const doc = await prisma.employeeDocument.findUnique({
    where: { id },
    select: { id: true, name: true, category: true, blobId: true, visibleToEmployee: true, employee: { select: { ...SELECTION } } },
  });
  if (!doc) return refus("Document introuvable.");
  const proprietaire = estSoi(u, doc.employee) && doc.visibleToEmployee;
  if (!proprietaire) {
    const non = estSoi(u, doc.employee)
      ? ((await gereLesRhDe(u, doc.employee)) ? null : REFUS_DOCUMENTS_AUTRUI)
      : await droitSurAutrui(u, doc.employee, acces, "CONTRATS_RH", voitLesSalaires(u), REFUS_DOCUMENTS_AUTRUI);
    if (non) return refus(non);
  }
  const lien = `/api/rh/document/${doc.id}?dl=1`;
  const base = { document: doc.name, nature: HR_DOCUMENT_CATEGORY[doc.category] ?? doc.category, employe: doc.employee.fullName, lien };
  if (!lire) return JSON.stringify(base);
  if (!CATEGORIES_LISIBLES.has(doc.category) || nomAnnonceLeCoffre(doc.name)) {
    return JSON.stringify({ ...base, lu: false, raison: REFUS_COFFRE });
  }
  const octets = await getBlob(doc.blobId);
  if (!octets) return JSON.stringify({ ...base, lu: false, raison: "Le fichier est indisponible." });
  // Lecture LOCALE (texte du fichier, OCR sur ce serveur) : rien ne part à la vision.
  const l = await DEPENDANCES_REELLES.texteLocal(extensionDe(doc.name), octets, 6);
  if (!l.texte.trim()) return JSON.stringify({ ...base, lu: false, raison: l.raisonOcr ? `Illisible ici (${l.raisonOcr}).` : "Aucun texte lisible (scan ?)." });
  const nature = natureSensible(l.texte);
  if (nature) return JSON.stringify({ ...base, lu: false, raison: nature === "IDENTITE" ? REFUS_IDENTITE : REFUS_PAIE });
  // Les MONTANTS d'un document RH sont des rémunérations : chacun devient un repère, avec son titulaire.
  const ctx = { titulaireUserId: doc.employee.userId ?? null, source: { modele: "EmployeeDocument", id: doc.id } };
  const texte = coffret ? jetonnerMontants(jetonnerTexte(l.texte, coffret, ctx), coffret, ctx) : null;
  if (texte === null) return JSON.stringify({ ...base, lu: false, raison: "Lecture réservée à la conversation de l'Assistant IA." });
  return JSON.stringify({ ...base, lu: true, ...(l.tronque ? { limite: "Lecture partielle (premières pages)." } : {}), contenu: couper(texte, CARACTERES_PAR_PIECE) });
}
