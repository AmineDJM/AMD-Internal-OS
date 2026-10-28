import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import type { BadgeTone } from "@/lib/labels";
import { FIELD_REPORT_STATUS } from "@/lib/labels";
import { platformScope, predicatEntitePermise } from "@/lib/company";
import { peutSupprimerLeRapport, viewsAllReports } from "@/lib/queries/field-reports";
import { clauseCasPvVisibles, signaleDesCasPv, voitTousLesCasPv } from "@/lib/pharmacovigilance/acces";
import { STATUT_PV, estStatutPv } from "@/lib/pharmacovigilance/regles";
import { lienCasPvKam, lienRapportTerrain } from "@/lib/chemins/rapports-terrain";
import { sansBloquer } from "@/lib/journal";
import { plier } from "@/lib/utils";

/**
 * LA LISTE DES RAPPORTS TERRAIN — l'onglet « Rapports » de la Promotion médicale (Direction, 07/10).
 *
 * ── TROIS SOURCES, UNE LISTE ────────────────────────────────────────────────────────────────
 *
 * Un « rapport terrain » est aujourd'hui, en base :
 *   • une VISITE rapportée (`MedicalVisit` COMPLETED, avec son compte rendu, ses produits, ses messages) — le geste du
 *     planning et de « Ma journée » ; planifiée → « Visite », imprévue → « Sans visite » (hors plan) ;
 *   • un COMPTE RENDU vocal sans visite (`FieldReport`, `visitId` nul) — l'ancien geste « Nouveau rapport (Parler) » ;
 *     celui qui DOCUMENTE une visite ne fait pas une seconde ligne : il est rattaché à la ligne de la visite ;
 *   • un SIGNALEMENT de pharmacovigilance (`PharmacovigilanceCase`), parti du même planning.
 *
 * ── QUI VOIT QUOI — les règles d'hier, pas une nouvelle ────────────────────────────────────
 *
 *   • visites et comptes rendus : la règle de l'ancienne liste des Rapports terrain (`viewsAllReports` : la Direction,
 *     les managers et le superviseur national voient tout ; les autres, les leurs), plus la portée d'entité des
 *     comptes rendus (`platformScope`) ;
 *   • signalements : la règle de la pharmacovigilance (`clauseCasPvVisibles` : qui reçoit les cas les voit tous ; le
 *     déclarant, les siens et ceux où on l'a ajouté), et seulement pour qui signale ou reçoit des cas.
 */

export type TypeRapport = "VISITE" | "SANS_VISITE" | "PV";

export const TYPE_RAPPORT_LABELS: Record<TypeRapport, string> = {
  VISITE: "Visite",
  SANS_VISITE: "Sans visite",
  PV: "Pharmacovigilance",
};

export interface LigneRapport {
  /** `v:<id>` (visite), `r:<id>` (compte rendu), `pv:<id>` (signalement). */
  cle: string;
  type: TypeRapport;
  /** Le libellé du type (`TYPE_RAPPORT_LABELS`), posé ici : l'écran n'importe pas ce module serveur. */
  typeLibelle: string;
  /** ISO — le jour de la visite, du compte rendu, ou de la survenue du cas. */
  date: string;
  delegue: string | null;
  professionnel: string | null;
  etablissement: string | null;
  specialite: string | null;
  produits: string[];
  messages: string[];
  etat: { label: string; tone: BadgeTone };
  /** Le compte rendu (ou la description du cas). */
  texte: string | null;
  retour: string | null;
  suite: string | null;
  /** « Demandée par la Direction », « Imprévue », « Vocal »… — la nuance de la ligne, en un mot. */
  precision: string | null;
  /** La fiche à ouvrir : compte rendu vocal (relecture, validation, pièces) ou cas de pharmacovigilance. */
  lien: string | null;
  libelleLien: string | null;
  /** Le compte rendu vocal (`FieldReport`) que l'on peut supprimer depuis la feuille — la règle de l'action. */
  suppression: { id: string; nom: string } | null;
}

export interface FiltresRapports {
  du: string;
  au: string;
  delegue: string;
  bu: string;
  q: string;
}

export interface ListeRapports {
  lignes: LigneRapport[];
  filtres: FiltresRapports;
  /** Vrai quand la personne voit les rapports de tous : les filtres « délégué » et « BU » n'ont de sens que là. */
  toutVoir: boolean;
  delegues: { id: string; nom: string }[];
  bus: { id: string; nom: string }[];
  /** La liste a atteint son plafond : resserrer la période. */
  tronquee: boolean;
}

const PLAFOND = 300;
const JOUR = /^\d{4}-\d{2}-\d{2}$/;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const texteDe = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Les filtres lus dans l'adresse — une date mal formée retombe sur la période par défaut (les 30 derniers jours). */
export function lireFiltresRapports(sp: Record<string, string | string[] | undefined> | undefined, maintenant = new Date()): FiltresRapports {
  const v = (k: string) => texteDe(Array.isArray(sp?.[k]) ? sp?.[k]?.[0] : sp?.[k]);
  const debut = new Date(maintenant);
  debut.setDate(debut.getDate() - 30);
  const du = JOUR.test(v("du")) ? v("du") : iso(debut);
  const au = JOUR.test(v("au")) ? v("au") : iso(maintenant);
  return { du, au: au < du ? du : au, delegue: v("delegue"), bu: v("bu"), q: v("q").slice(0, 100) };
}

export async function chargerListeRapports(user: SessionUser, filtres: FiltresRapports): Promise<ListeRapports> {
  const toutVoir = viewsAllReports(user);
  const gte = new Date(`${filtres.du}T00:00:00`);
  const lte = new Date(`${filtres.au}T23:59:59.999`);

  // LE PÉRIMÈTRE DES DÉLÉGUÉS : soi-même, ou (vue d'ensemble) le délégué / la BU choisis.
  let delegues: string[] | null = toutVoir ? null : [user.id];
  if (toutVoir && filtres.bu) {
    const profils = await prisma.salesRepProfile.findMany({ where: { businessUnitId: filtres.bu }, select: { repId: true } });
    delegues = profils.map((p) => p.repId);
  }
  if (toutVoir && filtres.delegue) delegues = delegues ? delegues.filter((d) => d === filtres.delegue) : [filtres.delegue];
  const parDelegue = delegues ? { in: delegues } : undefined;

  const voitLesCas = signaleDesCasPv(user) || voitTousLesCasPv(user);
  const clauseCas: Prisma.PharmacovigilanceCaseWhereInput = {
    AND: [clauseCasPvVisibles(user), { occurredOn: { gte, lte } }, ...(parDelegue ? [{ reporterId: parDelegue }] : [])],
  };

  const [visites, comptesRendus, cas, entitePermise] = await Promise.all([
    prisma.medicalVisit.findMany({
      where: { status: "COMPLETED", date: { gte, lte }, ...(parDelegue ? { delegateId: parDelegue } : {}) },
      orderBy: { date: "desc" },
      take: PLAFOND,
      select: {
        id: true, date: true, origin: true, objective: true, report: true, doctorFeedback: true, followUpActions: true,
        delegate: { select: { name: true } },
        doctor: { select: { name: true, specialty: true, institution: true, institutionRef: { select: { name: true } } } },
        productLinks: { select: { product: { select: { canonicalName: true } } } },
        messageLinks: { select: { message: { select: { title: true } } } },
        fieldReports: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.fieldReport.findMany({
      where: { AND: [{ visitId: null, visitDate: { gte, lte } }, parDelegue ? { delegateId: parDelegue } : {}, await platformScope(user.id)] },
      orderBy: { visitDate: "desc" },
      take: PLAFOND,
      select: {
        id: true, status: true, visitDate: true, delegateId: true, companyId: true, doctorName: true, institution: true, specialty: true,
        products: true, summary: true, transcript: true, nextAction: true,
        delegate: { select: { name: true } },
        doctor: { select: { name: true, institution: true, institutionRef: { select: { name: true } } } },
      },
    }),
    voitLesCas
      ? prisma.pharmacovigilanceCase.findMany({
          where: clauseCas,
          orderBy: { occurredOn: "desc" },
          take: PLAFOND,
          select: {
            id: true, reference: true, status: true, occurredOn: true, reporterId: true, productLabel: true,
            institutionName: true, doctorName: true, description: true,
          },
        })
      : Promise.resolve([]),
    predicatEntitePermise(user.id),
  ]);

  const declarants = new Map(
    cas.length
      ? (await prisma.user.findMany({ where: { id: { in: [...new Set(cas.map((c) => c.reporterId))] } }, select: { id: true, name: true } }))
          .map((u) => [u.id, u.name] as const)
      : [],
  );

  type Brute = Omit<LigneRapport, "typeLibelle">;
  const brutes: Brute[] = [
    ...visites.map((v): Brute => ({
      cle: `v:${v.id}`,
      type: v.origin === "UNPLANNED" ? "SANS_VISITE" : "VISITE",
      date: v.date.toISOString(),
      delegue: v.delegate?.name ?? null,
      professionnel: v.doctor?.name ?? null,
      etablissement: v.doctor?.institutionRef?.name ?? v.doctor?.institution ?? null,
      specialite: v.doctor?.specialty ?? null,
      produits: v.productLinks.map((l) => l.product.canonicalName),
      messages: v.messageLinks.map((l) => l.message.title),
      etat: { label: "Rapporté", tone: "success" },
      texte: v.report,
      retour: v.doctorFeedback,
      suite: v.followUpActions,
      precision: v.origin === "DIRECTION" ? `Demandée par la Direction${v.objective ? ` — ${v.objective}` : ""}`
        : v.origin === "UNPLANNED" ? "Rencontre hors plan" : null,
      lien: v.fieldReports[0] ? lienRapportTerrain(v.fieldReports[0].id) : null,
      libelleLien: v.fieldReports[0] ? "Écouter / relire le vocal" : null,
      suppression: null,
    })),
    ...comptesRendus.map((r): Brute => {
      const professionnel = r.doctor?.name ?? r.doctorName;
      return {
        cle: `r:${r.id}`,
        type: "SANS_VISITE",
        date: r.visitDate.toISOString(),
        delegue: r.delegate?.name ?? null,
        professionnel,
        etablissement: r.doctor?.institutionRef?.name ?? r.institution ?? r.doctor?.institution ?? null,
        specialite: r.specialty,
        produits: (r.products ?? "").split(/[,;/]/).map((s) => s.trim()).filter(Boolean),
        messages: [],
        etat: FIELD_REPORT_STATUS[r.status] ? { label: FIELD_REPORT_STATUS[r.status].label, tone: FIELD_REPORT_STATUS[r.status].tone } : { label: r.status, tone: "neutral" },
        texte: r.summary ?? r.transcript,
        retour: null,
        suite: r.nextAction,
        precision: "Compte rendu vocal",
        lien: lienRapportTerrain(r.id),
        libelleLien: "Ouvrir le compte rendu",
        suppression: peutSupprimerLeRapport(user, r, entitePermise(r.companyId))
          ? { id: r.id, nom: `${professionnel || "Rapport"}${r.delegate?.name ? ` — ${r.delegate.name}` : ""} · ${r.visitDate.toLocaleDateString("fr-FR")}` }
          : null,
      };
    }),
    ...cas.map((c): Brute => ({
      cle: `pv:${c.id}`,
      type: "PV",
      date: c.occurredOn.toISOString(),
      delegue: declarants.get(c.reporterId) ?? null,
      professionnel: c.doctorName,
      etablissement: c.institutionName,
      specialite: null,
      produits: [c.productLabel],
      messages: [],
      etat: estStatutPv(c.status) ? { label: STATUT_PV[c.status].label, tone: STATUT_PV[c.status].tone } : { label: c.status, tone: "neutral" },
      texte: c.description,
      retour: null,
      suite: null,
      precision: c.reference,
      lien: lienCasPvKam(c.id),
      libelleLien: "Ouvrir le cas",
      suppression: null,
    })),
  ];

  const lignes: LigneRapport[] = brutes.map((l) => ({ ...l, typeLibelle: TYPE_RAPPORT_LABELS[l.type] }));

  // LA RECHERCHE porte sur ce que la ligne montre — praticien, établissement, délégué, produits, compte rendu.
  const q = plier(filtres.q);
  const filtrees = (q
    ? lignes.filter((l) => plier([l.professionnel, l.etablissement, l.delegue, l.specialite, l.texte, l.precision, ...l.produits, ...l.messages].filter(Boolean).join(" ")).includes(q))
    : lignes
  ).sort((a, b) => b.date.localeCompare(a.date));

  const [optionsDelegues, optionsBus] = toutVoir
    ? await Promise.all([
        prisma.salesRepProfile.findMany({ select: { repId: true } }).then(async (ps) =>
          ps.length
            ? prisma.user.findMany({ where: { id: { in: ps.map((p) => p.repId) } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
            : []),
        prisma.businessUnit.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ])
    : [[], []];

  // LE DÉLÉGUÉ CHOISI par l'adresse (`?delegue=` — « Voir ses rapports » de Mon Équipe, de la Force de vente) doit se lire
  // sur la liste même s'il n'a pas de profil de force de vente : sans lui dans le menu, le filtre s'appliquerait en silence.
  // Seulement pour qui voit les rapports de tous — pour les autres, le filtre est ignoré (la liste reste la leur).
  const menuDelegues = optionsDelegues.map((u) => ({ id: u.id, nom: u.name }));
  if (toutVoir && filtres.delegue && !menuDelegues.some((d) => d.id === filtres.delegue)) {
    const choisi = await prisma.user.findUnique({ where: { id: filtres.delegue }, select: { id: true, name: true } }).catch(sansBloquer("rapports-terrain-liste.chargerListeRapports.user", null));
    if (choisi) menuDelegues.push({ id: choisi.id, nom: choisi.name });
  }

  return {
    lignes: filtrees.slice(0, PLAFOND),
    filtres,
    toutVoir,
    delegues: menuDelegues,
    bus: optionsBus.map((b) => ({ id: b.id, nom: b.name })),
    tronquee: filtrees.length > PLAFOND || visites.length === PLAFOND || comptesRendus.length === PLAFOND || cas.length === PLAFOND,
  };
}
