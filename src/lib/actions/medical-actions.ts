"use server";

import { CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { revalidatePath } from "next/cache";
import type { DoctorTitle, InfluenceLevel, InstitutionSector, InstitutionType, MedicalSector, Priority, SegmentLevel, VisitStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, peutAnnuaire, peutGererSpecialites, scopeMedicalDoctors } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { cleDEtablissement, indexerEtablissements } from "@/lib/annuaires/rattachement";
import { CHEMINS_SPECIALITES, cleDeSpecialite, ecritureDeSpecialite, indexerSpecialites, lienDeSpecialiteValide } from "@/lib/annuaires/specialites";
import { suivreRenommageEtablissement } from "@/lib/stocks/lieux";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdDate, fdCase, type ActionResult } from "@/lib/actions/types";
import { canonicalWilaya } from "@/lib/medical/wilaya";
import { sousVerrous } from "@/lib/promo/stock-ecriture";
import { dejaDansLaVisite, ecrireRemises, lireMaterielRemis, motifDeRemise, phraseMateriel, RefusRemise, toucheLeStock, verrousDuRapport } from "@/lib/promo/remises-visite";
import { fenetreRapport, gestesPossibles, refusVisiteHorsDelai, retraitInterditApresRevision, type StatutPlan } from "@/lib/sfe/tournee";
import { produitsDeLaBu, refusProduitsHorsBu } from "@/lib/sfe/produits-bu";
import { relierALaPersonne } from "@/lib/referentiels/personnes/double-ecriture";

const SECTORS: MedicalSector[] = ["HOSPITAL", "LIBERAL", "BOTH"];
const TITLES: DoctorTitle[] = [
  "PROFESSEUR", "MAITRE_CONFERENCES", "MAITRE_ASSISTANT", "PRATICIEN_SPECIALISTE",
  "ASSISTANT", "RESIDENT", "GENERALISTE", "PHARMACIEN", "AUTRE",
];

/** Résout le nom d'une spécialité (dénormalisé sur le médecin → la cascade
 *  Congrès qui lit `doctor.specialty` continue de fonctionner sans changement). */
async function specialtyName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const s = await prisma.medicalSpecialty.findUnique({ where: { id }, select: { name: true } });
  return s?.name ?? null;
}

/**
 * LA SPÉCIALITÉ D'UNE FICHE, lue dans un formulaire (§118.180) — la même règle que l'établissement.
 *
 * Un IDENTIFIANT du référentiel fait foi (et s'il n'existe plus, on le DIT au lieu d'écrire une clé
 * morte) ; un TEXTE seul se RÉSOUT — relié quand il désigne une spécialité du référentiel à coup
 * sûr, gardé tel quel, sans lien, sinon ; un identifiant VIDE retire la spécialité. `null` : le
 * formulaire n'en dit rien, et la fiche garde ce qu'elle porte (§118.152c).
 */
async function specialiteDuFormulaire(
  formData: FormData,
): Promise<{ ok: true; ecriture: { specialtyId: string | null; specialty: string | null } | null } | { ok: false; error: string }> {
  const choisi = fdStr(formData, "specialtyId");
  if (choisi) {
    const nom = await specialtyName(choisi);
    return nom
      ? { ok: true, ecriture: { specialtyId: choisi, specialty: nom } }
      : { ok: false, error: "Cette spécialité n'existe plus dans le référentiel — rechargez l'écran." };
  }
  if (formData.has("specialty")) {
    const referentiel = await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } });
    return { ok: true, ecriture: ecritureDeSpecialite(fdStr(formData, "specialty"), indexerSpecialites(referentiel)) };
  }
  if (formData.has("specialtyId")) return { ok: true, ecriture: { specialtyId: null, specialty: null } };
  return { ok: true, ecriture: null };
}

function parseSector(v: string | null): MedicalSector {
  return v && SECTORS.includes(v as MedicalSector) ? (v as MedicalSector) : "LIBERAL";
}
const SEGMENTS: SegmentLevel[] = ["VERY_HIGH", "HIGH", "MEDIUM", "LOW", "VERY_LOW"];
function parseSegment(v: string | null): SegmentLevel {
  return v && SEGMENTS.includes(v as SegmentLevel) ? (v as SegmentLevel) : "MEDIUM";
}
/** Mappe l'échelle 5 niveaux vers les anciens champs (cohérence des lecteurs hérités). */
const segToInfluence: Record<SegmentLevel, InfluenceLevel> = {
  VERY_HIGH: "KEY_OPINION_LEADER", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", VERY_LOW: "LOW",
};
const segToPriority: Record<SegmentLevel, Priority> = {
  VERY_HIGH: "CRITICAL", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", VERY_LOW: "LOW",
};
function parseTitle(v: string | null): DoctorTitle {
  return v && TITLES.includes(v as DoctorTitle) ? (v as DoctorTitle) : "AUTRE";
}

/**
 * LA WILAYA D'UN FORMULAIRE — le seul découpage géographique des annuaires (décision de la
 * Direction, 09/2026 : la « ville », texte libre tapé de trois façons pour le même endroit, a
 * quitté les feuilles). Vide = absence. Une casse ou un accent approximatif est RAMENÉ au nom
 * officiel ; une wilaya qui n'existe pas est REFUSÉE en nommant le remède — l'écrire telle
 * quelle ferait entrer « Algr » dans les comptages à côté d'« Alger », sans que personne ne la
 * revérifie.
 */
function parseWilaya(v: string | null): { ok: true; value: string | null } | { ok: false; error: string } {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { ok: true, value: null };
  const canon = canonicalWilaya(t);
  return canon
    ? { ok: true, value: canon }
    : { ok: false, error: `Wilaya « ${t} » inconnue : choisissez-la dans la liste des 58 wilayas.` };
}

const INSTITUTION_TYPES: InstitutionType[] = [
  "CHU", "EPH", "EHS", "CLINIQUE_PRIVEE", "POLYCLINIQUE", "CABINET", "CENTRE_SANTE", "PHARMACIE", "GROSSISTE", "AUTRE",
];
function parseInstitutionType(v: string | null): InstitutionType {
  return v && INSTITUTION_TYPES.includes(v as InstitutionType) ? (v as InstitutionType) : "AUTRE";
}
function parseInstitutionSector(v: string | null): InstitutionSector {
  return v === "PRIVE" ? "PRIVE" : "PUBLIC";
}

/** Résout le nom d'un établissement (dénormalisé sur le médecin dans `institution`). */
async function institutionName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const i = await prisma.medicalInstitution.findUnique({ where: { id }, select: { name: true } });
  return i?.name ?? null;
}

// ─────────────────────────── Établissements médicaux ───────────────────────────

export async function createInstitution(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // L'ANNUAIRE DES ÉTABLISSEMENTS (§118.147) : la Promotion médicale, OU l'annuaire ouvert en
  // « create » pour cette personne depuis la console — la même règle que l'écran.
  if (!peutAnnuaire(user, "ETABLISSEMENTS", "CREATE")) return { ok: false, error: "Non autorisé." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de l'établissement est obligatoire." };
  const wilaya = parseWilaya(fdStr(formData, "wilaya"));
  if (!wilaya.ok) return { ok: false, error: wilaya.error };
  const created = await prisma.medicalInstitution.create({
    data: {
      name,
      type: parseInstitutionType(fdStr(formData, "type")),
      sector: parseInstitutionSector(fdStr(formData, "sector")),
      wilaya: wilaya.value,
      region: fdStr(formData, "region"),
      address: fdStr(formData, "address"),
      phone: fdStr(formData, "phone"),
      email: fdStr(formData, "email"),
      notes: fdStr(formData, "notes"),
      createdById: user.id,
    },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Annuaires", entityType: "INSTITUTION", entityId: created.id, summary: `Établissement « ${name} »` });
  revalidatePath("/medical");
  return { ok: true, id: created.id };
}

/**
 * MODIFIER UN ÉTABLISSEMENT — et seulement ce que le formulaire PORTE (§118.172).
 *
 * Un champ ABSENT du formulaire garde sa valeur ; un champ présent et vide l'efface. C'est ce qui
 * permet au bouton « Désactiver / Réactiver » de la ligne d'envoyer l'identifiant et l'état, et
 * rien d'autre : avec un remplacement complet, il aurait effacé le type, la wilaya et le
 * téléphone de l'hôpital qu'on voulait seulement remettre en service (§118.152c).
 *
 * La case « actif » se lit par `fdCase` : le formulaire de la fiche pose un témoin « off » AVANT
 * la case, et `formData.get` rendait ce témoin — enregistrer un établissement actif le
 * DÉSACTIVAIT, et le réactiver était impossible.
 */
export async function updateInstitution(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // L'ANNUAIRE DES ÉTABLISSEMENTS (§118.147) : la Promotion médicale, OU l'annuaire ouvert en
  // « update » pour cette personne depuis la console — la même règle que l'écran.
  if (!peutAnnuaire(user, "ETABLISSEMENTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Établissement introuvable." };
  const avant = await prisma.medicalInstitution.findUnique({ where: { id }, select: { name: true } });
  if (!avant) return { ok: false, error: "Établissement introuvable." };
  const porte = (cle: string) => formData.has(cle);
  const nouveauNom = porte("name") ? fdStr(formData, "name") : avant.name;
  if (nouveauNom === null) return { ok: false, error: "Le nom de l'établissement ne peut pas être vide." };
  const wilaya = porte("wilaya") ? parseWilaya(fdStr(formData, "wilaya")) : null;
  if (wilaya && !wilaya.ok) return { ok: false, error: wilaya.error };
  const name = nouveauNom;
  await prisma.medicalInstitution.update({
    where: { id },
    data: {
      name,
      ...(porte("type") ? { type: parseInstitutionType(fdStr(formData, "type")) } : {}),
      ...(porte("sector") ? { sector: parseInstitutionSector(fdStr(formData, "sector")) } : {}),
      ...(wilaya ? { wilaya: wilaya.value } : {}),
      ...(porte("region") ? { region: fdStr(formData, "region") } : {}),
      ...(porte("address") ? { address: fdStr(formData, "address") } : {}),
      ...(porte("phone") ? { phone: fdStr(formData, "phone") } : {}),
      ...(porte("email") ? { email: fdStr(formData, "email") } : {}),
      ...(porte("notes") ? { notes: fdStr(formData, "notes") } : {}),
      isActive: fdCase(formData, "isActive"),
    },
  });
  // Re-synchronise le libellé dénormalisé sur les praticiens rattachés.
  await prisma.medicalDoctor.updateMany({ where: { institutionId: id }, data: { institution: name } });
  // LE LIEU DE STOCK SUIT : son nom est ce que les demandes d'état, les récurrences et Adam
  // affichent (§118.134). Deux noms pour le même hôpital finiraient par diverger (§118.5).
  await suivreRenommageEtablissement(id, name);
  // L'HISTOIRE D'UN ÉTABLISSEMENT (§118.181) : la modification n'était pas auditée du tout — un
  // hôpital renommé ou désactivé ne laissait aucune trace de qui, ni de quand.
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "INSTITUTION", entityId: id,
    summary: name !== avant.name ? `Établissement « ${avant.name} » renommé « ${name} »` : `Établissement « ${name} » modifié`,
  });
  revalidatePath("/medical");
  revalidatePath("/stocks");
  return { ok: true };
}

export async function deleteInstitution(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // L'ANNUAIRE DES ÉTABLISSEMENTS (§118.147) : la Promotion médicale, OU l'annuaire ouvert en
  // « delete » pour cette personne depuis la console — la même règle que l'écran.
  if (!peutAnnuaire(user, "ETABLISSEMENTS", "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const avant = await prisma.medicalInstitution.findUnique({ where: { id }, select: { name: true } });
  if (!avant) return { ok: false, error: "Cet établissement n'existe plus — rechargez l'écran." };
  // FK SetNull : les praticiens rattachés basculent en « Sans établissement » (non supprimés).
  await prisma.medicalInstitution.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Annuaires", entityType: "INSTITUTION", entityId: id,
    summary: `Établissement « ${avant.name} » supprimé`,
  });
  revalidatePath("/medical");
  return { ok: true };
}

// ─────────────────────────── Spécialités ───────────────────────────
//
// LE RÉFÉRENTIEL DES SPÉCIALITÉS (§118.180). Ces trois écritures existaient sans aucun écran
// (§118.14) ; l'onglet Annuaires › Spécialités les rend atteignables, et c'est en les rendant
// atteignables qu'on a lu ce qu'elles faisaient :
//  - renommer vers un nom DÉJÀ pris faisait tomber la contrainte d'unicité en erreur brute ;
//  - renommer EFFAÇAIT la couleur et les notes que le formulaire ne portait pas (§118.152c) ;
//  - supprimer EFFAÇAIT la spécialité écrite sur chaque fiche rattachée — la donnée du praticien
//    disparaissait avec l'entrée du référentiel ;
//  - rien n'était audité, sauf la création, et sans type d'entité.
// Le doublon du référentiel (« Pédiatrie » et « Pediatrie ») se refuse sur la MÊME clé que la
// résolution d'un texte (`cleDeSpecialite`) : deux règles de comparaison feraient accepter ici ce
// que la feuille ne saurait plus départager.

/** Le nom propre d'une spécialité, ou `null`. */
function nomDeSpecialite(brut: string | null): string | null {
  const nom = (brut ?? "").replace(/\s+/g, " ").trim();
  return nom ? nom : null;
}

/** Une AUTRE spécialité du référentiel qui porte déjà ce nom, à l'écriture près. */
async function specialiteHomonyme(nom: string, saufId: string | null): Promise<{ id: string; name: string } | null> {
  const cle = cleDeSpecialite(nom);
  const toutes = await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } });
  return toutes.find((s) => s.id !== saufId && cleDeSpecialite(s.name) === cle) ?? null;
}

export async function createSpecialty(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererSpecialites(user, "CREATE")) return { ok: false, error: "Non autorisé." };
  // `if (!saisi)` sur la lecture même : c'est ce que la dérivation des contrats lit comme « champ
  // OBLIGATOIRE » (§118.138) — passé par une fonction, le nom serait annoncé facultatif.
  const saisi = fdStr(formData, "name");
  if (!saisi) return { ok: false, error: "Le nom de la spécialité est obligatoire." };
  const name = nomDeSpecialite(saisi) ?? saisi;
  const homonyme = await specialiteHomonyme(name, null);
  if (homonyme) return { ok: false, error: `« ${name} » existe déjà dans le référentiel (« ${homonyme.name} »).` };
  const created = await prisma.medicalSpecialty.create({
    data: { name, color: fdStr(formData, "color"), notes: fdStr(formData, "notes"), createdById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Annuaires",
    entityType: "SPECIALTY", entityId: created.id, summary: `Spécialité « ${name} » ajoutée au référentiel`,
  });
  for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  revalidatePath("/medical");
  return { ok: true, id: created.id };
}

export async function updateSpecialty(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererSpecialites(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const avant = await prisma.medicalSpecialty.findUnique({ where: { id }, select: { name: true } });
  if (!avant) return { ok: false, error: "Cette spécialité n'existe plus — rechargez l'écran." };

  // CE QUE LE FORMULAIRE NE PORTE PAS NE S'ÉCRIT PAS (§118.152c) : renommer ne doit effacer ni la
  // couleur ni les notes. Les clés se lisent EN LITTÉRAL, pour que la fiche de l'action les dise.
  const data: { name?: string; color?: string | null; notes?: string | null } = {};
  if (formData.has("name")) {
    const name = nomDeSpecialite(fdStr(formData, "name"));
    if (!name) return { ok: false, error: "Le nom de la spécialité ne peut pas être vide." };
    if (name !== avant.name) {
      const homonyme = await specialiteHomonyme(name, id);
      if (homonyme) {
        return { ok: false, error: `« ${name} » existe déjà dans le référentiel (« ${homonyme.name} ») : fusionnez les deux plutôt que de les renommer pareil.` };
      }
      data.name = name;
    }
  }
  if (formData.has("color")) data.color = fdStr(formData, "color");
  if (formData.has("notes")) data.notes = fdStr(formData, "notes");
  if (Object.keys(data).length === 0) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await tx.medicalSpecialty.update({ where: { id }, data });
    // LE LIBELLÉ DÉNORMALISÉ SUIT LE LIEN — comme l'établissement : visites, congrès et exports le
    // lisent tel quel. Seulement là où le lien VAUT (`lienDeSpecialiteValide`) : une fiche dont le
    // texte contredit son lien porte une saisie plus récente, et un renommage ne l'efface pas.
    if (data.name) {
      const ecritures = await tx.medicalDoctor.groupBy({ by: ["specialty"], where: { specialtyId: id } });
      const suivent = ecritures
        .map((e) => e.specialty)
        .filter((t): t is string => t !== null && lienDeSpecialiteValide(t, avant.name));
      await tx.medicalDoctor.updateMany({
        where: { specialtyId: id, OR: [{ specialty: null }, { specialty: { in: suivent } }] },
        data: { specialty: data.name },
      });
    }
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SPECIALTY", entityId: id,
    summary: data.name ? `Spécialité « ${avant.name} » renommée « ${data.name} »` : `Spécialité « ${avant.name} » modifiée`,
  });
  for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  revalidatePath("/medical");
  return { ok: true };
}

/**
 * RETIRER UNE SPÉCIALITÉ DU RÉFÉRENTIEL — sans rien retirer aux praticiens.
 *
 * Une fiche rattachée GARDE ce qui y était écrit : elle perd le lien, pas sa spécialité, et la
 * feuille la montre « à rattacher ». L'ancienne écriture effaçait le texte de chaque fiche :
 * supprimer une ligne de référentiel détruisait une donnée de praticien. Une fiche SANS texte
 * recopie le nom qu'elle affichait ; une fiche qui en porte un garde LE SIEN — même quand il
 * contredisait le lien, puisque c'était la saisie la plus récente (`lienDeSpecialiteValide`).
 * Pour réunir deux doublons, le bon geste est la FUSION, qui déplace les fiches.
 */
export async function deleteSpecialty(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererSpecialites(user, "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const avant = await prisma.medicalSpecialty.findUnique({ where: { id }, select: { name: true } });
  if (!avant) return { ok: false, error: "Cette spécialité n'existe plus — rechargez l'écran." };
  // UNE SPÉCIALITÉ VISÉE PAR UNE BU NE SE RETIRE PAS (§118.183) : la retirer changerait, en silence, ce
  // que la BU concerne. Le refus nomme les BU et les deux gestes qui le lèvent — la fusion, elle, fait
  // suivre les BU. La base refuse aussi (`onDelete: Restrict`), si un autre chemin essayait.
  const visees = await prisma.businessUnitSpecialty.findMany({
    where: { specialtyId: id }, select: { businessUnit: { select: { name: true } } }, orderBy: { businessUnit: { name: "asc" } },
  });
  if (visees.length) {
    const noms = visees.map((v) => `« ${v.businessUnit.name} »`).join(", ");
    return {
      ok: false,
      error: `« ${avant.name} » est visée par ${visees.length} Business Unit(s) (${noms}) : retirez-la de ces BU (Business Units), ou fusionnez-la dans une autre spécialité — la fusion fait suivre les BU.`,
    };
  }
  const detaches = await prisma.$transaction(async (tx) => {
    await tx.medicalDoctor.updateMany({ where: { specialtyId: id, specialty: null }, data: { specialty: avant.name } });
    const { count } = await tx.medicalDoctor.updateMany({ where: { specialtyId: id }, data: { specialtyId: null } });
    // Aucune BU ne la vise (refus plus haut), donc aucun de ses produits non plus — un lien orphelin partirait quand même.
    await tx.promoProductSpecialite.deleteMany({ where: { specialtyId: id } });
    await tx.medicalSpecialty.delete({ where: { id } });
    return count;
  });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Annuaires", entityType: "SPECIALTY", entityId: id,
    summary: `Spécialité « ${avant.name} » retirée du référentiel${detaches ? ` — ${detaches} fiche(s) gardent leur spécialité écrite, à rattacher` : ""}`,
  });
  for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  revalidatePath("/medical");
  return { ok: true, message: detaches ? `${detaches} fiche(s) gardent leur spécialité écrite, sans lien — à rattacher.` : undefined };
}

/**
 * FUSIONNER UNE SPÉCIALITÉ DANS UNE AUTRE — le geste qui réunit deux doublons du référentiel.
 *
 * Les fiches de la première passent à la seconde (lien ET libellé), puis la première disparaît.
 * Tout ou rien, dans une transaction : une fusion à moitié laisserait des fiches pointer vers une
 * spécialité qui n'existe plus. C'est un geste de STRUCTURE — il change la spécialité de fiches
 * que la personne ne voit peut-être pas — : il demande le droit de supprimer du référentiel.
 *
 * Ne passent que les fiches dont le lien VAUT (`lienDeSpecialiteValide`). Une fiche dont le texte
 * contredisait le lien garde son texte et perd ce lien périmé : la rattacher à la cible ferait
 * poser un SECOND lien que son texte contredit, sur la décision de quelqu'un qui ne l'a pas vue.
 */
export async function fusionnerSpecialite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererSpecialites(user, "DELETE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const cibleId = fdStr(formData, "cibleId");
  if (!id || !cibleId) return { ok: false, error: "Choisissez la spécialité dans laquelle fusionner." };
  if (id === cibleId) return { ok: false, error: "Une spécialité ne se fusionne pas dans elle-même." };
  const [source, cible] = await Promise.all([
    prisma.medicalSpecialty.findUnique({ where: { id }, select: { name: true } }),
    prisma.medicalSpecialty.findUnique({ where: { id: cibleId }, select: { name: true } }),
  ]);
  if (!source || !cible) return { ok: false, error: "L'une des deux spécialités n'existe plus — rechargez l'écran." };
  const { deplaces, detaches, bus } = await prisma.$transaction(async (tx) => {
    const ecritures = await tx.medicalDoctor.groupBy({ by: ["specialty"], where: { specialtyId: id } });
    const suivent = ecritures
      .map((e) => e.specialty)
      .filter((t): t is string => t !== null && lienDeSpecialiteValide(t, source.name));
    const passe = await tx.medicalDoctor.updateMany({
      where: { specialtyId: id, OR: [{ specialty: null }, { specialty: { in: suivent } }] },
      data: { specialtyId: cibleId, specialty: cible.name },
    });
    const reste = await tx.medicalDoctor.updateMany({ where: { specialtyId: id }, data: { specialtyId: null } });
    // LES BU SUIVENT (§118.183) : une BU qui visait la source vise la cible — sans doublon quand elle la
    // visait déjà, et la principale TIENT : si la source était sa principale, la cible le devient. Le
    // lien de la source part AVANT que la cible ne devienne principale, sinon l'index partiel (« une
    // principale par BU ») refuserait la fusion.
    const liens = await tx.businessUnitSpecialty.findMany({ where: { specialtyId: id }, select: { id: true, businessUnitId: true, principale: true } });
    for (const l of liens) {
      const deja = await tx.businessUnitSpecialty.findUnique({
        where: { businessUnitId_specialtyId: { businessUnitId: l.businessUnitId, specialtyId: cibleId } }, select: { id: true },
      });
      if (deja) {
        await tx.businessUnitSpecialty.delete({ where: { id: l.id } });
        if (l.principale) await tx.businessUnitSpecialty.update({ where: { id: deja.id }, data: { principale: true } });
      } else {
        await tx.businessUnitSpecialty.update({ where: { id: l.id }, data: { specialtyId: cibleId } });
      }
    }
    // LES PRODUITS SUIVENT AUSSI : un produit qui visait la source vise la cible, sans doublon.
    const ciblesProduits = await tx.promoProductSpecialite.findMany({ where: { specialtyId: id }, select: { id: true, promoProductId: true } });
    for (const c of ciblesProduits) {
      const deja = await tx.promoProductSpecialite.findUnique({ where: { promoProductId_specialtyId: { promoProductId: c.promoProductId, specialtyId: cibleId } }, select: { id: true } });
      if (deja) await tx.promoProductSpecialite.delete({ where: { id: c.id } });
      else await tx.promoProductSpecialite.update({ where: { id: c.id }, data: { specialtyId: cibleId } });
    }
    await tx.medicalSpecialty.delete({ where: { id } });
    return { deplaces: passe.count, detaches: reste.count, bus: liens.length };
  });
  const garde = `${detaches ? ` ; ${detaches} fiche(s) dont le texte contredisait le lien le gardent, sans lien — à rattacher` : ""}${bus ? ` ; ${bus} Business Unit(s) visent désormais « ${cible.name} »` : ""}`;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SPECIALTY", entityId: cibleId,
    summary: `Spécialité « ${source.name} » fusionnée dans « ${cible.name} » — ${deplaces} fiche(s) déplacée(s)${garde}`,
  });
  for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  revalidatePath("/medical");
  return { ok: true, message: `« ${source.name} » fusionnée dans « ${cible.name} » : ${deplaces} fiche(s) déplacée(s)${garde}.` };
}

/**
 * RATTACHER UN LIBELLÉ HÉRITÉ À UNE SPÉCIALITÉ DU RÉFÉRENTIEL — un geste, toutes ses fiches.
 *
 * « Cardio » écrit sur douze fiches ne désigne pas « Cardiologie » à coup sûr : c'est une personne
 * qui décide qu'il la désigne, et ce geste applique sa décision à toutes les fiches qui portent ce
 * libellé (à l'écriture près) — sans lien, ou avec un lien que ce texte contredit. On ne touche QUE
 * les fiches que la personne voit et modifie (`scopeMedicalDoctors`, la portée de la fiche) : un
 * délégué ne relabellise pas le panel d'un collègue.
 *
 * Une seule écriture, dont les conditions se relisent AU MOMENT d'écrire : une fiche rattachée entre
 * l'affichage et ce clic porte désormais le nom de sa spécialité, donc n'a plus ce libellé, et garde
 * le choix qu'on y a fait. On lit les ÉCRITURES distinctes de la portée, pas ses fiches : il y en a
 * des dizaines, pas des milliers.
 */
export async function rattacherLibelleSpecialite(formData: FormData): Promise<ActionResult & { rattachees?: number }> {
  const user = await requireUser();
  if (!peutGererSpecialites(user, "UPDATE")) return { ok: false, error: "Non autorisé." };
  const libelle = fdStr(formData, "libelle");
  const specialtyId = fdStr(formData, "specialtyId");
  if (!libelle || !specialtyId) return { ok: false, error: "Choisissez la spécialité du référentiel à laquelle rattacher ce libellé." };
  const cible = await prisma.medicalSpecialty.findUnique({ where: { id: specialtyId }, select: { id: true, name: true } });
  if (!cible) return { ok: false, error: "Cette spécialité n'existe plus — rechargez l'écran." };
  const cle = cleDeSpecialite(libelle);
  const scope = scopeMedicalDoctors(user);
  const [ecritures, referentiel] = await Promise.all([
    prisma.medicalDoctor.groupBy({ by: ["specialty"], where: { AND: [scope, { specialty: { not: null } }] } }),
    prisma.medicalSpecialty.findMany({ select: { id: true, name: true } }),
  ]);
  const textes = ecritures.map((e) => e.specialty).filter((t): t is string => t !== null && cleDeSpecialite(t) === cle);
  // Une fiche liée à une spécialité qui S'ÉCRIT comme ce libellé l'est déjà à bon droit — son lien
  // vaut — et ce geste ne la déplace pas.
  const memeEcriture = referentiel.filter((s) => cleDeSpecialite(s.name) === cle).map((s) => s.id);
  const { count } = textes.length === 0 ? { count: 0 } : await prisma.medicalDoctor.updateMany({
    where: {
      AND: [scope, { specialty: { in: textes } }, { OR: [{ specialtyId: null }, { specialtyId: { notIn: memeEcriture } }] }],
    },
    data: { specialtyId: cible.id, specialty: cible.name, updatedById: user.id },
  });
  if (count === 0) return { ok: true, rattachees: 0, message: `Aucune fiche ne porte encore « ${libelle} » sans lien dans ce que vous voyez de l'annuaire.` };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Annuaires", entityType: "SPECIALTY", entityId: cible.id,
    summary: `Libellé « ${libelle} » rattaché à « ${cible.name} » — ${count} fiche(s)`,
  });
  for (const chemin of CHEMINS_SPECIALITES) revalidatePath(chemin);
  revalidatePath("/medical/annuaire");
  revalidatePath("/annuaires");
  return { ok: true, rattachees: count, message: `${count} fiche(s) « ${libelle} » rattachée(s) à « ${cible.name} ».` };
}

// ─────────────────────────── Médecins ───────────────────────────

/** Supprime un médecin de l'annuaire (MEDICAL:DELETE). Ses visites sont supprimées
 *  en cascade ; il est retiré des listes d'invités de congrès (IDs orphelins ignorés). */
export async function deleteDoctor(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "DELETE")) return { ok: false, error: "Suppression réservée (droit Supprimer sur l'Annuaire)." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const doc = await prisma.medicalDoctor.findUnique({ where: { id }, select: { name: true } });
  if (!doc) return { ok: false, error: "Médecin introuvable." };
  await prisma.medicalVisit.deleteMany({ where: { doctorId: id } });
  await prisma.medicalDoctor.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Promotion médicale", entityType: "DOCTOR", entityId: id, summary: `Médecin supprimé — ${doc.name}` });
  revalidatePath("/medical");
  return { ok: true };
}

/** Supprime une visite (MEDICAL:DELETE, ou le délégué auteur de la visite). */
export async function deleteVisit(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const visit = await prisma.medicalVisit.findUnique({
    where: { id },
    select: { delegateId: true, status: true, date: true, tourPlanId: true, doctor: { select: { name: true } } },
  });
  if (!visit) return { ok: false, error: "Visite introuvable." };
  if (!userCan(user, "MEDICAL", "DELETE") && visit.delegateId !== user.id) return { ok: false, error: "Non autorisé." };
  // CE QUI A EU LIEU NE S'EFFACE PAS (§118.193). Une visite rapportée porte un compte rendu et, souvent, du matériel
  // remis : la supprimer effaçait un fait et laissait des remises sans visite. Et une visite d'un plan soumis ou
  // validé ne sort pas du plan par cette porte — le plan se révise ; d'un plan déjà validé, une visite passée ne
  // sort pas du tout (`retraitInterditApresRevision`, la même règle que la grille).
  if (visit.status === "COMPLETED") {
    return { ok: false, error: "Une visite rapportée ne se supprime pas : son compte rendu et le matériel remis restent au registre." };
  }
  if (visit.tourPlanId) {
    const plan = await prisma.tourPlan.findUnique({ where: { id: visit.tourPlanId }, select: { status: true, revisionCount: true } });
    if (plan && !gestesPossibles(plan.status as StatutPlan).modifiable) {
      return { ok: false, error: "Cette visite appartient à un plan de tournée soumis ou validé : elle sort du plan par le plan — « Demander une révision » s'il est validé." };
    }
    if (plan && retraitInterditApresRevision(visit, plan.revisionCount > 0, new Date())) {
      return { ok: false, error: "Cette visite passée appartient à un plan déjà validé : elle reste au plan — rapportée, ou dite reportée ou annulée depuis « Ma journée » dans ses 48 h." };
    }
  }
  // Tout ou rien : un rapport saisi entre la lecture et la suppression l'emporte.
  const retiree = await prisma.medicalVisit.deleteMany({ where: { id, status: visit.status } });
  if (retiree.count === 0) return { ok: false, error: "Cette visite vient de changer — rouvrez-la pour voir où elle en est." };
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Promotion médicale", entityType: "VISIT", entityId: id, summary: `Visite supprimée — ${visit.doctor?.name ?? ""}` });
  revalidatePath("/medical");
  return { ok: true };
}


export async function createDoctor(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Non autorisé." };
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom du médecin est obligatoire." };

  // A delegate owns the doctors they create; a manager may assign one.
  const delegateId = user.role === "MEDICAL_DELEGATE" ? user.id : fdStr(formData, "delegateId") ?? null;
  const sp = await specialiteDuFormulaire(formData);
  if (!sp.ok) return { ok: false, error: sp.error };
  const specialite = sp.ecriture ?? { specialtyId: null, specialty: null };
  const institutionId = fdStr(formData, "institutionId");
  const iName = await institutionName(institutionId);
  const wilaya = parseWilaya(fdStr(formData, "wilaya"));
  if (!wilaya.ok) return { ok: false, error: wilaya.error };

  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const created = await prisma.$transaction(async (tx) => {
    const d = await tx.medicalDoctor.create({
      data: {
        name,
        title: parseTitle(fdStr(formData, "title")),
        specialtyId: specialite.specialtyId,
        specialty: specialite.specialty,
        sector: parseSector(fdStr(formData, "sector")),
        institutionId,
        institution: iName ?? fdStr(formData, "institution"),
        wilaya: wilaya.value,
        region: fdStr(formData, "region"),
        phone: fdStr(formData, "phone"),
        email: fdStr(formData, "email"),
        influence: parseSegment(fdStr(formData, "influence")),
        potential: parseSegment(fdStr(formData, "potential")),
        affinity: parseSegment(fdStr(formData, "affinity")),
        // Champs hérités tenus cohérents avec l'échelle 5 niveaux.
        influenceLevel: segToInfluence[parseSegment(fdStr(formData, "influence"))],
        prescriptionPotential: segToPriority[parseSegment(fdStr(formData, "potential"))],
        targetProducts: fdStr(formData, "targetProducts"),
        comments: fdStr(formData, "comments"),
        delegateId,
        companyId: fdStr(formData, "companyId") || null,
        createdById: user.id,
      },
    });
    await relierALaPersonne(tx, "MedicalDoctor", d.id, user.id);
    return d;
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    entityType: "DOCTOR", entityId: created.id, summary: `Médecin « ${name} »`,
  });
  revalidatePath("/medical");
  return { ok: true, id: created.id };
}

export async function updateDoctor(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Médecin introuvable." };
  if (!(await canAccessEntity(user, "DOCTOR", id, "UPDATE"))) return { ok: false, error: "Non autorisé." };
  const before = await prisma.medicalDoctor.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Médecin introuvable." };

  const name = fdStr(formData, "name") ?? before.name;
  // LES LIENS NE S'EFFACENT QUE SI LE FORMULAIRE LES PORTE (§118.172). Un appelant qui ne connaît
  // pas ces champs — l'op d'Adam rejoue la fiche par ses LIBELLÉS, sans aucun identifiant — les
  // remettait à `null` à chaque modification : changer un téléphone détachait le praticien de son
  // établissement, de son service et de sa spécialité de référence, sans un mot.
  const sp = await specialiteDuFormulaire(formData);
  if (!sp.ok) return { ok: false, error: sp.error };
  const specialite = sp.ecriture ?? { specialtyId: before.specialtyId, specialty: before.specialty };
  let institutionId = formData.has("institutionId") ? fdStr(formData, "institutionId") : before.institutionId;
  // UN ÉTABLISSEMENT NOMMÉ SANS IDENTIFIANT (l'op d'Adam écrit « CHU Mustapha »). Garder le lien
  // d'avant en ignorant ce nom aurait annoncé « établissement modifié » sans rien modifier — le
  // faux succès. Le nom se résout par la règle unique (`rattachement.ts`) : un seul établissement
  // actif de ce nom → le lien ; sinon la fiche porte le texte, « à rattacher », comme un import.
  let institutionTexte: string | null | undefined;
  if (!formData.has("institutionId") && formData.has("institution")) {
    const texte = fdStr(formData, "institution");
    const actuel = before.institutionId ? await institutionName(before.institutionId) : before.institution;
    if (cleDEtablissement(texte ?? "") !== cleDEtablissement(actuel ?? "")) {
      // `=== null` et non `!texte` : la dérivation des contrats lit `if (!v)` comme « champ
      // OBLIGATOIRE » (§118.138), et l'établissement d'une fiche ne l'est pas — il s'efface.
      if (texte === null) { institutionId = null; institutionTexte = null; }
      else {
        const etabs = await prisma.medicalInstitution.findMany({ select: { id: true, name: true, isActive: true, wilaya: true } });
        const r = indexerEtablissements(etabs)(texte);
        if (r.statut === "trouve") institutionId = r.etablissement.id;
        else { institutionId = null; institutionTexte = texte; }
      }
    }
  }
  const iName = await institutionName(institutionId);
  // UN SERVICE N'EXISTE QUE DANS SON ÉTABLISSEMENT : changer d'établissement le retire.
  const serviceId = institutionId === before.institutionId ? before.serviceId : null;
  // Un manager (vue globale) peut réassigner le délégué ; un délégué reste propriétaire.
  const isManager = user.role !== "MEDICAL_DELEGATE";
  // La wilaya ne s'efface que si le formulaire la PORTE vide : un appelant qui ne connaît pas
  // ce champ (une op écrite avant lui) ne doit pas effacer ce que la feuille a saisi.
  const wilaya = formData.has("wilaya") ? parseWilaya(fdStr(formData, "wilaya")) : { ok: true as const, value: before.wilaya };
  if (!wilaya.ok) return { ok: false, error: wilaya.error };

  await prisma.medicalDoctor.update({
    where: { id },
    data: {
      name,
      title: parseTitle(fdStr(formData, "title")),
      specialtyId: specialite.specialtyId,
      specialty: specialite.specialty,
      sector: parseSector(fdStr(formData, "sector")),
      institutionId,
      serviceId,
      institution: iName ?? (institutionTexte !== undefined ? institutionTexte : institutionId ? before.institution : fdStr(formData, "institution") ?? before.institution),
      wilaya: wilaya.value,
      region: fdStr(formData, "region"),
      phone: fdStr(formData, "phone"),
      email: fdStr(formData, "email"),
      influence: parseSegment(fdStr(formData, "influence") ?? before.influence),
      potential: parseSegment(fdStr(formData, "potential") ?? before.potential),
      affinity: parseSegment(fdStr(formData, "affinity") ?? before.affinity),
      influenceLevel: segToInfluence[parseSegment(fdStr(formData, "influence") ?? before.influence)],
      prescriptionPotential: segToPriority[parseSegment(fdStr(formData, "potential") ?? before.potential)],
      targetProducts: fdStr(formData, "targetProducts"),
      comments: fdStr(formData, "comments"),
      companyId: fdStr(formData, "companyId") || null,
      ...(isManager ? { delegateId: fdStr(formData, "delegateId") } : {}),
      updatedById: user.id,
    },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Promotion médicale",
    entityType: "DOCTOR", entityId: id, summary: `Médecin « ${name} » mis à jour`,
  });
  revalidatePath("/medical");
  return { ok: true };
}

/**
 * SAISIR UNE VISITE FAITE — le geste du terrain, en trois champs.
 *
 * ── POURQUOI UNE ACTION À PART DE `createVisit` ─────────────────────────────────────────────
 *
 * `createVisit` sert à PLANIFIER depuis un bureau : elle accepte un délégué, un statut, une
 * région. Ici on enregistre ce qui VIENT D'AVOIR LIEU, depuis un téléphone, entre deux
 * rendez-vous. Les deux gestes n'ont ni les mêmes champs obligatoires, ni le même auteur, ni le
 * même risque : mélanger les deux dans une action « polyvalente » aurait imposé au terrain de
 * choisir un statut, c'est-à-dire un champ de plus à comprendre pour un homme qui saisit debout.
 *
 * ── CE QUI EST TENU ICI ─────────────────────────────────────────────────────────────────────
 *
 *  1. **La visite est TERMINÉE par construction** — on ne saisit pas une visite qu'on n'a pas
 *     faite. C'est ce qui rend le cockpit juste sans demander un statut à personne.
 *  2. **Le délégué est CELUI QUI SAISIT.** Jamais un champ du formulaire : laisser choisir
 *     l'auteur ferait entrer les visites d'un autre dans son propre compteur.
 *  3. **Le praticien doit appartenir à SON panel.** Un identifiant forgé enregistrerait une
 *     visite chez le praticien d'un collègue — et fausserait deux tableaux à la fois.
 *  4. **Les produits présentés sont des LIENS** (`MedicalVisitProduct`), pas une chaîne de
 *     texte : c'est ce qui permet de croiser l'effort et les ventes par produit. Le texte
 *     `presentedProducts` reste renseigné pour les écrans hérités qui le lisent encore.
 *  5. **La date peut être ANTÉRIEURE** (saisie le soir, ou le lendemain), jamais future : on
 *     n'enregistre pas une visite qui n'a pas eu lieu. Et jamais au-delà de la fenêtre de 48 h —
 *     la même que la visite imprévue et le rapport d'une visite planifiée : sans elle, cette
 *     porte était le moyen de contourner le verrou en datant une visite d'il y a trois semaines
 *     (§118.71). « Le soir, ou le lendemain », c'est-à-dire dans la fenêtre.
 *  6. **Les produits sont ceux de SA Business Unit** — la règle des deux autres portes, lue au
 *     même endroit (`sfe/produits-bu.ts`).
 */
export async function logVisit(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Non autorisé." };

  const doctorId = fdStr(formData, "doctorId");
  if (!doctorId) return { ok: false, error: "Choisissez le praticien visité." };

  // Règle 3 : le praticien doit être dans le panel de celui qui saisit. La seule exception est
  // le compte à vue globale, qui peut saisir pour rattraper une absence.
  const doctor = await prisma.medicalDoctor.findUnique({
    where: { id: doctorId },
    select: { id: true, name: true, delegateId: true },
  });
  if (!doctor) return { ok: false, error: "Praticien introuvable." };
  if (doctor.delegateId !== user.id && !(await canAccessEntity(user, "DOCTOR", doctorId, "UPDATE"))) {
    return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  }

  // Règle 5 : jamais dans le futur — une visite « faite » demain n'existe pas — et jamais hors de
  // la fenêtre de 48 h.
  const now = new Date();
  const saisie = fdDate(formData, "date");
  const date = saisie && saisie <= now ? saisie : now;
  if (!fenetreRapport(date, now).ouvert) return { ok: false, error: refusVisiteHorsDelai(date) };

  // Règles 4 et 6 : les produits arrivent en identifiants, et ce sont ceux de SA gamme.
  const productIds = [...new Set(formData.getAll("productId").map(String).filter(Boolean))];
  if (productIds.length > 0) {
    const gamme = await produitsDeLaBu(user.id);
    const horsBu = productIds.filter((id) => !gamme.admis.has(id));
    if (horsBu.length > 0) return { ok: false, error: refusProduitsHorsBu(horsBu.length, gamme, "vous") };
  }
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, canonicalName: true } })
    : [];

  // Règle 6 (§118.166) : LE MATÉRIEL REMIS sort du stock de celui qui saisit, dans la MÊME
  // transaction que la visite — au-delà de son stock, rien n'est enregistré. C'est le même écrivain
  // que le rapport d'une visite planifiée : un stock juste ou faux selon le bouton pris serait pire
  // qu'un bouton de moins.
  const deja = await dejaDansLaVisite(null);
  const lu = await lireMaterielRemis(formData, deja, now);
  if (!lu.ok) return { ok: false, error: lu.error };

  let created: { id: string };
  try {
    created = await sousVerrous(verrousDuRapport(lu.materiel, deja), async (tx, verrouilles) => {
      const v = await tx.medicalVisit.create({
        data: {
          date,
          doctorId,
          // Règle 2 : l'auteur de la saisie, jamais un champ du formulaire.
          delegateId: user.id,
          // Règle 1 : ce qu'on saisit a eu lieu.
          status: "COMPLETED",
          report: fdStr(formData, "report"),
          followUpActions: fdStr(formData, "followUpActions"),
          // Le texte hérité reste renseigné pour les écrans qui le lisent encore ; la VÉRITÉ
          // exploitable, elle, est dans les liens.
          presentedProducts: products.map((p) => p.canonicalName).join(", ") || null,
          createdById: user.id,
          updatedById: user.id,
          productLinks: products.length
            ? { create: products.map((p) => ({ productId: p.id })) }
            : undefined,
        },
        select: { id: true },
      });
      // La fiche du praticien porte sa dernière visite : sans cette mise à jour, la tournée du
      // lendemain le reproposerait en tête, et l'écran perdrait la confiance du terrain.
      await tx.medicalDoctor.update({ where: { id: doctorId }, data: { lastVisit: date } });
      await ecrireRemises(tx, lu.materiel, verrouilles, {
        ancre: { visitId: v.id }, doctorId, detenteurId: user.id, auteurId: user.id, maintenant: now, motif: motifDeRemise(date, doctor.name),
      });
      return v;
    });
  } catch (e) {
    if (e instanceof RefusRemise) return { ok: false, error: e.message };
    throw e;
  }

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: created.id,
    summary: `Visite saisie — ${doctor.name}${products.length ? ` (${products.length} produit${products.length > 1 ? "s" : ""})` : ""}${phraseMateriel(lu.materiel)}`,
  });
  revalidatePath("/medical/ma-journee");
  revalidatePath("/medical");
  revalidatePath("/planning");
  if (toucheLeStock(lu.materiel, deja)) revalidatePath(CHEMIN_STOCK_PROMO);
  return { ok: true, id: created.id };
}

/**
 * UNE VISITE FAITE NE NAÎT ET NE SE RÉÉCRIT QUE PAR SES PORTES (§118.71).
 *
 * `createVisit` et `updateVisit` PLANIFIENT (depuis un bureau, ou par l'opération d'Adam qui les
 * appelle). Les laisser poser le statut « réalisée » faisait d'elles une quatrième et une cinquième
 * porte vers une visite faite — sans la fenêtre de 48 h, sans les produits de la gamme, sans le
 * matériel remis, sans les messages pré-définis. Le refus nomme les portes qui, elles, tiennent ces
 * règles (§118.30).
 */
const REFUS_VISITE_FAITE_HORS_PORTE =
  "Une visite faite s'enregistre depuis « Ma journée » (ou par le rapport de la visite planifiée, dans le plan de tournée) : "
  + "c'est là que s'appliquent la fenêtre de 48 h, les produits de la gamme et le matériel remis. Ici, on planifie.";

export async function createVisit(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Non autorisé." };

  const doctorId = fdStr(formData, "doctorId");
  const delegateId = user.role === "MEDICAL_DELEGATE" ? user.id : fdStr(formData, "delegateId") ?? user.id;
  const statut = (fdStr(formData, "status") as VisitStatus) ?? "PLANNED";
  if (statut === "COMPLETED") return { ok: false, error: REFUS_VISITE_FAITE_HORS_PORTE };

  const created = await prisma.medicalVisit.create({
    data: {
      date: fdDate(formData, "date") ?? new Date(),
      doctorId,
      delegateId,
      region: fdStr(formData, "region"),
      objective: fdStr(formData, "objective"),
      presentedProducts: fdStr(formData, "presentedProducts"),
      status: statut,
      createdById: user.id,
    },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: created.id, summary: `Visite planifiée`,
  });
  revalidatePath("/medical");
  return { ok: true, id: created.id };
}

/**
 * Modifie une visite (ligne). Édite les champs de la LIGNE (date, médecin, délégué, région,
 * objectif, produits) ET/OU le COMPTE RENDU (statut, report, retour médecin, actions de suivi).
 * Chaque champ n'est mis à jour QUE s'il est présent dans le formulaire : le flux « compte rendu »
 * et le flux « édition de ligne » cohabitent sans s'écraser mutuellement.
 */
export async function updateVisit(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Visite introuvable." };
  if (!(await canAccessEntity(user, "VISIT", id, "UPDATE"))) return { ok: false, error: "Non autorisé." };

  const before = await prisma.medicalVisit.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Visite introuvable." };
  const status = (fdStr(formData, "status") as VisitStatus) ?? before.status;
  // Une visite RAPPORTÉE se corrige par son rapport, dans les 48 h — jamais ici, où rien ne
  // tiendrait la fenêtre ni la gamme. Et une visite planifiée ne devient pas « faite » ici non plus.
  if (before.status === "COMPLETED") {
    return { ok: false, error: "Cette visite est déjà rapportée : elle se corrige depuis son rapport, dans les 48 h (« Ma journée » ou le plan de tournée)." };
  }
  if (status === "COMPLETED") return { ok: false, error: REFUS_VISITE_FAITE_HORS_PORTE };
  // UNE VISITE SE DIT NON TENUE PAR SA PORTE (§118.193 — audit 360°, M5 du KAM) : `direVisiteNonTenue` tient le
  // motif et la fenêtre de 48 h. Ici, rien ne les tenait — dire « annulée » une semaine après effaçait une visite
  // perdue du taux, sans un mot. Deux portes pour le même fait, et c'est la plus lâche qui gagne (§118.71).
  if ((status === "POSTPONED" || status === "CANCELLED") && status !== before.status) {
    return {
      ok: false,
      error: "Une visite se dit reportée ou annulée depuis « Ma journée » : c'est là que s'appliquent le motif et la fenêtre de 48 h.",
    };
  }
  const has = (k: string) => formData.has(k);
  // UNE VISITE D'UN PLAN QUI NE SE MODIFIE PLUS ne change ni de jour, ni de praticien, ni de KAM ici : le validateur
  // a validé CETTE tournée. Le plan se révise (« Demander une révision », §118.193) — sinon cette porte réécrivait
  // un plan validé dans son dos.
  if (before.tourPlanId && (has("date") || has("doctorId") || has("delegateId"))) {
    const plan = await prisma.tourPlan.findUnique({ where: { id: before.tourPlanId }, select: { status: true } });
    if (plan && !gestesPossibles(plan.status as StatutPlan).modifiable) {
      return {
        ok: false,
        error: "Cette visite appartient à un plan de tournée soumis ou validé : son jour et son praticien changent par le plan — « Demander une révision » s'il est validé.",
      };
    }
  }
  const doctorId = fdStr(formData, "doctorId");
  const delegateId = fdStr(formData, "delegateId");

  // UN GESTE À LA FOIS (§118.193) : cette écriture réécrit le statut LU — un rapport saisi entre la lecture et
  // l'écriture (un autre onglet, « Ma journée ») était ramené à « planifiée », et la visite faite redevenait à
  // faire, sans un mot. La condition sur le statut lu l'arrête : le rapport l'emporte.
  const changee = await prisma.$transaction(async (tx) => {
    const encore = await tx.medicalVisit.updateMany({ where: { id, status: before.status }, data: { updatedById: user.id } });
    if (encore.count === 0) return true;
    await tx.medicalVisit.update({
      where: { id },
      data: {
        status,
        updatedById: user.id,
        // Champs de la ligne (édition complète) — seulement si soumis.
        ...(has("date") ? { date: fdDate(formData, "date") ?? before.date } : {}),
        ...(has("region") ? { region: fdStr(formData, "region") } : {}),
        ...(has("objective") ? { objective: fdStr(formData, "objective") } : {}),
        ...(has("presentedProducts") ? { presentedProducts: fdStr(formData, "presentedProducts") } : {}),
        ...(has("doctorId") ? { doctor: doctorId ? { connect: { id: doctorId } } : { disconnect: true } } : {}),
        ...(has("delegateId") ? { delegate: delegateId ? { connect: { id: delegateId } } : { disconnect: true } } : {}),
        // Compte rendu — seulement si soumis.
        ...(has("report") ? { report: fdStr(formData, "report") } : {}),
        ...(has("doctorFeedback") ? { doctorFeedback: fdStr(formData, "doctorFeedback") } : {}),
        ...(has("followUpActions") ? { followUpActions: fdStr(formData, "followUpActions") } : {}),
      },
    });
    return false;
  });
  if (changee) return { ok: false, error: "Cette visite vient de changer — rouvrez-la pour voir où elle en est." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: id, summary: "Visite modifiée",
  });
  revalidatePath("/medical");
  return { ok: true };
}
