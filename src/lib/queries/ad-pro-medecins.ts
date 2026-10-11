import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CHEMIN_DEMANDE, LIBELLE_NATURE_DEMANDE, demandeAbandonnee, montantAttribuable, estRoleMedecin,
  type RoleMedecin, type TypeMedecinsConcernes,
} from "@/lib/ad-pro/medecins-concernes";

/**
 * LES MÉDECINS CONCERNÉS PAR LES DEMANDES AD & PRO — la lecture unique (Direction, 08/10).
 *
 * Le lien générique `AdProMedecin` désigne un praticien de l'annuaire pour n'importe quelle demande ; les congrès portaient déjà
 * le leur (invités `invitedDoctorIds`, prises en charge `CareBeneficiary`) : ils sont LUS tels quels et s'additionnent, jamais
 * copiés — deux vérités sur le même invité finiraient par diverger (§118.5). Le cockpit marketing, la fiche du praticien et
 * la carte de la demande lisent ICI.
 */

export interface MedecinConcerne {
  doctorId: string;
  nom: string;
  specialite: string | null;
  etablissement: string | null;
  role: RoleMedecin;
  /** Montant attribuable à ce praticien (DZD), saisi sur son lien. */
  montant: number | null;
  /**
   * LIEN = rattaché ici, modifiable ; INVITE_CONGRES / PRISE_EN_CHARGE / ORIGINE_DEMANDE = lu du congrès, modifiable dans le
   * congrès. ORIGINE_DEMANDE : le médecin à l'origine d'une « initiative du médecin » — concerné, sans être pris en charge.
   */
  source: "LIEN" | "INVITE_CONGRES" | "PRISE_EN_CHARGE" | "ORIGINE_DEMANDE";
}

const FICHE_MEDECIN = {
  id: true, name: true, specialty: true, institution: true,
  specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } },
} satisfies Prisma.MedicalDoctorSelect;

type FicheMedecin = Prisma.MedicalDoctorGetPayload<{ select: typeof FICHE_MEDECIN }>;

const identite = (d: FicheMedecin) => ({
  doctorId: d.id, nom: d.name,
  specialite: d.specialtyRef?.name ?? d.specialty ?? null,
  etablissement: d.institutionRef?.name ?? d.institution ?? null,
});

/** Les médecins d'UNE demande : les liens, plus — pour un congrès — ses invités et ses prises en charge. Sans doublon. */
export async function medecinsConcernesDe(entityType: TypeMedecinsConcernes, entityId: string): Promise<MedecinConcerne[]> {
  const liens = await prisma.adProMedecin.findMany({
    where: { entityType, entityId }, orderBy: { createdAt: "asc" },
    select: { role: true, montant: true, doctor: { select: FICHE_MEDECIN } },
  });
  const out: MedecinConcerne[] = liens.map((l) => ({
    ...identite(l.doctor), role: estRoleMedecin(l.role) ? l.role : "AUTRE",
    montant: l.montant === null ? null : Number(l.montant), source: "LIEN",
  }));
  const deja = new Set(out.map((m) => m.doctorId));

  if (entityType === "CONGRESS_NATIONAL" || entityType === "CONGRESS_INTERNATIONAL") {
    const cle = entityType === "CONGRESS_NATIONAL" ? "congressNationalId" : "congressInternationalId";
    const [congres, prises] = await Promise.all([
      entityType === "CONGRESS_NATIONAL"
        ? prisma.congressNational.findUnique({ where: { id: entityId }, select: { invitedDoctorIds: true, initiativeDoctorIds: true } })
        : prisma.congressInternational.findUnique({ where: { id: entityId }, select: { invitedDoctorIds: true, initiativeDoctorIds: true } }),
      prisma.careBeneficiary.findMany({
        where: { [cle]: entityId, doctorId: { not: null }, status: { notIn: ["REJECTED", "WITHDRAWN"] } },
        select: { doctorId: true },
      }),
    ]);
    const invites = (congres?.invitedDoctorIds ?? []).filter((id) => !deja.has(id));
    const pris = prises.map((p) => p.doctorId!).filter((id) => !deja.has(id) && !invites.includes(id));
    // Les médecins À L'ORIGINE de la demande (initiative du médecin) — sans doublon avec les invités et les pris en charge.
    const origine = (congres?.initiativeDoctorIds ?? []).filter((id) => !deja.has(id) && !invites.includes(id) && !pris.includes(id));
    const ids = [...new Set([...invites, ...pris, ...origine])];
    if (ids.length) {
      const fiches = await prisma.medicalDoctor.findMany({ where: { id: { in: ids } }, select: FICHE_MEDECIN });
      const parId = new Map(fiches.map((f) => [f.id, f]));
      for (const id of ids) {
        const f = parId.get(id);
        if (!f) continue;
        const invite = invites.includes(id);
        const aLOrigine = !invite && !pris.includes(id);
        out.push({
          ...identite(f), role: invite ? "INVITE" : aLOrigine ? "AUTRE" : "BENEFICIAIRE", montant: null,
          source: invite ? "INVITE_CONGRES" : aLOrigine ? "ORIGINE_DEMANDE" : "PRISE_EN_CHARGE",
        });
      }
    }
  }
  return out.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

/** Une demande Ad & Pro qui désigne un praticien, avec ce qu'il faut pour la lire (nom, date, argent, adresse). */
export interface LienAdPro {
  doctorId: string;
  nature: TypeMedecinsConcernes;
  entityId: string;
  /** « Sponsoring Association X », « Congrès Y »… */
  nom: string;
  natureLibelle: string;
  date: Date;
  statut: string;
  role: RoleMedecin;
  /** Attribuable à CE praticien (voir `montantAttribuable`) — null si rien. */
  investi: number | null;
  href: string;
}

interface Demande { nom: string; date: Date; statut: string; businessUnitId: string | null; montantAccorde: number | null }

/** Les demandes désignées par des liens, par nature puis identifiant. Une demande introuvable (supprimée) est écartée. */
async function lireDemandes(parNature: Map<TypeMedecinsConcernes, string[]>): Promise<Map<string, Demande>> {
  const ids = (n: TypeMedecinsConcernes) => ({ id: { in: parNature.get(n) ?? [] } });
  const veut = (n: TypeMedecinsConcernes) => (parNature.get(n)?.length ?? 0) > 0;
  const [spo, ev, cn, ci, pm, ao] = await Promise.all([
    veut("SPONSORING") ? prisma.sponsoringRequest.findMany({ where: ids("SPONSORING"), select: { id: true, institution: true, type: true, requestDate: true, status: true, amountGranted: true, businessUnitId: true } }) : [],
    veut("EVENT") ? prisma.event.findMany({ where: ids("EVENT"), select: { id: true, name: true, startDate: true, createdAt: true, status: true, businessUnitId: true } }) : [],
    veut("CONGRESS_NATIONAL") ? prisma.congressNational.findMany({ where: ids("CONGRESS_NATIONAL"), select: { id: true, name: true, date: true, createdAt: true, status: true, businessUnitId: true } }) : [],
    veut("CONGRESS_INTERNATIONAL") ? prisma.congressInternational.findMany({ where: ids("CONGRESS_INTERNATIONAL"), select: { id: true, name: true, startDate: true, createdAt: true, status: true, businessUnitId: true } }) : [],
    veut("PROMO_MATERIAL") ? prisma.promoMaterial.findMany({ where: ids("PROMO_MATERIAL"), select: { id: true, title: true, createdAt: true, status: true, businessUnitId: true } }) : [],
    veut("AD_PRO_OTHER") ? prisma.adProOtherRequest.findMany({ where: ids("AD_PRO_OTHER"), select: { id: true, title: true, createdAt: true, status: true, businessUnitId: true } }) : [],
  ]);
  const out = new Map<string, Demande>();
  const put = (n: TypeMedecinsConcernes, id: string, d: Demande) => out.set(`${n}:${id}`, d);
  for (const s of spo) put("SPONSORING", s.id, { nom: `Sponsoring ${s.type}`.trim() + ` — ${s.institution}`, date: s.requestDate, statut: String(s.status), businessUnitId: s.businessUnitId, montantAccorde: s.amountGranted === null ? null : Number(s.amountGranted) });
  for (const e of ev) put("EVENT", e.id, { nom: e.name, date: e.startDate ?? e.createdAt, statut: String(e.status), businessUnitId: e.businessUnitId, montantAccorde: null });
  for (const c of cn) put("CONGRESS_NATIONAL", c.id, { nom: `Congrès ${c.name}`, date: c.date ?? c.createdAt, statut: String(c.status), businessUnitId: c.businessUnitId, montantAccorde: null });
  for (const c of ci) put("CONGRESS_INTERNATIONAL", c.id, { nom: `Congrès ${c.name}`, date: c.startDate ?? c.createdAt, statut: String(c.status), businessUnitId: c.businessUnitId, montantAccorde: null });
  for (const p of pm) put("PROMO_MATERIAL", p.id, { nom: p.title, date: p.createdAt, statut: String(p.status), businessUnitId: p.businessUnitId, montantAccorde: null });
  for (const a of ao) put("AD_PRO_OTHER", a.id, { nom: a.title, date: a.createdAt, statut: String(a.status), businessUnitId: a.businessUnitId, montantAccorde: null });
  return out;
}

/**
 * LES DEMANDES AD & PRO QUI DÉSIGNENT CES PRATICIENS, depuis `depuis` (la date de la demande : requête pour un sponsoring, tenue
 * pour un événement ou un congrès, création sinon). Les demandes refusées ou annulées sont écartées. Les congrès s'y ajoutent
 * par leurs invités et prises en charge — lus, pas copiés.
 */
export async function chargerLiensAdPro(doctorIds: readonly string[], depuis: Date | null): Promise<LienAdPro[]> {
  if (doctorIds.length === 0) return [];
  const [liens, invitesN, invitesI, prises] = await Promise.all([
    prisma.adProMedecin.findMany({ where: { doctorId: { in: [...doctorIds] } }, select: { doctorId: true, entityType: true, entityId: true, role: true, montant: true } }),
    prisma.congressNational.findMany({ where: { invitedDoctorIds: { hasSome: [...doctorIds] }, ...(depuis ? { createdAt: { gte: depuis } } : {}) }, select: { id: true, invitedDoctorIds: true } }),
    prisma.congressInternational.findMany({ where: { invitedDoctorIds: { hasSome: [...doctorIds] }, ...(depuis ? { createdAt: { gte: depuis } } : {}) }, select: { id: true, invitedDoctorIds: true } }),
    prisma.careBeneficiary.findMany({
      where: { doctorId: { in: [...doctorIds] }, status: { notIn: ["REJECTED", "WITHDRAWN"] }, OR: [{ congressNationalId: { not: null } }, { congressInternationalId: { not: null } }], ...(depuis ? { createdAt: { gte: depuis } } : {}) },
      select: { doctorId: true, congressNationalId: true, congressInternationalId: true },
    }),
  ]);

  // Un lien par (nature, demande, praticien) : le lien explicite l'emporte sur la lecture du congrès.
  const lignes = new Map<string, { doctorId: string; nature: TypeMedecinsConcernes; entityId: string; role: RoleMedecin; montant: number | null }>();
  const cle = (n: string, e: string, d: string) => `${n}:${e}:${d}`;
  const voulus = new Set(doctorIds);
  for (const l of liens) {
    if (!(l.entityType in CHEMIN_DEMANDE)) continue;
    lignes.set(cle(l.entityType, l.entityId, l.doctorId), {
      doctorId: l.doctorId, nature: l.entityType as TypeMedecinsConcernes, entityId: l.entityId,
      role: estRoleMedecin(l.role) ? l.role : "AUTRE", montant: l.montant === null ? null : Number(l.montant),
    });
  }
  const ajouterCongres = (nature: TypeMedecinsConcernes, entityId: string, doctorId: string | null, role: RoleMedecin) => {
    if (!doctorId || !voulus.has(doctorId) || lignes.has(cle(nature, entityId, doctorId))) return;
    lignes.set(cle(nature, entityId, doctorId), { doctorId, nature, entityId, role, montant: null });
  };
  for (const c of invitesN) for (const d of c.invitedDoctorIds) ajouterCongres("CONGRESS_NATIONAL", c.id, d, "INVITE");
  for (const c of invitesI) for (const d of c.invitedDoctorIds) ajouterCongres("CONGRESS_INTERNATIONAL", c.id, d, "INVITE");
  for (const p of prises) {
    if (p.congressNationalId) ajouterCongres("CONGRESS_NATIONAL", p.congressNationalId, p.doctorId, "BENEFICIAIRE");
    if (p.congressInternationalId) ajouterCongres("CONGRESS_INTERNATIONAL", p.congressInternationalId, p.doctorId, "BENEFICIAIRE");
  }

  const parNature = new Map<TypeMedecinsConcernes, string[]>();
  for (const l of lignes.values()) parNature.set(l.nature, [...new Set([...(parNature.get(l.nature) ?? []), l.entityId])]);
  const demandes = await lireDemandes(parNature);

  // Combien de praticiens la demande nomme-t-elle ? (un sponsoring qui n'en nomme qu'un lui attribue tout son accordé)
  const sponsorings = parNature.get("SPONSORING") ?? [];
  const nombre = new Map<string, number>();
  if (sponsorings.length) {
    const g = await prisma.adProMedecin.groupBy({ by: ["entityId"], where: { entityType: "SPONSORING", entityId: { in: sponsorings } }, _count: { _all: true } });
    for (const x of g) nombre.set(x.entityId, x._count._all);
  }

  const out: LienAdPro[] = [];
  for (const l of lignes.values()) {
    const d = demandes.get(`${l.nature}:${l.entityId}`);
    if (!d || demandeAbandonnee(d.statut)) continue;
    if (depuis && d.date < depuis) continue;
    out.push({
      doctorId: l.doctorId, nature: l.nature, entityId: l.entityId, nom: d.nom, natureLibelle: LIBELLE_NATURE_DEMANDE[l.nature],
      date: d.date, statut: d.statut, role: l.role,
      investi: montantAttribuable({ montant: l.montant }, { nature: l.nature, montantAccorde: d.montantAccorde, nbMedecins: nombre.get(l.entityId) ?? 1 }),
      href: `${CHEMIN_DEMANDE[l.nature]}/${l.entityId}`,
    });
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/**
 * LES MÉDECINS D'UNE DEMANDE, par identifiant de demande — pour la lettre H·A·B de la dépense (cockpit › Investissements).
 * Clé `nature:identifiant`.
 */
export async function medecinsParDemande(
  demandes: readonly { nature: TypeMedecinsConcernes; id: string }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (demandes.length === 0) return out;
  const liens = await prisma.adProMedecin.findMany({
    where: { OR: (["SPONSORING", "EVENT", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"] as const).flatMap((n) => {
      const ids = demandes.filter((d) => d.nature === n).map((d) => d.id);
      return ids.length ? [{ entityType: n, entityId: { in: ids } }] : [];
    }) },
    select: { entityType: true, entityId: true, doctorId: true },
  });
  for (const l of liens) {
    const k = `${l.entityType}:${l.entityId}`;
    out.set(k, [...new Set([...(out.get(k) ?? []), l.doctorId])]);
  }
  return out;
}
